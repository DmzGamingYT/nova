/* ============================================================
   Nova — application : conversation, streaming Groq, voix.
   Aucune dépendance. La clé peut venir du serveur (.env) ou
   être enregistrée ici (localStorage, jamais envoyée ailleurs
   qu'à notre serveur local qui la transmet à Groq).
   ============================================================ */

(function () {
  'use strict';

  /* -------------------------------------------------------- */
  /* Raccourcis DOM & état global                              */
  /* -------------------------------------------------------- */

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    chat: $('chat'),
    chatInner: $('chat-inner'),
    messages: $('messages'),
    hero: $('hero'),
    input: $('input'),
    send: $('btn-send'),
    mic: $('btn-mic'),
    tts: $('btn-tts'),
    clear: $('btn-clear'),
    settings: $('btn-settings'),
    closeSettings: $('btn-close-settings'),
    backdrop: $('settings-backdrop'),
    keyInput: $('key-input'),
    saveKey: $('btn-save-key'),
    keyOk: $('key-ok'),
    keyErr: $('key-err'),
    modelSelect: $('model-select'),
    refreshModels: $('btn-refresh-models'),
    voiceSelect: $('voice-select'),
    testVoice: $('btn-test-voice'),
    rate: $('rate-range'),
    rateVal: $('rate-val'),
    pitch: $('pitch-range'),
    pitchVal: $('pitch-val'),
    autoTts: $('auto-tts'),
    toast: $('toast'),
    stateLabel: $('state-label'),
    halo: $('halo'),
    wavebars: $('wavebars'),
    transcript: $('transcript-panel'),
    tAmp: $('t-amp'),
    tTitleText: $('t-title-text'),
    tHint: $('t-hint'),
    convBtn: $('btn-conv'),
    convMode: $('conv-mode'),
    vadSens: $('vad-sens'),
    vadSensVal: $('vad-sens-val'),
    themeBtn: $('btn-theme'),
    themeMode: $('theme-mode'),
    wakeBtn: $('btn-wake'),
    wakeWord: $('wake-word'),
    wakeStay: $('wake-stay'),
    wakeStayVal: $('wake-stay-val'),
    wakeHelp: $('wake-help'),
    pName: $('p-name'),
    pAge: $('p-age'),
    pPhysique: $('p-physique'),
    pStudies: $('p-studies'),
    pNotes: $('p-notes'),
    macControl: $('mac-control'),
    timers: $('timers'),
    diag: $('btn-diag'),
    diagCopy: $('btn-diag-copy'),
    diagOut: $('diag-out'),
    recapProfile: $('btn-recap-profile'),
    recapMem: $('btn-recap-mem'),
    sportToday: $('sport-today'),
    sportWeek: $('sport-week'),
    sportStats: $('sport-stats'),
    sportPath: $('sport-path'),
    sportStart: $('sport-start'),
    sportErr: $('sport-err'),
  };

  var STATE = {
    busy: false,        // réponse en cours
    listening: false,   // enregistrement micro
    ttsMuted: false,
    history: [],        // [{role, content}]
    sessionId: null,    // conversation courante (mémoire serveur)
    lastAnswer: '',     // dernière réponse complète (commande « répète »)
    undone: null,       // conversation effacée, restaurable (« annule »)
  };

  var STORAGE_KEY = 'nova.settings.v1';
  var settings = {
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    voiceURI: '',
    rate: 1,
    pitch: 1,
    autoTts: true,
    convMode: false,
    vadSens: 0.5,
    sessionId: null,
    theme: 'auto',
    macControl: true,
    wakeWord: false,
    wakeStay: 12,
    lastTab: 'general',
  };

  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    Object.assign(settings, saved);
  } catch (_) {}

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
  }

  /* -------------------------------------------------------- */
  /* Thème clair / sombre / auto                                */
  /* -------------------------------------------------------- */

  var mqlLight = window.matchMedia('(prefers-color-scheme: light)');

  function effectiveTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme;
    return mqlLight.matches ? 'light' : 'dark';
  }

  function applyTheme() {
    var t = effectiveTheme();
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    var label = settings.theme === 'auto' ? 'Thème : auto — suit l\'apparence de macOS' : (t === 'light' ? 'Thème : clair — cliquer pour repasser en auto' : 'Thème : sombre — cliquer pour repasser en auto');
    if (els.themeBtn) els.themeBtn.title = label;
    if (window.NovaOrb && window.NovaOrb.retheme) window.NovaOrb.retheme();
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(settings.theme) + 1) % order.length];
    settings.theme = next;
    persist();
    applyTheme();
    if (els.themeMode) els.themeMode.value = next;
    toast(next === 'auto' ? 'Thème : auto' : next === 'light' ? 'Thème clair ☀️' : 'Thème sombre 🌙');
  }

  /* -------------------------------------------------------- */
  /* États visuels                                             */
  /* -------------------------------------------------------- */

  var STATE_TEXT = {
    idle: 'prête',
    listening: 'je t\u2019écoute…',
    thinking: 'je réfléchis…',
    speaking: 'je parle…',
    sleeping: 'en veille · dis « Nova »',
  };
  /* État de l'app → état de l'orbe (noms différents pour « pour dormir ») */
  var ORB_STATE = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking', sleeping: 'sleep' };

  function setState(name) {
    document.body.dataset.state = name;
    els.stateLabel.textContent = STATE_TEXT[name] || '';
    document.documentElement.style.setProperty('--state', stateColor(name));
    document.documentElement.style.setProperty('--state-glow', stateGlow(name));
    if (window.NovaOrb) window.NovaOrb.setState(ORB_STATE[name] || 'idle');
    els.wavebars.classList.toggle('on', name === 'listening');
    /* Pendant que Nova réfléchit ou parle, le moteur de veille n'écoute plus :
       sa propre voix ne doit jamais la réveiller. */
    if (window.NovaWake) window.NovaWake.setMuted(name === 'speaking' || name === 'thinking' || name === 'listening');
  }

  function stateColor(name) {
    return { idle: '#4f7cff', listening: '#2dd4a7', thinking: '#7c6cff', speaking: '#ffb45c', sleeping: '#6e7cb4' }[name] || '#4f7cff';
  }
  function stateGlow(name) {
    return {
      idle: 'rgba(79,124,255,0.55)',
      listening: 'rgba(45,212,167,0.55)',
      thinking: 'rgba(124,108,255,0.55)',
      speaking: 'rgba(255,180,92,0.55)',
      sleeping: 'rgba(110,124,180,0.3)',
    }[name] || 'rgba(79,124,255,0.55)';
  }

  function currentState() {
    if (STATE.listening) return 'listening';
    if (STATE.busy) return 'thinking';
    if (speechSynthesis.speaking) return 'speaking';
    /* Mot d'activation : réveillée et à l'écoute de la question, ou endormie */
    if (WAKE.armed) return CONV.running ? 'listening' : 'sleeping';
    return 'idle';
  }

  function refreshState() { setState(currentState()); }

  /* -------------------------------------------------------- */
  /* Toast                                                     */
  /* -------------------------------------------------------- */

  var toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    requestAnimationFrame(function () { els.toast.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
      setTimeout(function () { els.toast.hidden = true; }, 300);
    }, 4200);
  }

  /* -------------------------------------------------------- */
  /* Rendu des messages                                        */
  /* -------------------------------------------------------- */

  function timeStr() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function addMessage(role, text, extraOpts) {
    if (els.hero && els.hero.parentNode) { els.hero.style.display = 'none'; }
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (role === 'assistant') {
      bubble.innerHTML = window.NovaMarkdown ? window.NovaMarkdown.render(text) : escapeText(text);
    } else {
      bubble.textContent = text;
    }

    var time = document.createElement('div');
    time.className = 'time';
    time.textContent = timeStr();

    if (role === 'assistant') {
      var actions = document.createElement('div');
      actions.className = 'msg-actions';
      function actBtn(label, title, fn) {
        var b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', function () { fn(b); });
        return b;
      }
      actions.appendChild(actBtn('↺ écouter', 'Réécouter cette réponse', function () { speakFull(text); }));
      actions.appendChild(actBtn('⧉ copier', 'Copier le texte', function (b) {
        navigator.clipboard.writeText(text).then(function () { toast('Copié dans le presse-papiers'); });
      }));
      if (extraOpts && extraOpts.canRegenerate) {
        actions.appendChild(actBtn('↻ régénérer', 'Redemander une réponse à Nova', function (b) {
          if (STATE.busy) return;
          b.disabled = true;
          setTimeout(function () { b.disabled = false; }, 1500);
          regenerate();
        }));
      }
      time.appendChild(actions);
    }

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    els.messages.appendChild(wrap);
    scrollChat();
    return { wrap: wrap, bubble: bubble };
  }

  function escapeText(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function scrollChat() {
    els.chatInner.scrollTop = els.chatInner.scrollHeight;
  }

  /* -------------------------------------------------------- */
  /* Conversation : streaming Groq                             */
  /* -------------------------------------------------------- */

  function buildHistory() {
    // Garde les 16 derniers tours pour rester léger
    return STATE.history.slice(-16);
  }

  /* Régénérer : retire le dernier échange (question + réponse) et relance
     la même question — l'utilisateur garde la main sur une réponse ratée. */
  function regenerate() {
    if (STATE.busy || !STATE.history.length) return;
    var last = STATE.history[STATE.history.length - 1];
    if (last.role !== 'assistant') return;
    var question = STATE.history[STATE.history.length - 2];
    if (!question || question.role !== 'user') return;
    STATE.history.splice(STATE.history.length - 2, 2);
    var wraps = els.messages.querySelectorAll('.msg');
    for (var i = wraps.length - 1; i >= 0 && i >= wraps.length - 2; i--) wraps[i].remove();
    STATE.lastAnswer = '';
    sendMessage(question.content, { fromRestore: true });
  }

  function sendMessage(text, opts) {
    opts = opts || {};
    text = (text || '').trim();
    if (!text || STATE.busy) return;

    /* --- Commandes vocales (mémoire, voix, interface) --- */
    if (!opts.fromRestore) {
      var cmd = text.toLowerCase().replace(/[!?.…]/g, '').trim();
      var P = '^(nova,?\\s*)?';
      var E = '$';

      /* Mémoire (les formulations les plus spécifiques d'abord) */
      if (new RegExp(P + '(oublie tout|efface (toute )?la m[eé]moire|oublie toutes? (les )?conversations?)' + E).test(cmd)) {
        forgetAllMemory(true);
        return;
      }
      if (new RegExp(P + "(oublie (cette |notre )?(conversation|discussion)|on recommence (à )?z[eé]ro)" + E).test(cmd)) {
        forgetCurrentSession(true);
        return;
      }
      if (new RegExp(P + "(qu'?as[- ]tu retenu|de quoi te souviens[- ]tu|qu'est[- ]ce que tu sais sur moi|qu'est[- ]ce que tu retiens)" + E).test(cmd)) {
        speakRecap();
        return;
      }

      /* Contrôle de Nova elle-même */
      if (/^(nova,?\s*)?(coupe[- ]toi|tais[- ]toi|silence|chut|mets[- ]toi en sourdine|arrête de parler|ta voix)$/.test(cmd)) {
        muteNova(true);
        return;
      }
      if (/^(nova,?\s*)?(parle|parle[- ]moi|réactive ta voix|remets ta voix|reprends la parole|remets le son)$/.test(cmd)) {
        unmuteNova(true);
        return;
      }
      if (/^(nova,?\s*)?(plus vite|parle plus vite|accélère|accelere|accélère un peu)$/.test(cmd)) {
        changeRate(1, true);
        return;
      }
      if (/^(nova,?\s*)?(moins vite|parle moins vite|plus lentement|ralentis|parle plus lentement)$/.test(cmd)) {
        changeRate(-1, true);
        return;
      }
      if (/^(nova,?\s*)?(change de voix|change ta voix|autre voix|voix suivante|change de personne|nouvelle voix)$/.test(cmd)) {
        cycleVoice(true);
        return;
      }
      if (/^(nova,?\s*)?(efface|efface tout|efface la conversation|vide la conversation|nouvelle conversation|on repart à zéro)$/.test(cmd)) {
        clearConversation(true);
        return;
      }
      if (/^(nova,?\s*)?(annule|annule ça|annule l'?effacement|r[eé]tablis|reviens en arrière|remets la conversation|restaure)$/.test(cmd)) {
        restoreConversation(true);
        return;
      }
      if (/^(nova,?\s*)?(r[eé]p[eè]te|r[eé]p[eè]te[- ]moi|redis|redis[- ]moi|r[eé]p[eè]te (ça|ta r[eé]ponse)|tu peux r[eé]p[eé]ter)$/.test(cmd)) {
        repeatLast(true);
        return;
      }
      if (/^(nova,?\s*)?((la\s+|ma\s+)?s[eé]ance\s+(est\s+)?(termin[eé]e|finie|faite|valid[eé]e)|c'?est\s+fait|j'?ai\s+fini(\s+(la|ma)\s+s[eé]ance)?|s[eé]ance\s+termin[eé]e|valide\s+(la\s+|ma\s+)?s[eé]ance|(l'?)?entra[iî]nement\s+(est\s+)?(termin[eé]e?|fin[iy]|fait))$/.test(cmd)) {
        markTrainingDoneVoice();
        return;
      }
      if (/^(nova,?\s*)?(annule|arr[eê]te|supprime|stoppe)[- ](le |les |tous les |mon |mes )?minuteur/.test(cmd)) {
        clearTimers(true);
        return;
      }
      var demand = parseTimerRequest(text);
      if (demand) {
        startTimer(demand, true);
        return;
      }
      if (/^(nova,?\s*)?(va en veille|mets[- ]toi en veille|dors|endors[- ]toi|mode veille)$/.test(cmd)) {
        sleepNow(true);
        return;
      }
    }

    stopSpeaking();

    addMessage('user', text);
    STATE.history.push({ role: 'user', content: text });

    var msg = addMessage('assistant', '', { canRegenerate: true });
    var bubble = msg.bubble;
    bubble.innerHTML = '<span class="caret"></span>';
    bubble._novaStreaming = true;

    STATE.busy = true;
    els.send.disabled = true;
    refreshState();

    var acc = '';
    var speakQueue = new SpeakQueue();
    var done = false;
    var spokenLen = 0; // longueur déjà envoyée à la voix
    var demoMode = false; // serveur sans clé → réponses simulées (aucune vraie IA)

    /* Texte visible : retire les blocs <think>…</think> (raisonnement
       de certains modèles type Qwen), même ouverts/incomplets, et les
       lignes ACTION (protocole de contrôle du Mac, filtrées côté serveur
       aussi — double barrière). */
    function visibleText(s) {
      s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
      var i = s.lastIndexOf('<think>');
      if (i !== -1) s = s.slice(0, i);
      s = s.replace(/^\s*ACTION:\s*[a-z]+\s*\|[^\n]*$/gim, '');
      return s;
    }

    /* Action proposée par le modèle (ligne ACTION extraite côté serveur) */
    var pendingAction = null;
    /* Compétence de lecture utilisée en amont par le serveur (donnée réelle) */
    var pendingSkill = null;

    function finish(errText) {
      if (done) return;
      done = true;
      STATE.busy = false;
      els.send.disabled = false;
      bubble._novaStreaming = false;
      if (currentAbort === myAbort) currentAbort = null;
      var caret = bubble.querySelector('.caret');
      if (caret) caret.remove();
      if (errText === '__ABORTED__') {
        // Interruption volontaire (barge-in) : on garde ce qui est affiché
        if (bubble.querySelector('.interrupted')) {
          refreshState();
          scrollChat();
          return;
        }
        if (!bubble.textContent.trim()) {
          bubble.innerHTML = '<em>— coupée —</em>';
        } else {
          var em2 = document.createElement('em');
          em2.className = 'interrupted';
          em2.textContent = ' — coupée —';
          bubble.appendChild(em2);
        }
        refreshState();
        scrollChat();
        return;
      }
      var visibleFinal = visibleText(acc);
      if (!visibleFinal.trim()) {
        var msg = errText || 'Réponse vide — réessaie.';
        if (demoMode) {
          msg = 'Je parle en mode démonstration : le serveur n\u2019a pas de clé Groq, donc mes réponses sont pré-écrites et répétitives. Ajoute ta clé dans ⚙️ Général pour que je réponde vraiment à tout.';
        }
        bubble.innerHTML = '<em>' + escapeText(msg) + '</em>';
        var cleanMsg = window.NovaMarkdown ? window.NovaMarkdown.stripForSpeech(msg) : msg;
        if (settings.autoTts && !STATE.ttsMuted) speakUtterance(cleanMsg);
      } else {
        STATE.history.push({ role: 'assistant', content: visibleFinal.trim() });
        STATE.lastAnswer = visibleFinal.trim(); // pour « Nova, répète »
        if (settings.autoTts && !STATE.ttsMuted) {
          if (visibleFinal.length > spokenLen) {
            speakQueue.push(visibleFinal.slice(spokenLen));
            spokenLen = visibleFinal.length;
          }
          speakQueue.flush();
        }
      }
      if (pendingSkill) {
        renderSkillBadge(msg.wrap, pendingSkill);
        renderTrainingCard(msg.wrap, pendingSkill);
        pendingSkill = null;
      }
      if (pendingAction) {
        renderActionCard(msg.wrap, pendingAction, bubble);
        pendingAction = null;
      }
      refreshState();
      scrollChat();
      // En veille active : nouveau compte à rebours avant de se rendormir
      if (WAKE.armed) scheduleReSleep();
      // Boucle conversationnelle : après la réponse, on réécoute
      if (CONV.running) {
        setTimeout(function () {
          if (CONV.running && !STATE.busy) {
            restartConvRecorder();
            convSetStatus('En attente de ta voix…', true);
          }
        }, 600);
      }
    }

    var headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['X-Nova-Key'] = settings.apiKey;
    currentAbort = new AbortController();
    var myAbort = currentAbort;

    fetch('/api/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ messages: buildHistory(), model: settings.model, sessionId: STATE.sessionId }),
      signal: currentAbort.signal,
    })
      .catch(function (e) {
        if (e && e.name === 'AbortError') {
          finish('__ABORTED__');
          return null;
        }
        throw e;
      })
      .then(function (res) {
        if (!res) return null; // requête avortée
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            throw new Error(j.error || 'Erreur HTTP ' + res.status);
          });
        }
        return res.body;
      })
      .then(function (bodyStream) {
        if (!bodyStream) return; // avorté avant le flux
        var reader = bodyStream.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { finish(); return; }
            buf += decoder.decode(r.value, { stream: true });

            var idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
              var line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line || line.indexOf('data:') !== 0) continue;
              var data = line.slice(5).trim();
              if (data === '[DONE]') { finish(); return; }
              var parsed = null;
              try { parsed = JSON.parse(data); } catch (_) {}
              if (!parsed) continue;
              if (parsed.error) { throw new Error(parsed.error); }
              if (parsed.demo) { demoMode = true; }
              if (parsed.nova_model_used) {
                settings.model = parsed.nova_model_used;
                persist();
                toast('Modèle ajusté automatiquement : ' + settings.model);
              }
              if (parsed.nova_session) {
                STATE.sessionId = parsed.nova_session;
                settings.sessionId = parsed.nova_session;
                persist();
              }
              if (parsed.nova_profile) {
                STATE.profile = parsed.nova_profile;
                fillProfileForm(parsed.nova_profile);
              }
              if (parsed.nova_mac) {
                STATE.macEnabled = true;
                els.macControl.checked = settings.macControl !== false;
              }
              if (parsed.nova_skill) {
                pendingSkill = parsed.nova_skill;
              }
              if (parsed.nova_action) {
                pendingAction = parsed.nova_action;
              }
              if (parsed.nova_action_result) {
                applyActionResult(msg.wrap, parsed.nova_action_result);
              }
              var delta = parsed.choices && parsed.choices[0] && (parsed.choices[0].delta || parsed.choices[0].deltas);
              var piece = delta && delta.content ? delta.content : '';
              if (piece) {
                acc += piece;
                var visible = visibleText(acc);
                bubble.innerHTML = (window.NovaMarkdown ? window.NovaMarkdown.render(visible) : escapeText(visible)) + '<span class="caret"></span>';
                if (settings.autoTts && !STATE.ttsMuted && visible.length > spokenLen) {
                  speakQueue.push(visible.slice(spokenLen));
                  spokenLen = visible.length;
                }
                scrollChat();
              }
            }
            return pump();
          });
        }

        return pump().catch(function (e) { finish(e.message); });
      })
      .catch(function (e) {
        finish(e.message || 'Connexion impossible');
        toast(e.message || 'Erreur de connexion', true);
      });
  }

  /* File d'attente de lecture vocale phrase par phrase */
  function SpeakQueue() {
    var buffer = '';
    var speaking = false;
    var api = this;

    function sentenceEnd(t) {
      // Fin de phrase suivie d'espace/f blanc ; évite "M." "Dr." courants
      var m = t.match(/[^.!?…]+[.!?…]+(?=\s|$)/g);
      return m ? m.join('') : '';
    }

    api.push = function (piece) {
      if (!settings.autoTts || STATE.ttsMuted) return;
      buffer += piece;
      var donePart = sentenceEnd(buffer);
      if (donePart) {
        buffer = buffer.slice(donePart.length);
        speakUtterance(window.NovaMarkdown ? window.NovaMarkdown.stripForSpeech(donePart) : donePart, function () {
          if (!speaking && !STATE.busy) refreshState();
        });
        speaking = true;
      }
    };

    api.flush = function () {
      var rest = buffer.trim();
      buffer = '';
      if (rest) {
        speakUtterance(window.NovaMarkdown ? window.NovaMarkdown.stripForSpeech(rest) : rest);
      }
    };
  }

  /* -------------------------------------------------------- */
  /* Synthèse vocale (voix macOS)                              */
  /* -------------------------------------------------------- */

  var voices = [];

  function loadVoices() {
    voices = speechSynthesis.getVoices().filter(function (v) { return /^fr/i.test(v.lang); });
    if (!voices.length) {
      voices = speechSynthesis.getVoices();
    }
    /* Les voix de France d'abord : « Nova, change de voix » reste ainsi
       dans les voix de l'hexagone avant de proposer celles du Québec. */
    voices.sort(function (a, b) {
      var fa = /^fr[-_]?FR/i.test(a.lang) ? 0 : 1;
      var fb = /^fr[-_]?FR/i.test(b.lang) ? 0 : 1;
      return fa - fb;
    });
    fillVoiceSelect();
  }

  function fillVoiceSelect() {
    els.voiceSelect.innerHTML = '';
    voices.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name + (v.lang && !/^fr/i.test(v.lang) ? ' (' + v.lang + ')' : '');
      els.voiceSelect.appendChild(o);
    });
    if (settings.voiceURI) {
      els.voiceSelect.value = settings.voiceURI;
      if (els.voiceSelect.selectedIndex === -1 && voices.length) {
        els.voiceSelect.selectedIndex = 0;
        settings.voiceURI = voices[0].voiceURI;
        persist();
      }
    } else if (voices.length) {
      // Préfère Amélie / Audrey / Thomas par défaut
      var pref = voices.find(function (v) { return /am[ée]lie/i.test(v.name); }) ||
                 voices.find(function (v) { return /audrey|thomas/i.test(v.name); }) ||
                 voices[0];
      settings.voiceURI = pref.voiceURI;
      els.voiceSelect.value = pref.voiceURI;
      persist();
    }
  }

  function currentVoice() {
    return voices.find(function (v) { return v.voiceURI === settings.voiceURI; }) || voices[0] || null;
  }

  function speakUtterance(text, onEnd) {
    var t = (text || '').trim();
    if (!t || STATE.ttsMuted || !('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }

    var u = new SpeechSynthesisUtterance(t);
    var v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'fr-FR'; }
    u.rate = settings.rate;
    u.pitch = settings.pitch;

    u.onstart = refreshState;
    u.onend = function () { if (onEnd) onEnd(); refreshState(); };
    u.onerror = function () { if (onEnd) onEnd(); refreshState(); };

    /* La synthèse vocale ne doit jamais casser le flux de conversation :
     * y compris les throw synchrones (navigateurs intranets, webviews exotiques,
     * mocks partiellement remplacés). On restaure l'état si le speak échoue. */
    try { speechSynthesis.speak(u); } catch (_) { if (onEnd) onEnd(); refreshState(); }
  }

  /* -------------------------------------------------------- */
  /* Commandes vocales de contrôle (« Nova, … »)               */
  /* -------------------------------------------------------- */

  function novaSay(cmdText, msg) {
    addMessage('user', cmdText);
    addMessage('assistant', msg);
    speakUtterance(msg);
  }

  function roundRate(r) {
    /* On reste dans les bornes du curseur des réglages */
    var lo = els.rate ? parseFloat(els.rate.min) : 0.5;
    var hi = els.rate ? parseFloat(els.rate.max) : 2;
    if (isNaN(lo)) lo = 0.5;
    if (isNaN(hi)) hi = 2;
    return Math.max(lo, Math.min(hi, Math.round(r * 100) / 100));
  }
  function fmtRate(r) {
    return Number(r).toFixed(2).replace(/0$/, '') + '×';
  }

  /* « Nova, coupe-toi » — on arrête la voix et on la met en sourdine */
  function muteNova(speak) {
    STATE.ttsMuted = true;
    els.tts.classList.add('muted');
    stopSpeaking();
    var msg = "D'accord, je me tais. Dis « Nova, parle » quand tu veux que je reprenne.";
    toast('Voix coupée');
    if (speak) novaSay('Nova, coupe-toi', msg);
  }

  /* « Nova, parle » — on rend la voix */
  function unmuteNova(speak) {
    STATE.ttsMuted = false;
    els.tts.classList.remove('muted');
    var msg = 'Me revoilà, je te parle à nouveau.';
    toast('Voix réactivée');
    if (speak) novaSay('Nova, parle', msg);
    else speakUtterance(msg);
  }

  /* « Nova, plus vite » / « Nova, moins vite » */
  function changeRate(dir, speak) {
    settings.rate = roundRate((Number(settings.rate) || 1) + dir * 0.15);
    persist();
    if (els.rate) els.rate.value = settings.rate;
    if (els.rateVal) els.rateVal.textContent = fmtRate(settings.rate);
    var msg = dir > 0
      ? "C'est noté, j'accélère — vitesse " + fmtRate(settings.rate) + '.'
      : 'D\u2019accord, je ralentis — vitesse ' + fmtRate(settings.rate) + '.';
    toast('Vitesse de parole : ' + fmtRate(settings.rate));
    if (speak) novaSay(dir > 0 ? 'Nova, plus vite' : 'Nova, moins vite', msg);
    else speakUtterance(msg);
  }

  /* « Nova, change de voix » — voix française suivante de macOS */
  function cycleVoice(speak) {
    if (!voices.length) {
      toast('Aucune voix disponible', true);
      return;
    }
    var i = voices.findIndex(function (v) { return v.voiceURI === settings.voiceURI; });
    i = (i + 1) % voices.length;
    settings.voiceURI = voices[i].voiceURI;
    persist();
    if (els.voiceSelect) els.voiceSelect.value = settings.voiceURI;
    var msg = 'Nouvelle voix : ' + voices[i].name + '. Je te plais comme ça ?';
    toast('Voix : ' + voices[i].name);
    if (speak) novaSay('Nova, change de voix', msg);
    else speakUtterance(msg);
  }

  /* « Nova, efface » — vide la conversation affichée (la mémoire reste) */
  function clearConversation(speak) {
    stopSpeaking();
    /* Instantané pour « Nova, annule » : on garde les bulles elles-mêmes,
       donc les cartes d'action et les résultats restent intacts. */
    if (els.messages.childNodes.length) {
      STATE.undone = {
        nodes: Array.prototype.slice.call(els.messages.childNodes),
        history: STATE.history.slice(),
        sessionId: STATE.sessionId,
      };
    }
    STATE.history = [];
    els.messages.innerHTML = '';
    els.hero.style.display = '';
    // Nouvelle session côté mémoire : la discussion précédente reste archivée
    STATE.sessionId = null;
    settings.sessionId = null;
    persist();
    toast('Conversation effacée — tes souvenirs restent dans la mémoire');
    if (speak) {
      novaSay('Nova, efface', "C'est effacé, on repart de zéro. Tes souvenirs, eux, restent en mémoire. Dis « annule » si tu veux la récupérer.");
    }
  }

  /* « Nova, annule » — remet la conversation que « efface » avait vidée */
  function restoreConversation(speak) {
    if (!STATE.undone) {
      if (speak) novaSay('Nova, annule', "Il n'y a rien à annuler, on n'a rien effacé.");
      else toast('Rien à annuler', true);
      return;
    }
    var u = STATE.undone;
    STATE.undone = null;
    STATE.history = u.history.slice();
    STATE.sessionId = u.sessionId;
    settings.sessionId = u.sessionId;
    persist();
    els.messages.innerHTML = '';
    u.nodes.forEach(function (n) { els.messages.appendChild(n); });
    els.hero.style.display = u.nodes.length ? 'none' : '';
    var msg = 'Voilà, la conversation est de retour.';
    toast('Conversation rétablie');
    if (speak) novaSay('Nova, annule', msg);
    else speakUtterance(msg);
    scrollChat();
  }

  /* « Nova, répète » — redit la dernière réponse en entier */
  function repeatLast(speak) {
    var last = STATE.lastAnswer || '';
    if (!last) {
      var vide = "Je n'ai encore rien dit, il n'y a rien à répéter.";
      if (speak) novaSay('Nova, répète', vide);
      else toast(vide, true);
      return;
    }
    if (STATE.ttsMuted) {
      var muet = 'Ma voix est coupée. Dis « Nova, parle » et je te la relis.';
      addMessage('user', 'Nova, répète');
      addMessage('assistant', muet);
      toast('Voix coupée — dis « Nova, parle »', true);
      return;
    }
    addMessage('user', 'Nova, répète');
    addMessage('assistant', last);
    stopSpeaking();
    speakUtterance(window.NovaMarkdown ? window.NovaMarkdown.stripForSpeech(last) : last);
    toast('Je répète');
  }

  /* -------------------------------------------------------- */
  /* Minuteurs (« Nova, mets un minuteur de 5 minutes »)       */
  /* -------------------------------------------------------- */

  var timers = [];
  var timerSeq = 0;

  var NUM_FR = {
    un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
    dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20,
    trente: 30, quarante: 40, cinquante: 50, soixante: 60, cent: 100,
  };

  /* Une durée en secondes, tolérante à l'oral : « 5 minutes », « 1 h 30 »,
     « 1 heure 30 », « 90 secondes », « une demi-heure », « deux heures »,
     « une heure et demie ». */
  function timerSeconds(text) {
    var t = String(text || '').toLowerCase()
      .replace(/(\d+)\s*h\s*(\d+)\b/g, '$1 heures $2 minutes')   // 1h30
      .replace(/(\d+)\s*h\b/g, '$1 heures')                        // 2h
      .replace(/(\d+|une?)\s*heures?\s+et\s+demie\b/g, '$1 heures 30 minutes')
      .replace(/(\d+|une?)\s*minutes?\s+et\s+demie\b/g, '$1 minutes 30 secondes')
      .replace(/(\d+)\s*(heures?)\s+(\d{1,2})\b(?!\s*(?:minutes?|mins?|secondes?|secs?))/g, '$1 $2 $3 minutes')  // 1 heure 30
      .replace(/demi[- ]heure/g, '30 minutes')
      .replace(/\bune? heure\b/g, '60 minutes');
    var re = /(\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent)\s*(?:et\s+demi\s+)?(secondes?|secs?|s|minutes?|mins?|heures?|hrs?|h)\b/g;
    var total = 0;
    var found = false;
    var m;
    while ((m = re.exec(t))) {
      var v = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (NUM_FR[m[1]] || 0);
      if (!v) continue;
      if (/et\s+demi/.test(m[0])) v += 0.5;
      found = true;
      var u = m[2];
      if (/^(s|sec|seconde)/.test(u)) total += v;
      else if (/^(h|heure|hr)/.test(u)) total += v * 3600;
      else total += v * 60;
    }
    if (!found) return 0;
    return Math.max(1, Math.min(12 * 3600, Math.round(total)));
  }

  var TIMER_DUR_RE = /(secondes?|secs?|minutes?|mins?|heures?|hrs?|h)\b/;
  var TIMER_WORDS_RE = /\b(minuteur|minuterie|compte[- ]?rebours|chrono|timer|alarme|rappel|rappelle|nova|mets|met|lance|cr[eé]e|cr[eé]er|fais|dans|pour|de|du|des|d|et|à|a|au|aux|moi|me|sur|le|la|les|l|un|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|demie?|demi-heure)\b/g;

  /* Un texte qui demande un minuteur ? Renvoie { seconds, label } ou null.
     On ignore les phrases négatives (« annule le minuteur ») traitées avant. */
  function parseTimerRequest(text) {
    var t = String(text || '').toLowerCase();
    if (!/(minuteur|minuterie|compte[- ]?rebours|chrono|timer|rappelle[- ]?moi|pr[eé]viens[- ]moi dans|alerte[- ]moi dans|r[eé]veille[- ]moi dans|dans \d)/.test(t)) return null;
    var s = timerSeconds(t);
    if (!s) return null;
    return { seconds: s, label: timerLabel(t) };
  }

  /* Ce qui reste quand on a retiré la durée et les mots de commande :
     « minuteur de 10 minutes pour les pâtes » → « pâtes ». */
  function timerLabel(text) {
    var s = String(text || '').toLowerCase()
      .replace(/(\d+)\s*h\s*\d+/g, ' ')
      .replace(/(\d+)\s*h\b/g, ' ')
      .replace(/\b\d+\b/g, ' ')
      .replace(TIMER_WORDS_RE, ' ')
      .replace(TIMER_DUR_RE, ' ')
      .replace(/[^a-zà-ÿ'’ ]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zà-ÿ]/i.test(s)) return '';
    return s.length >= 2 ? s.slice(0, 40) : '';
  }

  function fmtCountdown(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  }

  /* Explicite au lieu d'arrondi : 90 s → « 1 minute et 30 secondes »,
     jamais « 2 minutes » (faux et trompeur pour un minuteur). */
  function fmtDurationSec(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' seconde' + (sec > 1 ? 's' : '');
    if (sec < 3600) {
      var mn = Math.floor(sec / 60);
      var rs = sec % 60;
      var out = mn + ' minute' + (mn > 1 ? 's' : '');
      if (rs) out += ' et ' + rs + ' seconde' + (rs > 1 ? 's' : '');
      return out;
    }
    var h = Math.floor(sec / 3600);
    var r = Math.floor((sec % 3600) / 60);
    var out2 = h + ' heure' + (h > 1 ? 's' : '');
    if (r) out2 += ' et ' + r + ' minute' + (r > 1 ? 's' : '');
    return out2;
  }

  function renderTimers() {
    if (!els.timers) return;
    els.timers.innerHTML = '';
    els.timers.hidden = !timers.length;
    timers.forEach(function (t) {
      var chip = document.createElement('div');
      chip.className = 'timer-chip' + (t.fired ? ' done' : '');
      var time = document.createElement('span');
      time.className = 't-time';
      time.textContent = t.fired ? 'Terminé' : fmtCountdown((t.endsAt - Date.now()) / 1000);
      chip.appendChild(time);
      /* L'étiquette n'apparaît que si elle apporte autre chose que la durée */
      if (t.label) {
        var label = document.createElement('span');
        label.className = 't-label';
        label.textContent = t.label;
        chip.appendChild(label);
      } else if (!t.fired) {
        var dur = document.createElement('span');
        dur.className = 't-label';
        dur.textContent = fmtDurationSec(t.seconds);
        chip.appendChild(dur);
      }
      var stop = document.createElement('button');
      stop.type = 'button';
      stop.title = 'Arrêter ce minuteur';
      stop.setAttribute('aria-label', 'Arrêter ce minuteur');
      stop.textContent = '✕';
      stop.addEventListener('click', function () { cancelTimer(t.id, false); });
      chip.appendChild(stop);
      t.el = chip;
      els.timers.appendChild(chip);
    });
  }

  /* Petit carillon à deux notes (Web Audio) — aucun fichier à charger */
  function chimeTimer() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      [880, 1320].forEach(function (f, i) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        var t0 = ctx.currentTime + i * 0.22;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.55);
      });
      setTimeout(function () { try { ctx.close(); } catch (_) {} }, 1400);
    } catch (_) {}
  }

  function fireTimer(t) {
    if (t.fired) return;
    t.fired = true;
    clearInterval(t.interval);
    renderTimers();
    var mot = t.label || fmtDurationSec(t.seconds);
    var msg = 'Ton minuteur de ' + mot + ' est terminé.';
    chimeTimer();
    addMessage('assistant', '⏰ ' + msg);
    toast('⏰ Minuteur terminé');
    if (!STATE.ttsMuted) speakUtterance(msg);
    try {
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('Nova', { body: msg });
      }
    } catch (_) {}
    setTimeout(function () { cancelTimer(t.id, true); }, 60000);
  }

  function startTimer(req, speak) {
    var t = {
      id: ++timerSeq,
      seconds: req.seconds,
      label: req.label || '',
      endsAt: Date.now() + req.seconds * 1000,
      fired: false,
    };
    timers.push(t);
    t.interval = setInterval(function () {
      if (Date.now() >= t.endsAt) return fireTimer(t);
      if (t.el) {
        var timeEl = t.el.querySelector('.t-time');
        if (timeEl) timeEl.textContent = fmtCountdown((t.endsAt - Date.now()) / 1000);
      }
    }, 1000);
    renderTimers();
    /* Autorisation des notifications macOS : demandée seulement au premier minuteur */
    try {
      if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
    } catch (_) {}
    var msg = 'Minuteur lancé : ' + fmtDurationSec(t.seconds) + (t.label ? ' — ' + t.label : '') + '.';
    toast('⏱ ' + fmtDurationSec(t.seconds));
    if (speak) novaSay('Nova, minuteur de ' + fmtDurationSec(t.seconds), msg);
    else speakUtterance(msg);
  }

  function cancelTimer(id, silent) {
    var i = timers.findIndex(function (t) { return t.id === id; });
    if (i === -1) return;
    clearInterval(timers[i].interval);
    timers.splice(i, 1);
    renderTimers();
    if (!silent) toast('Minuteur arrêté');
  }

  /* « Nova, annule le minuteur » */
  function clearTimers(speak) {
    var n = timers.length;
    timers.forEach(function (t) { clearInterval(t.interval); });
    timers = [];
    renderTimers();
    var msg = n
      ? (n > 1 ? n + ' minuteurs arrêtés.' : 'Minuteur arrêté.')
      : "Il n'y a aucun minuteur en cours.";
    if (n) toast('Minuteur arrêté');
    if (speak && n) novaSay('Nova, annule le minuteur', msg);
    else if (n) speakUtterance(msg);
    else if (speak) novaSay('Nova, annule le minuteur', msg);
  }

  function speakFull(text) {
    stopSpeaking();
    if (!settings.autoTts || STATE.ttsMuted) return;
    var clean = window.NovaMarkdown ? window.NovaMarkdown.stripForSpeech(text) : text;
    speakUtterance(clean);
  }

  function stopSpeaking() {
    try { speechSynthesis.cancel(); } catch (_) {}
    refreshState();
  }

  /* -------------------------------------------------------- */
  /* Annulation des requêtes en cours (barge-in)                */
  /* -------------------------------------------------------- */

  var currentAbort = null;

  function abortCurrentRequest() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (_) {}
      currentAbort = null;
      return true;
    }
    return false;
  }

  /* -------------------------------------------------------- */
  /* Conversation continue (VAD) et barge-in                    */
  /* -------------------------------------------------------- */

  /* -------------------------------------------------------- */
  /* Mot d'activation « Nova » (veille ⇄ réveil)               */
  /* -------------------------------------------------------- */

  var WAKE = {
    armed: false,       // en veille, à l'écoute de son nom
    sleepTimer: null,   // délai avant de se rendormir après une réponse
    convTimer: null,    // ouverture différée du micro (réveil avec demande incluse)
    chimeCtx: null,
  };

  function wakeHeaders() {
    return settings.apiKey ? { 'X-Nova-Key': settings.apiKey } : {};
  }

  /* Petit carillon de réveil (deux notes, sans fichier audio) */
  function wakeChime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!WAKE.chimeCtx) WAKE.chimeCtx = new Ctx();
      var ctx = WAKE.chimeCtx;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      [784, 1175].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var t0 = ctx.currentTime + i * 0.085;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.3);
      });
    } catch (_) { /* audio indisponible : on continue sans carillon */ }
  }

  function wakeStayMs() {
    var s = Number(settings.wakeStay);
    if (!s || isNaN(s)) s = 12;
    return Math.max(5, Math.min(90, s)) * 1000;
  }

  function armWake(silent) {
    if (!settings.wakeWord) return;
    if (WAKE.armed) return;
    WAKE.armed = true;
    setWakeButton(true);
    if (!silent) toast('En veille — dis « Nova » quand tu veux');
    try {
      var mode = window.NovaWake.start({
        headers: wakeHeaders(),
        sensitivity: settings.vadSens,
        onWake: onWakeWord,
        onError: function (msg) {
          /* On garde le réglage (intention de l'utilisateur) : un échec de
             micro est souvent transitoire — un clic sur la lune réessaie. */
          toast('Mot d\u2019activation indisponible : ' + msg + ' — clique sur la lune pour réessayer', true);
          WAKE.armed = false;
          setWakeButton(false);
          refreshState();
        },
      });
      els.wakeHelp && (els.wakeHelp.dataset.engine = mode);
    } catch (_) {}
    refreshState();
  }

  function disarmWake() {
    WAKE.armed = false;
    clearTimeout(WAKE.sleepTimer);
    clearTimeout(WAKE.convTimer);
    WAKE.sleepTimer = null;
    WAKE.convTimer = null;
    if (window.NovaWake) window.NovaWake.stop();
    setWakeButton(false);
    if (CONV.running) stopConv();
    refreshState();
  }

  function setWakeButton(on) {
    if (!els.wakeBtn) return;
    els.wakeBtn.classList.toggle('armed', !!on);
    els.wakeBtn.title = on
      ? 'Veille active — dis « Nova » (cliquer pour désactiver)'
      : 'Mot d\u2019activation : dis « Nova » pour me réveiller';
    els.wakeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /* Réveil : carillon, puis on ouvre le micro (VAD) et on attend la question.
     Si la demande a été dite d'un seul souffle (« Nova, coupe-toi »,
     « Nova, quelle heure est-il ? »), on la traite tout de suite. */
  function onWakeWord(source, remainder) {
    if (!WAKE.armed) return;
    wakeChime();
    clearTimeout(WAKE.sleepTimer);
    WAKE.sleepTimer = null;
    toast('Nova est réveillée');
    scheduleReSleep();

    if (remainder && remainder.length > 1) {
      /* On repousse l'ouverture du micro : la fin de la phrase vient
         d'être prononcée, inutile de la réenregistrer. */
      sendMessageWhenFree(remainder, { viaWake: true }, 20);
      clearTimeout(WAKE.convTimer);
      WAKE.convTimer = setTimeout(function () {
        if (!WAKE.armed || CONV.running) return;
        startConv().then(function () { if (CONV.running) scheduleReSleep(); });
      }, 1400);
      return;
    }

    if (!CONV.running) {
      startConv().then(function () {
        if (CONV.running) scheduleReSleep();
      });
    } else {
      convSetStatus('En attente de ta voix…', true);
    }
  }

  /* « Nova, va en veille » — on rendort tout de suite (le mot d'activation
     reste actif si l'utilisateur l'avait activé). */
  function sleepNow(speak) {
    clearTimeout(WAKE.sleepTimer);
    WAKE.sleepTimer = null;
    clearTimeout(WAKE.convTimer);
    WAKE.convTimer = null;
    if (CONV.running) stopConv();
    var msg = WAKE.armed
      ? 'Je retourne en veille. Dis « Nova » quand tu as besoin de moi.'
      : 'D\u2019accord, je me tais. Réactive la lune ou dis « Nova » pour me réveiller.';
    if (speak) novaSay('Nova, va en veille', msg);
    else speakUtterance(msg);
    refreshState();
  }

  /* Après chaque réponse : Nova reste réveillée un moment, puis se rendort */
  function scheduleReSleep() {
    if (!WAKE.armed) return;
    clearTimeout(WAKE.sleepTimer);
    WAKE.sleepTimer = setTimeout(function () {
      if (!WAKE.armed) return;
      if (STATE.busy || speechSynthesis.speaking || (CONV.running && CONV.speaking)) {
        scheduleReSleep(); // elle parle encore : on repousse
        return;
      }
      if (CONV.running) stopConv();
      toast('Nova se remet en veille');
      refreshState();
    }, wakeStayMs());
  }

  var CONV = {
    active: false,      // mode activé
    running: false,     // session en cours (micro ouvert)
    stream: null,
    audioCtx: null,
    analyser: null,
    data: null,
    raf: 0,
    speaking: false,    // l'utilisateur parle
    speechStartT: 0,
    silenceStartT: 0,
    lastVoiceT: 0,
    smooth: 0,
    recorder: null,
    chunks: [],
    sendTimer: null,
  };

  function vadThresholds() {
    var s = Math.max(0, Math.min(1, Number(settings.vadSens)));
    if (isNaN(s)) s = 0.5;
    return {
      on: 0.16 - s * 0.12,   // sensibilité haute → seuil bas
      off: 0.10 - s * 0.08,
    };
  }

  function convSetStatus(title, waiting) {
    if (els.tTitleText) els.tTitleText.textContent = title;
    if (els.transcript) els.transcript.classList.toggle('waiting', !!waiting);
    if (els.tHint) {
      els.tHint.textContent = waiting
        ? 'Parle quand tu veux · bouton micro ou échap pour couper'
        : 'Je t\u2019écoute…';
    }
  }

  function setConvButton(on) {
    els.convBtn.classList.toggle('on', !!on);
    els.convBtn.title = on ? 'Couper le mode conversation' : 'Conversation naturelle : Nova détecte ta voix';
  }

  async function startConv() {
    if (CONV.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Micro indisponible dans ce navigateur.', true);
      return;
    }
    try {
      CONV.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      toast('Accès au micro refusé — autorise-le pour la conversation continue.', true);
      return;
    }
    CONV.running = true;
    CONV.active = true;
    setConvButton(true);
    els.transcript.hidden = false;
    els.transcript.classList.add('show');
    convSetStatus('En attente de ta voix…', true);

    try {
      CONV.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = CONV.audioCtx.createMediaStreamSource(CONV.stream);
      CONV.analyser = CONV.audioCtx.createAnalyser();
      CONV.analyser.fftSize = 1024;
      src.connect(CONV.analyser);
      CONV.data = new Uint8Array(CONV.analyser.frequencyBinCount);
    } catch (e) {
      stopConv();
      toast('Analyse audio impossible : ' + e.message, true);
      return;
    }

    CONV.chunks = [];
    var mime = pickMime();
    try {
      CONV.recorder = mime ? new MediaRecorder(CONV.stream, { mimeType: mime }) : new MediaRecorder(CONV.stream);
    } catch (e) {
      stopConv();
      toast('Enregistrement impossible : ' + e.message, true);
      return;
    }
    CONV.recorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) CONV.chunks.push(ev.data);
    };
    CONV.recorder.onstop = onConvSegment;    try {
      CONV.recorder.start(250);
    } catch (e) {
      stopConv();
      toast('Enregistrement impossible : ' + e.message, true);
      return;
    }
    convLoop();
    refreshState(); // réveillée : on quitte l'état « en veille »
  }

  function stopConv() {
    CONV.active = false;
    if (!CONV.running) { setConvButton(false); return; }
    CONV.running = false;
    cancelAnimationFrame(CONV.raf);
    clearTimeout(CONV.sendTimer);
    if (CONV.recorder && CONV.recorder.state !== 'inactive') {
      CONV.recorder._novaCancel = true;
      try { CONV.recorder.stop(); } catch (_) {}
    }
    if (CONV.stream) {
      CONV.stream.getTracks().forEach(function (t) { t.stop(); });
      CONV.stream = null;
    }
    if (CONV.audioCtx) {
      try { CONV.audioCtx.close(); } catch (_) {}
      CONV.audioCtx = null;
      CONV.analyser = null;
    }
    els.transcript.classList.remove('show');
    setTimeout(function () { if (!STATE.listening && !CONV.running) els.transcript.hidden = true; }, 260);
    if (window.NovaOrb) window.NovaOrb.setMicLevel(0);
    setConvButton(false);
    refreshState();
  }

  function convLoop() {
    if (!CONV.running) return;
    CONV.raf = requestAnimationFrame(convLoop);

    var level = 0;
    if (window.NovaConv && typeof window.NovaConv.simulateLevel === 'function') {
      // Hook de test/preview : niveau audio simulé
      level = Math.max(0, Math.min(1, Number(window.NovaConv.simulateLevel()) || 0));
    } else if (CONV.analyser) {
      CONV.analyser.getByteFrequencyData(CONV.data);
      var sum = 0;
      for (var i = 0; i < CONV.data.length; i++) sum += CONV.data[i];
      level = Math.min(1, sum / CONV.data.length / 140);
    }
    CONV.smooth += (level - CONV.smooth) * 0.3;
    var now = performance.now();
    var th = vadThresholds();

    if (window.NovaOrb) window.NovaOrb.setMicLevel(CONV.smooth);
    var ampBars = els.tAmp ? Array.prototype.slice.call(els.tAmp.children) : [];
    for (var b = 0; b < ampBars.length; b++) {
      var h = 12 + 88 * Math.max(0.06, Math.min(1, CONV.smooth * (0.7 + 0.6 * Math.abs(Math.sin(now / 190 + b)))));
      ampBars[b].style.height = h.toFixed(0) + '%';
    }

    /* Barge-in : pendant que Nova parle ou réfléchit, ta voix la coupe */
    if (CONV.smooth > th.on) {
      CONV.lastVoiceT = now;
      if (STATE.busy || speechSynthesis.speaking) {
        interruptNova('Je t\u2019écoute…');
      }
      if (!CONV.speaking) {
        CONV.speaking = true;
        CONV.speechStartT = now;
        CONV.silenceStartT = 0;
        convSetStatus('Je t\u2019écoute…', false);
      }
    } else if (CONV.speaking) {
      if (CONV.smooth < th.off) {
        if (!CONV.silenceStartT) CONV.silenceStartT = now;
        var silence = now - CONV.silenceStartT;
        if (silence > 1000 && now - CONV.speechStartT > 500) {
          finalizeConvSegment();
          return;
        }
      } else {
        CONV.silenceStartT = 0;
      }
      // Sécurité anti-monologue : max 30 s d'un seul segment
      if (now - CONV.speechStartT > 30000) {
        finalizeConvSegment();
        return;
      }
    }
  }

  function finalizeConvSegment() {
    CONV.speaking = false;
    CONV.silenceStartT = 0;
    convSetStatus('Je réfléchis à ce que tu as dit…', true);
    if (CONV.recorder && CONV.recorder.state === 'recording') {
      try { CONV.recorder.stop(); } catch (_) {}
    }
  }

  async function onConvSegment() {
    if (!CONV.running) return;
    var cancel = CONV.recorder && CONV.recorder._novaCancel;
    CONV.recorder._novaCancel = false;
    var blob = new Blob(CONV.chunks, { type: CONV.recorder.mimeType || 'audio/webm' });
    CONV.chunks = [];
    if (cancel) return;
    if (blob.size < 3000) {
      convSetStatus('En attente de ta voix…', true);
      restartConvRecorder();
      return;
    }

    var headers = {};
    if (settings.apiKey) headers['X-Nova-Key'] = settings.apiKey;
    var fd = new FormData();
    fd.append('file', blob, 'segment.webm');

    try {
      var res = await fetch('/api/stt', { method: 'POST', headers: headers, body: fd });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(j.error || 'Erreur de transcription');
      var text = (j.text || '').trim();
      if (!text) {
        convSetStatus('En attente de ta voix…', true);
        restartConvRecorder();
        return;
      }
      sendMessageWhenFree(text, { viaConv: true }, 40);
    } catch (e) {
      toast(e.message || 'Transcription impossible', true);
      convSetStatus('En attente de ta voix…', true);
    }
  }

  function restartConvRecorder() {
    if (!CONV.running || !CONV.recorder) return;
    try {
      CONV.recorder.start(250);
      convSetStatus('En attente de ta voix…', true);
    } catch (e) {
      // État invalide (cas rare) : on recrée le recorder
      try {
        var mime = pickMime();
        CONV.recorder = mime ? new MediaRecorder(CONV.stream, { mimeType: mime }) : new MediaRecorder(CONV.stream);
        CONV.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) CONV.chunks.push(ev.data); };
        CONV.recorder.onstop = onConvSegment;
        CONV.recorder.start(250);
        convSetStatus('En attente de ta voix…', true);
      } catch (e2) {
        stopConv();
        toast('Micro arrêté : ' + e2.message, true);
      }
  }
  }

  /* Envoi patient : attend que la réponse précédente soit bien avortée */
  function sendMessageWhenFree(text, opts, tries) {
    if (!STATE.busy) { sendMessage(text, opts); return; }
    if (tries <= 0) { toast('Nova est occupée — réessaie dans un instant'); return; }
    setTimeout(function () { sendMessageWhenFree(text, opts, tries - 1); }, 250);
  }

  function interruptNova(statusTitle) {
    var didAbort = abortCurrentRequest();
    var wasSpeaking = false;
    try { wasSpeaking = speechSynthesis.speaking || speechSynthesis.pending; } catch (_) {}
    stopSpeaking();
    if (didAbort || wasSpeaking) {
      // Marque la bulle interrompue
      var lastBubbles = document.querySelectorAll('.msg.assistant .bubble');
      var last = lastBubbles[lastBubbles.length - 1];
      if (last && (last.querySelector('.caret') || last._novaStreaming)) {
        last._novaStreaming = false;
        var caret = last.querySelector('.caret');
        if (caret) caret.remove();
        var em = document.createElement('em');
        em.className = 'interrupted';
        em.textContent = ' — coupée —';
        last.appendChild(em);
      }
    }
    if (statusTitle) convSetStatus(statusTitle, false);
  }

  var mediaStream = null;
  var mediaRecorder = null;
  var audioCtx = null;
  var analyser = null;
  var levelRAF = null;
  var chunks = [];
  var pushTimer = null;

  var MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return '';
  }

  async function startListening() {
    if (STATE.listening || STATE.busy) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Ton navigateur ne permet pas l\u2019accès au micro. Utilise Chrome, Edge ou Safari.', true);
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      toast('Accès au micro refusé — autorise-le dans les réglages du navigateur.', true);
      return;
    }

    chunks = [];
    var mime = pickMime();
    try {
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    } catch (e) {
      toast('Impossible de démarrer l\u2019enregistrement : ' + e.message, true);
      stopStream();
      return;
    }

    mediaRecorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) chunks.push(ev.data);
    };
    mediaRecorder.onstop = onRecordStop;

    try { mediaRecorder.start(250); } catch (e) {
      toast('Erreur d\u2019enregistrement : ' + e.message, true);
      stopStream();
      return;
    }

    STATE.listening = true;
    els.mic.classList.add('listening');
    els.mic.title = 'Relâche pour envoyer';
    els.transcript.hidden = false;
    requestAnimationFrame(function () { els.transcript.classList.add('show'); });
    refreshState();

    // Analyse du volume pour l'orbe et les barres
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
    } catch (_) { analyser = null; }

    var freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    var ampBars = Array.prototype.slice.call(els.tAmp.children);
    var smooth = 0;

    function meter() {
      if (!STATE.listening) return;
      var level = 0;
      if (analyser) {
        analyser.getByteFrequencyData(freqData);
        var sum = 0;
        for (var i = 0; i < freqData.length; i++) sum += freqData[i];
        level = Math.min(1, (sum / freqData.length / 140));
      }
      smooth += (level - smooth) * 0.25;
      if (window.NovaOrb) window.NovaOrb.setMicLevel(smooth);

      for (var b = 0; b < ampBars.length; b++) {
        var h = 12 + 88 * Math.max(0.06, Math.min(1, smooth * (0.7 + 0.6 * Math.abs(Math.sin(performance.now() / 190 + b)))));
        ampBars[b].style.height = h.toFixed(0) + '%';
      }
      var wb = els.wavebars.children;
      for (var w = 0; w < wb.length; w++) {
        var hh = 4 + 26 * Math.max(0.05, Math.min(1, smooth * (0.6 + 0.9 * Math.abs(Math.sin(performance.now() / 150 + w * 1.3)))));
        wb[w].style.height = hh.toFixed(0) + 'px';
      }
      levelRAF = requestAnimationFrame(meter);
    }
    meter();
  }

  function stopListening(cancelOnly) {
    if (!STATE.listening) return;
    STATE.listening = false;
    cancelAnimationFrame(levelRAF);
    els.mic.classList.remove('listening');
    els.mic.title = 'Maintenir pour parler (espace)';
    els.transcript.classList.remove('show');
    setTimeout(function () { els.transcript.hidden = true; }, 260);
    if (window.NovaOrb) window.NovaOrb.setMicLevel(0);

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder._novaCancel = !!cancelOnly;
      try { mediaRecorder.stop(); } catch (_) {}
    }
    stopStream();
    refreshState();
  }

  function stopStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
      analyser = null;
    }
  }

  async function onRecordStop() {
    if (mediaRecorder && mediaRecorder._novaCancel) {
      mediaRecorder._novaCancel = false;
      chunks = [];
      return;
    }
    var blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    chunks = [];
    if (blob.size < 2000) {
      toast('Enregistrement trop court — maintiens plus longtemps.');
      return;
    }

    STATE.busy = true;
    refreshState();

    var headers = {};
    if (settings.apiKey) headers['X-Nova-Key'] = settings.apiKey;

    var fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('language', 'fr');

    try {
      var res = await fetch('/api/stt', { method: 'POST', headers: headers, body: fd });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(j.error || 'Erreur de transcription');
      var text = (j.text || '').trim();
      if (!text) {
        toast(j.message || 'Je n\u2019ai rien entendu — réessaie plus près du micro.');
        return;
      }
      // Libère l'état AVANT d'envoyer : sendMessage refuse un appel si busy
      STATE.busy = false;
      refreshState();
      sendMessage(text);
    } catch (e) {
      toast(e.message || 'Transcription impossible', true);
    } finally {
      STATE.busy = false;
      refreshState();
    }
  }

  /* -------------------------------------------------------- */
  /* Profil utilisateur                                        */
  /* -------------------------------------------------------- */

  function fillProfileForm(p) {
    if (!p || !els.pName) return;
    els.pName.value = p.name || '';
    els.pAge.value = p.age || '';
    els.pPhysique.value = p.physique || '';
    els.pStudies.value = p.studies || '';
    els.pNotes.value = p.notes || '';
  }

  function profileFormValues() {
    return {
      name: (els.pName.value || '').trim(),
      age: els.pAge.value === '' ? '' : parseInt(els.pAge.value, 10),
      physique: (els.pPhysique.value || '').trim(),
      studies: (els.pStudies.value || '').trim(),
      notes: (els.pNotes.value || '').trim(),
    };
  }

  var profileSaveTimer = null;
  function queueProfileSave() {
    clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(saveProfile, 700);
  }

  async function saveProfile() {
    var vals = profileFormValues();
    try {
      var r = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vals),
      });
      var j = await r.json();
      if (j.ok) {
        STATE.profile = j.profile;
        toast('Profil enregistré');
      }
    } catch (_) {
      toast('Profil inaccessible — serveur éteint ?', true);
    }
  }

  async function loadProfile() {
    try {
      var r = await fetch('/api/profile');
      var j = await r.json();
      if (j.profile) {
        STATE.profile = j.profile;
        fillProfileForm(j.profile);
      }
    } catch (_) {}
  }

  /* -------------------------------------------------------- */
  /* Actions sur le Mac — carte de confirmation + exécution    */
  /* -------------------------------------------------------- */

  var MAC_LABELS = {
    open: 'Ouvrir',
    say: 'Faire parler le Mac',
    notification: 'Afficher une notification',
    volume: 'Régler le volume',
    brightness: 'Régler la luminosité',
    screenshot: 'Capture d\'écran',
    clipboard_set: 'Copier dans le presse-papiers',
    now: 'Lire l\'horloge',
    date: 'Lire la date',
    battery: 'État de la batterie',
    disk: 'Espace disque',
    ip: 'Adresse IP locale',
    uptime: 'Durée d\'allumage',
    clipboard: 'Lire le presse-papiers',
    weather: 'Météo',
    pulse: 'Ouvrir ton programme de sport',
    training_done: 'Valider la séance du jour',
  };

  var SKILL_LABELS = {
    now: 'heure',
    date: 'date',
    battery: 'batterie',
    disk: 'disque',
    ip: 'réseau',
    uptime: 'allumage',
    clipboard: 'presse-papiers',
    weather: 'météo',
    workout: 'séance du jour',
    workout_week: 'semaine de sport',
    workout_exercise: 'technique',
    training_stats: 'bilan sport',
  };

  /* Pastille verte sous la réponse : la donnée vient d'être lue sur le Mac. */
  function renderSkillBadge(wrap, info) {
    if (!wrap || !info) return;
    var old = wrap.querySelector('.skill-badge');
    if (old) old.remove();
    var b = document.createElement('div');
    b.className = 'skill-badge';
    b.title = 'Donnée réelle lue à l\u2019instant : ' + (info.output || '');
    var dot = document.createElement('span');
    dot.className = 'dot';
    b.appendChild(dot);
    var txt = document.createElement('span');
    txt.textContent = 'donnée réelle · ' + (SKILL_LABELS[info.skill] || info.skill);
    b.appendChild(txt);
    wrap.appendChild(b);
    scrollChat();
  }

  /* Carte de sport affichée sous la réponse : séance détaillée, semaine,
     bilan ou technique. La donnée vient du programme réel, jamais devinée. */
  function renderTrainingCard(wrap, info) {
    var d = info && info.data;
    if (!wrap || !d || !d.kind || d.kind === 'rest') return;
    var ancienne = wrap.querySelector('.sport-card');
    if (ancienne) ancienne.remove();
    var card = document.createElement('div');
    card.className = 'sport-card';

    if (d.kind === 'workout') {
      card.appendChild(spEl('div', 'sc-title', d.title));
      card.appendChild(spEl('div', 'sc-meta', d.dateLabel + ' · phase ' + d.phase +
        ' · semaine ' + d.week + ' sur ' + d.weeks + ' · ~' + d.estMinutes + ' min'));
      var liste = spEl('div', 'sc-list');
      (d.ex || []).forEach(function (e) {
        var row = spEl('div', 'sc-row' + (e.done ? ' done' : ''));
        row.appendChild(spEl('span', 'sc-name', e.n));
        var sets = e.reps ? e.s + '×' + e.reps : (e.secs ? e.s + '×' + e.secs + 's' : String(e.s));
        row.appendChild(spEl('span', 'sc-sets', sets + (e.rest ? ' · ' + e.rest + 's' : '')));
        liste.appendChild(row);
      });
      card.appendChild(liste);
      if (d.done) card.appendChild(spEl('div', 'sc-foot', 'Séance validée ✓'));
    } else if (d.kind === 'week') {
      card.appendChild(spEl('div', 'sc-meta', 'Semaine ' + d.week + ' · phase ' + d.phase +
        ' · ' + d.done + ' / ' + d.goal + ' séances'));
      var sem = spEl('div', 'sc-list');
      (d.days || []).forEach(function (day) {
        var row = spEl('div', 'sc-row' + (day.done ? ' done' : ''));
        row.appendChild(spEl('span', 'sc-name', String(day.label || '').slice(0, 3) + ' · ' + (day.type === 'rest' ? 'Repos' : day.title)));
        row.appendChild(spEl('span', 'sc-sets', day.done ? '✓' : (day.estMinutes ? day.estMinutes + ' min' : '')));
        sem.appendChild(row);
      });
      card.appendChild(sem);
    } else if (d.kind === 'stats') {
      var s = d.stats || {};
      card.appendChild(spEl('div', 'sc-meta', 'Ton bilan sport'));
      var grille = spEl('div', 'sc-grid');
      [[s.sessions, 'séances'], [s.streak, 'jours de série'], [s.minutes, 'minutes'], [s.xp, 'points'], [s.level, 'niveau']].forEach(function (c) {
        var cell = spEl('div', 'sc-stat');
        cell.appendChild(spEl('b', 'sc-num', String(c[0])));
        cell.appendChild(spEl('span', 'sc-lab', c[1]));
        grille.appendChild(cell);
      });
      card.appendChild(grille);
    } else if (d.kind === 'exercise') {
      (d.found || []).forEach(function (e) {
        card.appendChild(spEl('div', 'sc-title', e.n));
        card.appendChild(spEl('div', 'sc-meta', e.cue || ''));
        if (e.m) card.appendChild(spEl('div', 'sc-foot', e.m));
      });
    } else {
      return;
    }
    wrap.appendChild(card);
  }

  function actionLabel(a) { return MAC_LABELS[a] || a; }

  function renderActionCard(wrap, action, bubble) {
    if (!wrap) return;
    var holder = wrap.querySelector('.action-holder');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'action-holder';
      wrap.appendChild(holder);
    }
    holder.innerHTML = '';

    var card = document.createElement('div');
    card.className = 'action-card';
    var line = document.createElement('div');
    line.className = 'action-line';
    line.innerHTML = '<strong>' + escapeText(actionLabel(action.action)) + '</strong>' + (action.arg ? ' — ' + escapeText(action.arg) : '');
    var btns = document.createElement('div');
    btns.className = 'action-btns';
    var ok = document.createElement('button');
    ok.className = 'btn accent';
    ok.textContent = 'Autoriser';
    var no = document.createElement('button');
    no.className = 'btn ghost';
    no.textContent = 'Ignorer';
    btns.appendChild(ok);
    btns.appendChild(no);
    card.appendChild(line);
    card.appendChild(btns);
    holder.appendChild(card);
    scrollChat();

    ok.addEventListener('click', function () {
      card.remove();
      runMacAction(action, holder);
    });
    no.addEventListener('click', function () {
      card.remove();
      var res = document.createElement('div');
      res.className = 'action-result';
      res.textContent = 'Action ignorée.';
      holder.appendChild(res);
    });
  }

  async function runMacAction(action, holder) {
    try {
      var r = await fetch('/api/mac/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      var j = await r.json();
      applyActionResult(holder, j);
    } catch (e) {
      applyActionResult(holder, { ok: false, error: 'Serveur inaccessible' });
    }
  }

  function applyActionResult(anchor, result) {
    if (!anchor) return;
    var holder = anchor.classList && anchor.classList.contains('action-holder') ? anchor : anchor.querySelector('.action-holder');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'action-holder';
      anchor.appendChild(holder);
    }
    var old = holder.querySelector('.action-result');
    if (old) old.remove();
    var res = document.createElement('div');
    res.className = 'action-result ' + (result && result.ok ? 'ok' : 'err');
    res.textContent = result && result.ok ? '✓ ' + (result.output || 'Fait.') : '✗ ' + (result && result.error ? result.error : 'Échec');
    holder.appendChild(res);
    if (result && result.ok && result.output && settings.autoTts && !STATE.ttsMuted) speakUtterance(result.output);
    /* Une action de sport vient de changer la progression : le panneau
       ouvert doit se remettre à jour, sinon il ment sur l'état réel. */
    if (result && result.ok && els.backdrop && !els.backdrop.hidden) refreshSportPanel(SPORT.offset);
    scrollChat();
  }

  /* -------------------------------------------------------- */
  /* Sport — programme Pulse (lecture + suivi)                 */
  /* Le programme est lu par le serveur dans le fichier Pulse ; */
  /* ce panneau ne fait que l'afficher et cocher les séances.   */
  /* -------------------------------------------------------- */

  var SPORT = { data: null, offset: 0, loaded: false };

  function sportHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h['X-Nova-Key'] = settings.apiKey;
    return h;
  }

  function sportGet(query) {
    return fetch('/api/training' + (query || ''), { headers: sportHeaders() }).then(function (r) { return r.json(); });
  }

  function sportPost(path, body) {
    return fetch(path, { method: 'POST', headers: sportHeaders(), body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  }

  function spEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* « 2026-09-15 » → « 15 sept. » — sans passer par Date("ISO") qui
     interprète en UTC et décale la date d'un jour à l'ouest de Greenwich. */
  function frShortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return iso || '';
    try {
      return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    } catch (_) { return iso; }
  }

  function renderSportToday(d) {
    var box = els.sportToday;
    if (!box) return;
    box.innerHTML = '';
    var t = d && d.today;
    if (!t || !t.ok) {
      box.appendChild(spEl('div', 'sport-empty', (d && d.plan && d.plan.error) || 'Programme introuvable.'));
      return;
    }
    var head = spEl('div', 'sp-head');
    head.appendChild(spEl('div', 'sp-title', t.title));
    head.appendChild(spEl('div', 'sp-meta', t.type === 'rest'
      ? 'jour de repos'
      : 'phase ' + t.phase.name + ' · semaine ' + (t.week + 1) + ' sur ' + t.programWeeks + ' · ~' + t.estMinutes + ' min'));
    box.appendChild(head);
    if (t.focus && t.focus.length) box.appendChild(spEl('div', 'sp-focus', t.focus.join(' · ')));
    if (t.ex && t.ex.length) {
      var liste = spEl('div', 'sp-list');
      t.ex.forEach(function (e, i) {
        var row = spEl('div', 'sp-row' + (e.done ? ' done' : ''));
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!e.done;
        cb.setAttribute('aria-label', 'Marquer « ' + e.n + ' » comme fait');
        cb.addEventListener('change', function () {
          sportPost('/api/training/done', { date: t.dateISO, index: i, value: cb.checked }).then(function (j) {
            if (j && j.ok) { SPORT.data = j; sportRender(); }
          });
        });
        row.appendChild(cb);
        var corps = spEl('div', 'sp-body');
        corps.appendChild(spEl('div', 'sp-name', e.n + (e.note ? ' ' + e.note : '')));
        var sets = e.reps ? e.s + ' × ' + e.reps : (e.secs ? e.s + ' × ' + e.secs + ' s' : e.s + ' séries');
        corps.appendChild(spEl('div', 'sp-sets', sets + (e.rest ? ' · repos ' + e.rest + ' s' : '') + (e.m ? ' · ' + e.m : '')));
        if (e.cue) corps.appendChild(spEl('div', 'sp-cue', e.cue));
        row.appendChild(corps);
        liste.appendChild(row);
      });
      box.appendChild(liste);
    }
    var pied = spEl('div', 'sp-foot');
    if (t.type === 'rest') {
      pied.appendChild(spEl('span', 'sp-state', 'Rien à valider — priorité sommeil.'));
    } else {
      var b = document.createElement('button');
      b.className = 'btn ' + (t.done ? 'ghost' : 'accent');
      b.textContent = t.done ? 'Validée ✓ — annuler' : 'Marquer la séance terminée';
      b.addEventListener('click', function () {
        sportPost('/api/training/done', { date: t.dateISO, done: !t.done }).then(function (j) {
          if (j && j.ok) { SPORT.data = j; sportRender(); }
        });
      });
      pied.appendChild(b);
      /* Le serveur nomme ce compteur doneCount : lire « exDone » affichait
         toujours 0 alors que les cases, elles, étaient bien cochées. */
      var coches = t.doneCount === undefined ? 0 : t.doneCount;
      pied.appendChild(spEl('span', 'sp-state', t.done
        ? 'séance validée'
        : coches + ' / ' + t.ex.length + ' exercices cochés'));
    }
    box.appendChild(pied);
  }

  function renderSportWeek(d) {
    var box = els.sportWeek;
    if (!box) return;
    box.innerHTML = '';
    var w = d && d.week;
    if (!w || !w.ok) { box.appendChild(spEl('div', 'sport-empty', '—')); return; }
    box.appendChild(spEl('div', 'sp-meta', 'Semaine ' + (w.week + 1) + ' · phase ' + w.phase.name +
      ' · ' + w.doneCount + ' / ' + w.goal + ' séances'));
    w.days.forEach(function (day) {
      var row = spEl('div', 'sp-day' + (day.isToday ? ' today' : '') + (day.done ? ' done' : ''));
      row.appendChild(spEl('span', 'sp-day-label', String(day.label || '').slice(0, 3)));
      row.appendChild(spEl('span', 'sp-day-title', day.type === 'rest' ? 'Repos' : day.title));
      row.appendChild(spEl('span', 'sp-day-state', day.done ? '✓' : (day.isPast ? '·' : '')));
      box.appendChild(row);
    });
    if (w.days.length === 7) {
      box.appendChild(spEl('div', 'sp-range', 'du ' + frShortDate(w.days[0].dateISO) + ' au ' + frShortDate(w.days[6].dateISO)));
    }
  }

  function renderSportStats(d) {
    var box = els.sportStats;
    if (!box) return;
    box.innerHTML = '';
    var s = d && d.stats;
    if (!s) { box.appendChild(spEl('div', 'sport-empty', '—')); return; }
    var grille = spEl('div', 'sp-grid');
    var cases = [
      [s.sessions, 'séances'],
      [s.streak, 'jours de série'],
      [s.minutes, 'minutes'],
      [s.weekDone + '/' + s.weekGoal, 'cette semaine'],
      [s.xp, 'points'],
      [s.level, 'niveau'],
    ];
    cases.forEach(function (c) {
      var cell = spEl('div', 'sp-stat');
      cell.appendChild(spEl('b', 'sp-num', String(c[0])));
      cell.appendChild(spEl('span', 'sp-lab', c[1]));
      grille.appendChild(cell);
    });
    box.appendChild(grille);
    box.appendChild(spEl('p', 'sp-help', 'Début du programme : ' + frShortDate(s.start) +
      ' · semaine ' + (s.week + 1) + ' sur ' + s.programWeeks + ' (phase ' + s.phase.name + ')' +
      (s.bestWeek ? ' · meilleure semaine : ' + s.bestWeek + ' séances' : '')));
  }

  function sportRender() {
    var d = SPORT.data;
    if (!d || d.ok === false) return;
    if (els.sportErr) {
      var manquant = d.plan && !d.plan.found;
      els.sportErr.hidden = !manquant;
      els.sportErr.textContent = manquant ? ((d.plan && d.plan.error) || 'Programme introuvable.') : '';
    }
    renderSportToday(d);
    renderSportWeek(d);
    renderSportStats(d);
  }

  function refreshSportPanel(offset) {
    if (typeof offset === 'number') SPORT.offset = offset;
    return sportGet('?week=' + SPORT.offset).then(function (j) {
      SPORT.data = j;
      SPORT.loaded = true;
      if (els.sportPath && document.activeElement !== els.sportPath) {
        els.sportPath.value = (j.config && j.config.planPath) || (j.plan && j.plan.path) || '';
      }
      if (els.sportStart && document.activeElement !== els.sportStart) {
        els.sportStart.value = (j.config && j.config.start) || '';
      }
      sportRender();
      return j;
    }).catch(function () {
      if (els.sportToday) els.sportToday.innerHTML = '<div class="sport-empty">Serveur injoignable.</div>';
    });
  }

  /* Après une écriture (config, import) : le serveur renvoie l'état complet. */
  function sportAfterWrite(j) {
    if (!j || j.error) { toast((j && j.error) || 'Erreur', true); return; }
    SPORT.data = j;
    if (els.sportPath) els.sportPath.value = (j.config && j.config.planPath) || '';
    if (els.sportStart) els.sportStart.value = (j.config && j.config.start) || '';
    sportRender();
    if (j.message) toast(j.message);
  }

  /* « Nova, séance terminée » — commande instantanée, sans passer par le modèle. */
  function markTrainingDoneVoice() {
    sportGet('').then(function (j) {
      var t = j && j.today;
      if (!t || !t.ok) {
        novaSay('Nova, séance terminée', "Je n'ai pas trouvé ton programme de sport : vérifie le chemin du fichier Pulse dans les réglages, onglet Sport.");
        return;
      }
      if (t.type === 'rest') {
        novaSay('Nova, séance terminée', "Aujourd'hui c'est jour de repos : rien à valider, profite bien.");
        return;
      }
      var deja = !!t.done;
      sportPost('/api/training/done', { date: t.dateISO, done: true }).then(function (k) {
        if (k && k.ok) { SPORT.data = k; if (SPORT.loaded && els.backdrop && !els.backdrop.hidden) sportRender(); }
        var s = (k && k.stats) || {};
        var msg = deja
          ? 'Ta séance « ' + t.title + ' » était déjà validée.'
          : 'Bien joué ! Séance « ' + t.title + ' » validée : ' + ((t.ex && t.ex.length) || 0) + ' exercices. ';
        if (!deja && s.sessions) {
          msg += s.sessions + ' séance' + (s.sessions > 1 ? 's' : '') + ' au total depuis le début, série de ' + s.streak + ' jour' + (s.streak > 1 ? 's' : '') + '.';
        }
        novaSay('Nova, séance terminée', msg);
      }).catch(function () {
        novaSay('Nova, séance terminée', 'Je n\u2019ai pas réussi à enregistrer la séance : le serveur ne répond pas.');
      });
    }).catch(function () {
      novaSay('Nova, séance terminée', 'Le serveur ne répond pas, je ne peux pas valider la séance.');
    });
  }

  (function wireSport() {
    var enregistrer = document.getElementById('btn-sport-path');
    if (enregistrer) enregistrer.addEventListener('click', function () {
      sportPost('/api/training/config', { planPath: els.sportPath ? els.sportPath.value.trim() : '' }).then(sportAfterWrite);
    });
    var detecter = document.getElementById('btn-sport-detect');
    if (detecter) detecter.addEventListener('click', function () {
      /* Chemin vidé : le serveur re-cherche le fichier Pulse lui-même. */
      sportPost('/api/training/config', { planPath: '' }).then(sportAfterWrite);
    });
    var ouvrir = document.getElementById('btn-sport-open');
    if (ouvrir) ouvrir.addEventListener('click', function () {
      fetch('/api/mac/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pulse', arg: '' }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        toast(j && j.ok ? 'Pulse ouvert' : ((j && j.error) || 'Ouverture impossible'), !(j && j.ok));
      }).catch(function () { toast('Serveur injoignable', true); });
    });
    if (els.sportStart) els.sportStart.addEventListener('change', function () {
      sportPost('/api/training/config', { start: els.sportStart.value }).then(sportAfterWrite);
    });
    var prev = document.getElementById('btn-sport-prev');
    if (prev) prev.addEventListener('click', function () { refreshSportPanel(SPORT.offset - 1); });
    var now = document.getElementById('btn-sport-now');
    if (now) now.addEventListener('click', function () { refreshSportPanel(0); });
    var next = document.getElementById('btn-sport-next');
    if (next) next.addEventListener('click', function () { refreshSportPanel(SPORT.offset + 1); });

    var importer = document.getElementById('btn-sport-import');
    var fichier = document.getElementById('sport-import-file');
    if (importer && fichier) {
      importer.addEventListener('click', function () { fichier.click(); });
      fichier.addEventListener('change', function () {
        var f = fichier.files && fichier.files[0];
        if (!f) return;
        var lecteur = new FileReader();
        lecteur.onload = function () {
          sportPost('/api/training/import', { content: String(lecteur.result || '') })
            .then(sportAfterWrite)['catch'](function () { toast('Import impossible', true); });
        };
        lecteur.readAsText(f);
        fichier.value = '';
      });
    }

    var reset = document.getElementById('btn-sport-reset');
    if (reset) reset.addEventListener('click', function () {
      if (!reset._confirm) {
        reset._confirm = true;
        reset.textContent = 'Sûr ? Clique encore';
        setTimeout(function () { reset._confirm = false; reset.textContent = 'Réinitialiser ma progression'; }, 4000);
        return;
      }
      reset._confirm = false;
      reset.textContent = 'Réinitialiser ma progression';
      sportPost('/api/training/reset', { keepConfig: true }).then(function (j) {
        sportAfterWrite(j);
        toast('Progression sport effacée');
      });
    });
  })();

  /* -------------------------------------------------------- */
  /* Réglages                                                  */
  /* -------------------------------------------------------- */

  /* -------------------------------------------------------- */
  /* Onglets des réglages                                      */
  /* Chaque domaine vit dans sa propre section : général (clé,  */
  /* modèle, apparence), voix, compétences, profil, mémoire et  */
  /* diagnostic. L'onglet ouvert est mémorisé.                  */
  /* -------------------------------------------------------- */

  var SET_TABS = ['general', 'voix', 'sport', 'skills', 'profil', 'memoire', 'historique', 'diagnostic'];

  function setSettingsTab(name) {
    var cible = SET_TABS.indexOf(name) === -1 ? 'general' : name;
    var tabs = document.querySelectorAll('.set-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', tabs[i].getAttribute('data-tab') === cible ? 'true' : 'false');
    }
    var panes = document.querySelectorAll('.set-pane');
    for (var j = 0; j < panes.length; j++) {
      panes[j].hidden = panes[j].getAttribute('data-pane') !== cible;
    }
    settings.lastTab = cible;
    persist();
    /* On change de sujet : le corps de la modale revient en haut. */
    var body = els.backdrop ? els.backdrop.querySelector('.modal-body') : null;
    if (body) body.scrollTop = 0;
  }

  (function wireSettingsTabs() {
    var tabs = document.querySelectorAll('.set-tab');
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        setSettingsTab(this.getAttribute('data-tab'));
      });
      /* Flèches gauche/droite : navigation attendue d'un jeu d'onglets */
      tabs[i].addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        var pas = e.key === 'ArrowRight' ? 1 : -1;
        var courant = SET_TABS.indexOf(setTabCourant());
        var suivant = (courant + pas + SET_TABS.length) % SET_TABS.length;
        setSettingsTab(SET_TABS[suivant]);
        var cible = document.querySelector('.set-tab[data-tab="' + SET_TABS[suivant] + '"]');
        if (cible) cible.focus();
        e.preventDefault();
      });
    }
  })();

  function setTabCourant() {
    var actif = document.querySelector('.set-tab[aria-selected="true"]');
    return actif ? actif.getAttribute('data-tab') : 'general';
  }

  function openSettings(tab) {
    els.backdrop.hidden = false;
    requestAnimationFrame(function () { els.backdrop.classList.add('show'); });
    /* Un clic sur ⚙️ passe un Event, pas un nom d'onglet. */
    setSettingsTab(typeof tab === 'string' ? tab : (settings.lastTab || 'general'));
    els.keyInput.value = settings.apiKey || '';
    els.keyOk.hidden = !settings.apiKey;
    els.keyErr.hidden = true;
    els.rate.value = settings.rate;
    els.pitch.value = settings.pitch;
    els.rateVal.textContent = Number(settings.rate).toFixed(2).replace(/0$/, '') + '×';
    els.pitchVal.textContent = Number(settings.pitch).toFixed(2);
    els.autoTts.checked = settings.autoTts;
    els.convMode.checked = !!settings.convMode;
    els.vadSens.value = settings.vadSens;
    els.vadSensVal.textContent = sensLabel(settings.vadSens);
    if (els.themeMode) els.themeMode.value = settings.theme || 'auto';
    if (els.macControl) els.macControl.checked = settings.macControl !== false;
    if (els.wakeWord) els.wakeWord.checked = !!settings.wakeWord;
    if (els.wakeStay) els.wakeStay.value = wakeStayMs() / 1000;
    if (els.wakeStayVal) els.wakeStayVal.textContent = wakeStayMs() / 1000 + ' s';
    if (els.wakeHelp && window.NovaWake) {
      var eng = window.NovaWake.mode === 'speech'
        ? 'la reconnaissance vocale du navigateur'
        : 'la transcription Whisper via Groq';
      els.wakeHelp.textContent =
        'Nova reste en veille, silencieuse, et n\u2019ouvre le micro qu\u2019en entendant son nom — ' +
        'puis elle se remet en veille après ta réponse. Exclusif avec la conversation naturelle. ' +
        'Moteur utilisé : ' + eng + '.';
    }
    fillProfileForm(STATE.profile);
    loadProfile();
    refreshMemPanel();
    refreshHistoryPanel();
    refreshSportPanel(SPORT.offset);
    loadServerStatus();
    loadModels();
  }

  function closeSettings() {
    els.backdrop.classList.remove('show');
    setTimeout(function () { els.backdrop.hidden = true; }, 260);
  }

  async function loadServerStatus() {
    try {
      var r = await fetch('/api/status');
      var j = await r.json();
      if (j.hasKey && !settings.apiKey) {
        els.keyOk.hidden = false;
        els.keyOk.textContent = '✓ Clé détectée côté serveur (.env) — Nova est pleinement active.';
      }
    } catch (_) {}
  }

  async function loadModels() {
    els.modelSelect.innerHTML = '<option value="">Chargement…</option>';
    try {
      var r = await fetch('/api/models');
      var j = await r.json();
      var models = j.models || [];
      els.modelSelect.innerHTML = '';
      /* Groupes : modèles locaux d'abord (Ollama / LM Studio détectés),
         puis Groq. Le regroupement suit le préfixe local-…/… posé par le
         serveur — un jour un autre fournisseur = un autre préfixe. */
      var groups = {};
      var order = [];
      models.forEach(function (m) {
        var g = 'Groq';
        if (/^local-ollama\//.test(m.id)) g = 'Ollama (local)';
        else if (/^local-lmstudio\//.test(m.id)) g = 'LM Studio (local)';
        else if (/^local-/.test(m.id)) g = 'Local';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(m);
      });
      order.forEach(function (g) {
        if (order.length > 1) {
          var og = document.createElement('optgroup');
          og.label = g;
          groups[g].forEach(function (m) {
            var o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.label || m.id;
            og.appendChild(o);
          });
          els.modelSelect.appendChild(og);
        } else {
          groups[g].forEach(function (m) {
            var o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.label || m.id;
            els.modelSelect.appendChild(o);
          });
        }
      });
      if (order.indexOf('Ollama (local)') !== -1 || order.indexOf('LM Studio (local)') !== -1) {
        toast('Modèles locaux détectés (Ollama / LM Studio) — ils apparaissent en tête du sélecteur.');
      }
      if (settings.model) {
        els.modelSelect.value = settings.model;
        if (els.modelSelect.selectedIndex === -1 && models.length) {
          // Le modèle enregistré n'existe pas sur ce compte → on prend le premier dispo
          var old = settings.model;
          settings.model = models[0].id;
          els.modelSelect.value = settings.model;
          persist();
          toast('Modèle ajusté : ' + settings.model + ' (« ' + old + ' » absent de ce compte Groq)');
        }
      } else if (models.length) {
        settings.model = models[0].id;
        els.modelSelect.value = settings.model;
        persist();
      }
    } catch (_) {
      els.modelSelect.innerHTML = '<option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>';
    }
  }

  /* -------------------------------------------------------- */
  /* Diagnostic — état réel de Nova, côté serveur et côté Mac  */
  /* -------------------------------------------------------- */

  async function micPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        var st = await navigator.permissions.query({ name: 'microphone' });
        if (st && st.state) return st.state;
      }
    } catch (_) {}
    return 'inconnu';
  }

  async function collectDiag() {
    var srv = null;
    try {
      var r = await fetch('/api/diag');
      srv = await r.json();
    } catch (e) {
      srv = { error: (e && e.message) || 'injoignable' };
    }
    var perm = await micPermission();
    var permFr = { granted: '✓ autorisé', denied: '✗ refusé', prompt: 'à autoriser', inconnu: 'inconnu' }[perm] || perm;
    var keyOk = !!(srv.groq && srv.groq.keyConfigured) || !!settings.apiKey;
    var wakeMode = (window.NovaWake && window.NovaWake.mode === 'speech')
      ? 'reconnaissance du navigateur'
      : 'Whisper (Groq)';

    var sections = [
      { head: 'Serveur', rows: [
        srv.server
          ? [srv.server.host + ' · ' + srv.server.platform, 'en ligne', 'd-ok']
          : ['Serveur local', '✗ ' + (srv.error || 'injoignable'), 'd-bad'],
        srv.server ? ['Node', srv.server.node] : null,
        srv.server ? ['Adresse', 'http://localhost:' + srv.server.port] : null,
        srv.server ? ['Uptime', srv.server.uptime + ' s'] : null,
      ] },
      { head: 'Groq', rows: [
        ['Clé API', keyOk ? '✓ ' + ((srv.groq && srv.groq.keySource) || 'réglages') : '✗ absente — mode démo', keyOk ? 'd-ok' : 'd-bad'],
        ['Modèle', settings.model || (srv.groq && srv.groq.model) || '—'],
        ['Transcription', (srv.groq && srv.groq.sttModel) || '—'],
        ['Réponses max', srv.groq ? srv.groq.maxTokens + ' jetons' : '—'],
      ] },
      { head: 'Voix et micro', rows: [
        ['Micro (permission)', permFr, perm === 'granted' ? 'd-ok' : (perm === 'denied' ? 'd-bad' : '')],
        ['Micro actif', STATE.listening ? 'oui, j\u2019écoute' : 'non'],
        ['Synthèse vocale', ('speechSynthesis' in window) ? '✓ disponible' : '✗ indisponible', ('speechSynthesis' in window) ? 'd-ok' : 'd-bad'],
        ['Voix françaises', voices.length ? voices.length + ' (' + voices[0].name + '…)' : 'aucune'],
        ['Voix choisie', currentVoice() ? currentVoice().name : 'celle par défaut de macOS'],
        ['Vitesse', fmtRate(settings.rate) + ' · hauteur ' + Number(settings.pitch).toFixed(2)],
        ['Lecture auto', settings.autoTts ? 'activée' : 'désactivée'],
        ['Voix coupée', STATE.ttsMuted ? 'oui (sourdine)' : 'non'],
      ] },
      { head: 'Veille et conversation', rows: [
        ['Mot d\u2019activation', WAKE.armed ? '✓ armed — en veille' : (settings.wakeWord ? 'réglé mais inactif' : 'désactivé')],
        ['Moteur de veille', wakeMode],
        ['Réveil resté actif', Math.round(wakeStayMs() / 1000) + ' s'],
        ['Conversation naturelle', CONV.active ? (CONV.running ? 'active, micro ouvert' : 'active') : 'désactivée'],
        ['Minuteurs en cours', timers.length ? String(timers.length) : 'aucun'],
        ['Notifications', !window.Notification ? 'indisponibles' : ('permission ' + Notification.permission)],
      ] },
      { head: 'Mémoire et données', rows: srv.data ? [
        ['Dossier', srv.data.dir],
        ['Inscriptible', srv.data.writable ? '✓ oui' : '✗ non — ' + (srv.data.error || 'erreur'), srv.data.writable ? 'd-ok' : 'd-bad'],
        ['Conversations gardées', String(srv.data.sessions) + ' (' + srv.data.turns + ' échanges)'],
        ['Session courante', STATE.sessionId ? String(STATE.sessionId).slice(0, 12) + '…' : 'aucune'],
        ['Profil enregistré', srv.data.profileSaved ? '✓ ' + (srv.data.profileName || 'sans nom') : '✗ pas encore'],
      ] : [['Mémoire', 'non vérifiée']] },
      { head: 'Sandbox du Mac', rows: srv.mac ? [
        ['État', srv.mac.enabled ? '✓ autorisée' : '✗ désactivée (MAC_CONTROL=off)', srv.mac.enabled ? 'd-ok' : 'd-bad'],
        ['Actions confirmées', String(srv.mac.actions.filter(function (a) { return srv.mac.readonly.indexOf(a) === -1; }).length)],
        ['Lectures directes', srv.mac.readonly.join(', ')],
        ['Captures d\u2019écran', srv.mac.screenshotDir],
      ] : [['Sandbox', 'non vérifiée']] },
      { head: 'Interface', rows: [
        ['Thème', settings.theme + ' → ' + effectiveTheme()],
        ['Stockage local', (function () { try { localStorage.setItem('nova.test', '1'); localStorage.removeItem('nova.test'); return '✓ disponible'; } catch (_) { return '✗ bloqué'; } })()],
        ['Écran', window.innerWidth + '×' + window.innerHeight],
      ] },
    ];
    return sections;
  }

  function diagToText(sections) {
    var out = ['Nova — diagnostic', new Date().toLocaleString('fr-FR'), ''];
    sections.forEach(function (s) {
      out.push('[' + s.head + ']');
      s.rows.forEach(function (r) {
        if (!r) return;
        out.push('  ' + r[0] + ' : ' + r[1]);
      });
      out.push('');
    });
    return out.join('\n');
  }

  function renderDiag(sections) {
    var out = els.diagOut;
    out.innerHTML = '';
    sections.forEach(function (s) {
      var h = document.createElement('span');
      h.className = 'd-head';
      h.textContent = s.head;
      out.appendChild(h);
      s.rows.forEach(function (r) {
        if (!r) return;
        var row = document.createElement('div');
        row.className = 'd-row';
        var a = document.createElement('span');
        a.textContent = r[0];
        var b = document.createElement('span');
        b.textContent = r[1];
        if (r[2]) b.className = r[2];
        row.appendChild(a);
        row.appendChild(b);
        out.appendChild(row);
      });
    });
  }

  var diagText = '';

  async function runDiag() {
    if (!els.diagOut) return;
    els.diagOut.hidden = false;
    els.diagOut.textContent = 'Diagnostic en cours…';
    if (els.diagCopy) els.diagCopy.hidden = false;
    try {
      var sections = await collectDiag();
      renderDiag(sections);
      diagText = diagToText(sections);
    } catch (e) {
      els.diagOut.textContent = 'Diagnostic impossible : ' + ((e && e.message) || e);
    }
  }

  function copyDiag() {
    if (!diagText) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(diagText);
      } else {
        var ta = document.createElement('textarea');
        ta.value = diagText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('Diagnostic copié');
    } catch (_) {
      toast('Copie impossible', true);
    }
  }

  els.saveKey.addEventListener('click', function () {
    var k = els.keyInput.value.trim();
    if (!k) {
      settings.apiKey = '';
      persist();
      els.keyOk.hidden = true;
      els.keyErr.hidden = false;
      els.keyErr.textContent = 'Clé effacée — mode démo actif.';
      return;
    }
    if (!/^gsk_[A-Za-z0-9]{20,}$/.test(k)) {
      els.keyErr.hidden = false;
      els.keyErr.textContent = 'Format inattendu : une clé Groq commence par « gsk_ ». Enregistrée quand même — teste avec une question.';
      els.keyOk.hidden = true;
      settings.apiKey = k;
      persist();
      return;
    }
    settings.apiKey = k;
    persist();
    els.keyErr.hidden = true;
    els.keyOk.hidden = false;
    els.keyOk.textContent = '✓ Clé enregistrée — Nova est pleinement active.';
    toast('Clé enregistrée ✓');
    loadModels();
  });

  els.keyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') els.saveKey.click();
  });

  els.refreshModels.addEventListener('click', loadModels);
  if (els.diag) els.diag.addEventListener('click', runDiag);
  if (els.diagCopy) els.diagCopy.addEventListener('click', copyDiag);

  els.modelSelect.addEventListener('change', function () {
    settings.model = els.modelSelect.value;
    persist();
  });

  els.voiceSelect.addEventListener('change', function () {
    settings.voiceURI = els.voiceSelect.value;
    persist();
    speakUtterance('Voilà ma nouvelle voix. Qu\u2019est-ce qu\u2019on fait maintenant ?');
  });

  els.testVoice.addEventListener('click', function () {
    speakUtterance('Bonjour ! Je suis Nova, ton assistante vocale. Cette voix te convient-elle ?');
  });

  els.rate.addEventListener('input', function () {
    settings.rate = parseFloat(els.rate.value);
    els.rateVal.textContent = settings.rate.toFixed(2).replace(/0$/, '') + '×';
    persist();
  });

  els.pitch.addEventListener('input', function () {
    settings.pitch = parseFloat(els.pitch.value);
    els.pitchVal.textContent = settings.pitch.toFixed(2);
    persist();
  });

  els.autoTts.addEventListener('change', function () {
    settings.autoTts = els.autoTts.checked;
    persist();
  });

  els.settings.addEventListener('click', openSettings);

  /* Catalogue des compétences : chaque exemple est cliquable. On le dépose
     dans la zone de saisie sans l'envoyer — certains exemples déclenchent
     une action sur le Mac, à toi de valider d'abord. */
  (function wireSkillItems() {
    var items = document.querySelectorAll('.skill-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var ask = this.getAttribute('data-ask') || '';
        if (!ask) return;
        els.input.value = ask;
        els.input.dispatchEvent(new Event('input', { bubbles: true }));
        closeSettings();
        toast('Exemple prêt — appuie sur Entrée');
        setTimeout(function () { try { els.input.focus(); } catch (_) {} }, 140);
      });
    }
  })();

  /* « Qu'a-t-elle retenu ? » depuis les sections Profil et Mémoire */
  function recapFromSettings() {
    closeSettings();
    speakRecap();
  }
  if (els.recapProfile) els.recapProfile.addEventListener('click', recapFromSettings);
  if (els.recapMem) els.recapMem.addEventListener('click', recapFromSettings);
  els.closeSettings.addEventListener('click', closeSettings);
  els.backdrop.addEventListener('click', function (e) {
    if (e.target === els.backdrop) closeSettings();
  });

  /* Thème : bouton de cycle + select des réglages + suivi macOS */
  if (els.themeBtn) els.themeBtn.addEventListener('click', cycleTheme);
  if (els.themeMode) {
    els.themeMode.addEventListener('change', function () {
      settings.theme = els.themeMode.value;
      persist();
      applyTheme();
    });
  }
  try {
    mqlLight.addEventListener('change', applyTheme);
  } catch (_) {
    if (mqlLight.addListener) mqlLight.addListener(applyTheme); // vieux Safari
  }

  /* Mot d'activation : bouton Nova + réglages */
  if (els.wakeBtn) {
    els.wakeBtn.addEventListener('click', function () {
      settings.wakeWord = !settings.wakeWord;
      persist();
      if (settings.wakeWord) {
        /* Exclusif avec la conversation permanente : la veille suffit */
        settings.convMode = false;
        if (els.convMode) els.convMode.checked = false;
        if (CONV.running) stopConv();
        armWake();
      } else {
        disarmWake();
        toast('Mot d\u2019activation désactivé');
      }
      if (els.wakeWord) els.wakeWord.checked = !!settings.wakeWord;
    });
  }
  if (els.wakeWord) {
    els.wakeWord.addEventListener('change', function () {
      settings.wakeWord = els.wakeWord.checked;
      persist();
      if (settings.wakeWord) {
        settings.convMode = false;
        if (els.convMode) els.convMode.checked = false;
        if (CONV.running) stopConv();
        armWake();
      } else {
        disarmWake();
      }
    });
  }
  if (els.wakeStay) {
    els.wakeStay.addEventListener('input', function () {
      settings.wakeStay = parseInt(els.wakeStay.value, 10) || 12;
      if (els.wakeStayVal) els.wakeStayVal.textContent = settings.wakeStay + ' s';
      persist();
      if (WAKE.armed && CONV.running) scheduleReSleep();
    });
  }

  /* Profil : sauvegarde automatique à la frappe (avec débounce) */
  ;[els.pName, els.pAge, els.pPhysique, els.pStudies, els.pNotes].forEach(function (inp) {
    if (!inp) return;
    inp.addEventListener('input', queueProfileSave);
  });

  /* Toggle compétences Mac (client : refuse les cartes si décoché) */
  if (els.macControl) {
    els.macControl.addEventListener('change', function () {
      settings.macControl = els.macControl.checked;
      persist();
    });
  }

  var refreshMemBtn = document.getElementById('btn-refresh-mem');
  var forgetAllBtn = document.getElementById('btn-forget-all');
  if (refreshMemBtn) refreshMemBtn.addEventListener('click', refreshMemPanel);
  var histSearch = document.getElementById('hist-search');
  if (histSearch) histSearch.addEventListener('input', function () { refreshHistoryPanel(histSearch.value); });
  var refreshHistBtn = document.getElementById('btn-refresh-hist');
  if (refreshHistBtn) refreshHistBtn.addEventListener('click', function () { refreshHistoryPanel(histSearch ? histSearch.value : ''); });
  if (forgetAllBtn) {
    forgetAllBtn.addEventListener('click', function () {
      if (forgetAllBtn._confirm) {
        forgetAllBtn._confirm = false;
        forgetAllBtn.textContent = 'Tout oublier';
        forgetAllMemory(false);
        closeSettings();
      } else {
        forgetAllBtn._confirm = true;
        forgetAllBtn.textContent = 'Sûr ? Clique encore';
        setTimeout(function () {
          forgetAllBtn._confirm = false;
          forgetAllBtn.textContent = 'Tout oublier';
        }, 3500);
      }
    });
  }

  /* -------------------------------------------------------- */
  /* Contrôles principaux                                      */
  /* -------------------------------------------------------- */

  els.send.addEventListener('click', function () {
    var v = els.input.value;
    els.input.value = '';
    autosize();
    sendMessage(v);
    els.input.focus();
  });

  els.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var v = els.input.value;
      els.input.value = '';
      autosize();
      sendMessage(v);
    }
  });

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(132, els.input.scrollHeight) + 'px';
  }
  els.input.addEventListener('input', autosize);

  /* Push-to-talk : maintenir le bouton ou la barre espace */
  function micDown(e) {
    if (STATE.busy) { stopSpeaking(); }
    e.preventDefault();
    startListening();
  }
  function micUp(e) {
    e.preventDefault();
    stopListening(false);
  }

  els.mic.addEventListener('pointerdown', function (e) {
    // En mode conversation : le bouton micro sert d'interrupteur pause/reprise
    if (CONV.running) {
      e.preventDefault();
      stopConv();
      toast('Conversation en pause — bouton ⚡ ou micro pour reprendre');
      return;
    }
    micDown(e);
  });
  els.mic.addEventListener('pointerup', micUp);
  els.mic.addEventListener('pointerleave', function (e) {
    if (STATE.listening && e.buttons && !CONV.running) micUp(e);
  });
  els.mic.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var spaceDown = false;
  document.addEventListener('keydown', function (e) {
    var typing = document.activeElement === els.input ||
                 document.activeElement === els.keyInput ||
                 document.activeElement && document.activeElement.tagName === 'SELECT';

    if (e.code === 'Space' && !typing && !e.repeat && !spaceDown) {
      spaceDown = true;
      micDown(e);
    }
    if (e.key === 'Escape') {
      if (!els.backdrop.hidden) closeSettings();
      else if (STATE.listening) stopListening(true);
      else if (CONV.running) { stopConv(); toast('Conversation en pause'); }
      else stopSpeaking();
    }
    if (e.code === 'KeyC' && !typing && !e.repeat && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      els.convBtn.click();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && spaceDown) {
      spaceDown = false;
      if (STATE.listening) micUp(e);
    }
  });

  els.tts.addEventListener('click', function () {
    STATE.ttsMuted = !STATE.ttsMuted;
    els.tts.classList.toggle('muted', STATE.ttsMuted);
    if (STATE.ttsMuted) stopSpeaking();
    toast(STATE.ttsMuted ? 'Voix coupée' : 'Voix activée');
  });

  /* -------- Mode conversation naturelle -------- */

  els.convBtn.addEventListener('click', function () {
    if (CONV.running) {
      stopConv();
      toast('Conversation naturelle coupée');
    } else {
      startConv().then(function () {
        if (CONV.running) toast('Conversation naturelle active — parle quand tu veux');
      });
    }
  });

  els.convMode.addEventListener('change', function () {
    settings.convMode = els.convMode.checked;
    /* Exclusif avec le mot d'activation : un seul mode d'écoute à la fois */
    if (settings.convMode && settings.wakeWord) {
      settings.wakeWord = false;
      persist();
      if (els.wakeWord) els.wakeWord.checked = false;
      disarmWake();
    }
    persist();
    if (settings.convMode && !CONV.running) {
      closeSettings();
      startConv().then(function () {
        if (CONV.running) toast('Conversation naturelle active — parle quand tu veux');
      });
    } else if (!settings.convMode && CONV.running) {
      stopConv();
      toast('Conversation naturelle coupée');
    }
  });

  els.vadSens.addEventListener('input', function () {
    settings.vadSens = parseFloat(els.vadSens.value);
    els.vadSensVal.textContent = sensLabel(settings.vadSens);
    persist();
  });

  function sensLabel(v) {
    if (v < 0.33) return 'faible';
    if (v < 0.66) return 'moyenne';
    return 'haute';
  }

  els.clear.addEventListener('click', function () {
    clearConversation(false);
  });

  /* -------- Mémoire persistante -------- */

  function memoryHeaders() {
    var h = {};
    if (settings.apiKey) h['X-Nova-Key'] = settings.apiKey;
    return h;
  }

  function forgetAllMemory(speak) {
    fetch('/api/memory/forget', { method: 'POST', headers: memoryHeaders() });
    STATE.history = [];
    STATE.sessionId = null;
    settings.sessionId = null;
    persist();
    els.messages.innerHTML = '';
    els.hero.style.display = '';
    var msg = "C'est oublié. Je ne garde plus aucun souvenir de nos conversations — on repart de zéro.";
    toast('Mémoire entièrement effacée');
    refreshMemPanel();
    if (speak) {
      addMessage('user', 'Nova, oublie tout');
      addMessage('assistant', msg);
    }
    speakUtterance(msg);
  }

  function forgetCurrentSession(speak) {
    var sid = STATE.sessionId;
    if (sid) {
      fetch('/api/memory/' + encodeURIComponent(sid), { method: 'DELETE', headers: memoryHeaders() });
    }
    STATE.history = [];
    STATE.sessionId = null;
    settings.sessionId = null;
    persist();
    els.messages.innerHTML = '';
    els.hero.style.display = '';
    var msg = "D'accord, j'oublie notre conversation actuelle. On recommence à zéro — et je n'en garderai pas la mémoire.";
    toast('Conversation actuelle oubliée');
    refreshMemPanel();
    if (speak) {
      addMessage('user', 'Nova, oublie cette conversation');
      addMessage('assistant', msg);
    }
    speakUtterance(msg);
  }

  function speakRecap() {
    fetch('/api/memory', { headers: memoryHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var n = (j.sessions || []).reduce(function (a, s) { return a + s.turns; }, 0);
        var msg;
        if (!j.sessions || !j.sessions.length) {
          msg = 'Pour l\'instant, je ne garde aucun souvenir : notre discussion commence à peine.';
        } else {
          var last = j.sessions[0];
          msg = 'Je me souviens de ' + j.sessions.length + ' conversation' + (j.sessions.length > 1 ? 's' : '') +
                ', soit ' + n + ' échange' + (n > 1 ? 's' : '') + '. La plus récente : « ' + last.title + ' », avec ' +
                last.turns + ' échange' + (last.turns > 1 ? 's' : '') + '. Tu peux tout consulter ou tout effacer dans les réglages, section mémoire.';
        }
        addMessage('user', 'Nova, qu\'est-ce que tu retiens ?');
        addMessage('assistant', msg);
        speakUtterance(msg);
      })
      .catch(function () {
        toast('Mémoire inaccessible', true);
      });
  }

  /* Restaure la dernière conversation au lancement */
  function restoreLastSession() {
    fetch('/api/memory', { headers: memoryHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.lastSessionId) return;
        return fetch('/api/memory/' + encodeURIComponent(j.lastSessionId), { headers: memoryHeaders() })
          .then(function (r) { return r.json(); })
          .then(function (sess) {
            if (!sess || !sess.turns || !sess.turns.length) return;
            STATE.sessionId = sess.id;
            settings.sessionId = sess.id;
            persist();
            els.hero.style.display = 'none';
            sess.turns.forEach(function (t) {
              if (t.user) {
                STATE.history.push({ role: 'user', content: t.user });
                addMessage('user', t.user);
              }
              if (t.assistant) {
                STATE.history.push({ role: 'assistant', content: t.assistant });
                addMessage('assistant', t.assistant);
              }
            });
            scrollChat();
            toast('Dernière conversation restaurée — « ' + sess.title + ' »');
          });
      })
      .catch(function () {});
  }

  /* -------- Panneau mémoire (réglages) -------- */

  function refreshMemPanel() {
    var list = document.getElementById('mem-list');
    if (!list) return;
    list.innerHTML = '<div class="mem-empty">Chargement…</div>';
    fetch('/api/memory', { headers: memoryHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        list.innerHTML = '';
        if (!j.sessions || !j.sessions.length) {
          list.innerHTML = '<div class="mem-empty">Aucun souvenir pour l\'instant. Nova mémorisera tes échanges automatiquement.</div>';
          return;
        }
        j.sessions.forEach(function (s) {
          var row = document.createElement('div');
          row.className = 'mem-row';
          var main = document.createElement('div');
          main.className = 'mem-main';
          var t = document.createElement('div');
          t.className = 'mem-title';
          t.textContent = s.title;
          var d = document.createElement('div');
          d.className = 'mem-date';
          var when = '';
          try { when = new Date(s.updatedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) {}
          d.textContent = when + ' · ' + s.turns + ' échange' + (s.turns > 1 ? 's' : '');
          main.appendChild(t); main.appendChild(d);
          var del = document.createElement('button');
          del.className = 'mem-del';
          del.title = 'Oublier cette conversation';
          del.textContent = '✕';
          del.addEventListener('click', function () {
            fetch('/api/memory/' + encodeURIComponent(s.id), { method: 'DELETE', headers: memoryHeaders() })
              .then(function () { refreshMemPanel(); });
            if (s.id === STATE.sessionId) {
              STATE.history = [];
              STATE.sessionId = null;
              settings.sessionId = null;
              persist();
            }
          });
          row.appendChild(main); row.appendChild(del);
          row.addEventListener('click', function (e) {
            if (e.target === del) return;
            openSessionById(s.id);
          });
          list.appendChild(row);
        });
      })
      .catch(function () {
        list.innerHTML = '<div class="mem-empty">Mémoire inaccessible.</div>';
      });
  }

  /* Ouvre une conversation archivée dans le chat : on reprend son sessionId,
     donc la suite de la discussion se rangera dans la MÊME conversation. */
  function openSessionById(id, opts) {
    opts = opts || {};
    fetch('/api/memory/' + encodeURIComponent(id), { headers: memoryHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (sess) {
        if (!sess || !sess.turns) return;
        stopSpeaking();
        STATE.history = [];
        els.messages.innerHTML = '';
        STATE.sessionId = sess.id;
        settings.sessionId = sess.id;
        persist();
        els.hero.style.display = 'none';
        sess.turns.forEach(function (tt) {
          if (tt.user) { STATE.history.push({ role: 'user', content: tt.user }); addMessage('user', tt.user); }
          if (tt.assistant) { STATE.history.push({ role: 'assistant', content: tt.assistant }); addMessage('assistant', tt.assistant); }
        });
        scrollChat();
        if (opts.closeAfter !== false) closeSettings();
        toast('Conversation « ' + (sess.title || 'sans titre') + ' » rouverte — la suite continue ici.');
      })
      .catch(function () { toast('Impossible d\u2019ouvrir cette conversation', true); });
  }

  /* Navigateur d'historique : toutes les conversations archivées, avec
     recherche sur le titre et l'aperçu, réouverture en un clic, et un
     badge « en cours » sur la conversation active. */
  function refreshHistoryPanel(filter) {
    var list = document.getElementById('hist-list');
    if (!list) return;
    filter = (filter || '').toLowerCase().trim();
    list.innerHTML = '<div class="mem-empty">Chargement…</div>';
    fetch('/api/memory', { headers: memoryHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        list.innerHTML = '';
        var sessions = (j.sessions || []).filter(function (s) {
          if (!filter) return true;
          return (s.title || '').toLowerCase().indexOf(filter) !== -1 ||
                 (s.preview || '').toLowerCase().indexOf(filter) !== -1;
        });
        if (!sessions.length) {
          list.innerHTML = '<div class="mem-empty">' + (filter
            ? 'Aucune conversation ne correspond à cette recherche.'
            : 'Aucune conversation archivée pour l\u2019instant.') + '</div>';
          return;
        }
        sessions.forEach(function (s) {
          var row = document.createElement('div');
          row.className = 'hist-row' + (s.id === STATE.sessionId ? ' current' : '');
          var main = document.createElement('div');
          main.className = 'hist-main';
          var t = document.createElement('div');
          t.className = 'hist-title';
          t.textContent = s.title || 'Sans titre';
          var p = document.createElement('div');
          p.className = 'hist-preview';
          p.textContent = s.preview || '';
          main.appendChild(t); main.appendChild(p);
          row.appendChild(main);
          var date = document.createElement('div');
          date.className = 'hist-date';
          var when = '';
          try { when = new Date(s.updatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); } catch (_) {}
          date.textContent = when + ' · ' + s.turns + ' échange' + (s.turns > 1 ? 's' : '');
          row.appendChild(date);
          if (s.id === STATE.sessionId) {
            var badge = document.createElement('span');
            badge.className = 'hist-badge';
            badge.textContent = 'en cours';
            row.appendChild(badge);
          } else {
            row.addEventListener('click', function () { openSessionById(s.id); });
          }
          list.appendChild(row);
        });
      })
      .catch(function () {
        list.innerHTML = '<div class="mem-empty">Historique inaccessible.</div>';
      });
  }

  /* Suggestions du hero */
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
    chip.addEventListener('click', function () {
      sendMessage(chip.getAttribute('data-suggest'));
    });
  });

  /* -------------------------------------------------------- */
  /* Démarrage                                                 */
  /* -------------------------------------------------------- */

  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
    // Safari peuple parfois la liste tardivement
    setTimeout(loadVoices, 350);
    setTimeout(loadVoices, 1200);
  }

  /* Hook de debug/test pour le mode conversation (sans effet en usage normal) */
  window.NovaConv = {
    isActive: function () { return CONV.running; },
    stop: stopConv,
    step: convLoop,
    simulateLevel: null,
  };

  if (STATE.ttsMuted) els.tts.classList.add('muted');
  applyTheme();
  setState('idle');
  els.input.focus();

  // Mot d'activation : si tu l'avais laissé activé, Nova se remet en veille
  if (settings.wakeWord) armWake(true);

  // Au démarrage : vérifie que le modèle choisi existe sur ce compte Groq
  loadModels();
  // Charge le profil utilisateur (également envoyé à chaque tour via /api/chat)
  loadProfile();
  // Restaure la dernière conversation (mémoire persistante)
  restoreLastSession();

  // Déverrouillage audio pour Safari (première interaction)
  var unlock = function () {
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (_) {}
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
})();
