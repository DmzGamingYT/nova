/* ============================================================
   Nova — modèles locaux : Ollama & LM Studio

   Des faux serveurs compatibles OpenAI jouent le rôle d'Ollama
   (port 11434) et de LM Studio (1234) ; on vérifie que :
     • /api/models liste leurs modèles préfixés local-…/… et le
       sélecteur les voit même sans clé Groq ;
     • /api/chat route vers le bon serveur et relaie le SSE
       (session, profil, <think> filtré, ACTION masquée) ;
     • les erreurs deviennent des messages clairs.
   ============================================================ */

'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helpers');

/* Serveur compatible OpenAI : /v1/models + /v1/chat/completions en SSE.
   `replies` = texte envoyé delta par delta. */
function fakeOpenAiServer(opts) {
  const state = { requests: [], server: null };
  state.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push({ url: req.url, method: req.method, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: (opts.models || []).map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        if (opts.fail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'model offline' } }));
          return;
        }
        if (opts.crash) {
          /* Crash en pleine réponse (pas avant les en-têtes, qui donneraient
             une erreur de connexion propre côté relais) */
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Début…' } }] }) + '\n\n');
          setTimeout(() => res.destroy(), 10);
          return;
        }
        /* Écriture synchrone : NE PAS utiliser setInterval + req.on('close')
           ici — depuis Node 16, « close » de la requête part dès que le corps
           est consommé, ce qui annulerait le timer avant toute réponse. */
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = (opts.reply || 'Bonjour !').match(/\S+\s*/g) || [];
        for (const c of chunks) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return {
    requests: state.requests,
    listen() {
      return new Promise((resolve) => {
        state.server.listen(0, '127.0.0.1', () => resolve(state.server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => state.server.close(resolve));
    },
  };
}

async function readSse(res) {
  const text = await res.text();
  const out = { content: '', meta: [] };
  for (const line of text.split('\n')) {
    const d = line.trim();
    if (!d.startsWith('data:')) continue;
    const p = d.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      if (j.choices && j.choices[0] && j.choices[0].delta && typeof j.choices[0].delta.content === 'string') {
        out.content += j.choices[0].delta.content;
      } else {
        out.meta.push(j);
      }
    } catch (_) {}
  }
  return out;
}

test('les modèles locaux apparaissent dans /api/models même sans clé Groq', async () => {
  const ollama = fakeOpenAiServer({ models: ['llama3.2:3b', 'mistral:7b'] });
  const lm = fakeOpenAiServer({ models: ['qwen2.5-7b-instruct'] });
  const oPort = await ollama.listen();
  const lPort = await lm.listen();

  const srv = await startServer({
    env: {
      NOVA_OLLAMA_URL: 'http://127.0.0.1:' + oPort,
      NOVA_LMSTUDIO_URL: 'http://127.0.0.1:' + lPort,
    },
  });
  try {
    const { status, body } = await srv.json('/api/models');
    assert.strictEqual(status, 200);
    const ids = body.models.map((m) => m.id);
    assert.ok(ids.includes('local-ollama/llama3.2:3b'), ids.join(', '));
    assert.ok(ids.includes('local-ollama/mistral:7b'));
    assert.ok(ids.includes('local-lmstudio/qwen2.5-7b-instruct'));
    const owned = body.models.find((m) => m.id === 'local-ollama/llama3.2:3b');
    assert.strictEqual(owned.owned_by, 'Ollama');
    assert.strictEqual(owned.label, 'llama3.2:3b');
  } finally {
    await srv.stop();
    await ollama.close();
    await lm.close();
  }
});

test('les serveurs locaux absents n’ajoutent rien et ne cassent pas /api/models', async () => {
  const srv = await startServer({});
  try {
    const { status, body } = await srv.json('/api/models');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.models) && body.models.length >= 2);
    for (const m of body.models) assert.ok(!String(m.id).startsWith('local-'));
  } finally {
    await srv.stop();
  }
});

test('un chat sur un modèle Ollama est routé vers Ollama et relégué en SSE', async () => {
  const ollama = fakeOpenAiServer({ models: ['llama3.2:3b'], reply: 'Je réponds depuis ton <think>secret</think>Ollama !' });
  const port = await ollama.listen();
  const srv = await startServer({ env: { NOVA_OLLAMA_URL: 'http://127.0.0.1:' + port } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-local-1', model: 'local-ollama/llama3.2:3b', messages: [{ role: 'user', content: 'salut' }] }),
    });
    assert.strictEqual(r.status, 200);
    const sse = await readSse(r);

    // Le bon serveur, le bon modèle nu, le bon message système
    assert.strictEqual(ollama.requests.length, 1);
    const sent = JSON.parse(ollama.requests[0].body);
    assert.strictEqual(ollama.requests[0].url, '/v1/chat/completions');
    assert.strictEqual(sent.model, 'llama3.2:3b');
    assert.ok(sent.messages[0].role === 'system' && sent.messages[0].content.includes('Nova'));
    assert.strictEqual(sent.stream, true);

    // SSE correctement reluqué, bloc <think> filtré, session + profil émis
    assert.ok(sse.content.includes('Ollama !'), sse.content);
    assert.ok(!sse.content.includes('secret'));
    /* Le serveur génère son propre id de session (il ne fait pas d'écho) */
    const sess = sse.meta.find((m) => m.nova_session);
    assert.ok(sess && typeof sess.nova_session === 'string' && sess.nova_session.length > 0);
    assert.ok(sse.meta.some((m) => m.nova_profile));
  } finally {
    await srv.stop();
    await ollama.close();
  }
});

test('un chat LM Studio est routé vers LM Studio', async () => {
  const lm = fakeOpenAiServer({ models: ['qwen2.5-7b-instruct'], reply: 'Réponse LM Studio.' });
  const port = await lm.listen();
  const srv = await startServer({ env: { NOVA_LMSTUDIO_URL: 'http://127.0.0.1:' + port } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-lm-1', model: 'local-lmstudio/qwen2.5-7b-instruct', messages: [{ role: 'user', content: 'bonjour' }] }),
    });
    assert.strictEqual(r.status, 200);
    const sse = await readSse(r);
    assert.strictEqual(lm.requests.length, 1);
    assert.strictEqual(JSON.parse(lm.requests[0].body).model, 'qwen2.5-7b-instruct');
    assert.ok(sse.content.includes('LM Studio.'));
  } finally {
    await srv.stop();
    await lm.close();
  }
});

test('serveur local arrêté en pleine réponse : le flux se termine proprement', async () => {
  const ollama = fakeOpenAiServer({ models: ['llama3.2:3b'], crash: true });
  const port = await ollama.listen();
  const srv = await startServer({ env: { NOVA_OLLAMA_URL: 'http://127.0.0.1:' + port } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-crash', model: 'local-ollama/llama3.2:3b', messages: [{ role: 'user', content: 'salut' }] }),
    });
    // La réponse démarre (200), puis le flux se termine sans suspendre :
    // le relais émet une erreur lisible au lieu de laisser le client attendre.
    assert.strictEqual(r.status, 200);
    const text = await r.text();
    assert.ok(/"error"/.test(text), 'erreur attendue dans le flux : ' + text.slice(0, 200));
  } finally {
    await srv.stop();
    await ollama.close();
  }
});

test('modèle local en erreur → message clair mentionnant le fournisseur', async () => {
  const ollama = fakeOpenAiServer({ models: ['llama3.2:3b'], fail: true });
  const port = await ollama.listen();
  const srv = await startServer({ env: { NOVA_OLLAMA_URL: 'http://127.0.0.1:' + port } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-fail', model: 'local-ollama/llama3.2:3b', messages: [{ role: 'user', content: 'salut' }] }),
    });
    assert.strictEqual(r.status, 502);
    const j = await r.json();
    assert.ok(/Ollama/.test(j.error), j.error);
    assert.ok(/model offline/.test(j.error));
  } finally {
    await srv.stop();
    await ollama.close();
  }
});

test('Ollama injoignable (rien sur ce port) → message qui explique quoi faire', async () => {
  const srv = await startServer({ env: { NOVA_OLLAMA_URL: 'http://127.0.0.1:1' } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-none', model: 'local-ollama/llama3.2:3b', messages: [{ role: 'user', content: 'salut' }] }),
    });
    assert.strictEqual(r.status, 502);
    const j = await r.json();
    assert.ok(/ollama serve/i.test(j.error), j.error);
  } finally {
    await srv.stop();
  }
});

test('le tour de conversation avec un modèle local est archivé en mémoire', async () => {
  const ollama = fakeOpenAiServer({ models: ['llama3.2:3b'], reply: 'Mémorisé !' });
  const port = await ollama.listen();
  const srv = await startServer({ env: { NOVA_OLLAMA_URL: 'http://127.0.0.1:' + port } });
  try {
    const r = await srv.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-mem', model: 'local-ollama/llama3.2:3b', messages: [{ role: 'user', content: 'retiens ceci' }] }),
    });
    // Récupère l'id de session réellement créé par le serveur
    const sse = await readSse(r);
    const sid = (sse.meta.find((m) => m.nova_session) || {}).nova_session;
    assert.ok(sid, 'id de session absent du flux');
    const { body } = await srv.json('/api/memory');
    const meta = (body.sessions || []).find((x) => x.id === sid);
    assert.ok(meta, 'session absente du résumé mémoire');
    assert.ok(meta.turns >= 1, 'aucun tour archivé');
    const sess = await (await srv.fetch('/api/memory/' + sid)).json();
    const last = sess.turns[sess.turns.length - 1];
    assert.strictEqual(last.user, 'retiens ceci');
    assert.strictEqual(last.assistant, 'Mémorisé !');
  } finally {
    await srv.stop();
    await ollama.close();
  }
});
