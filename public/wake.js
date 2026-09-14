/* ============================================================
   Nova — mot d'activation « Nova » (à la Siri).
   Nova reste endormie puis se réveille quand elle entend son nom.

   Deux moteurs, choisis automatiquement :
   1) Web Speech API (reconnaissance continue du navigateur) —
      instantané et gratuit, utilisé dès qu'il est disponible.
   2) Repli Whisper : petit VAD sur le micro → court segment →
      POST /api/stt → on cherche « Nova » dans la transcription.
      Utilisé si le navigateur n'expose pas la Web Speech API.

   API publique :
     window.NovaWake.start({ onWake, onError, headers, sensitivity })
     window.NovaWake.stop()
     window.NovaWake.setMuted(bool)   // true pendant que Nova parle
     window.NovaWake.hasWake(text)    // test du mot d'activation
     window.NovaWake.simulate(text)   // hook de test/démo
     window.NovaWake.mode             // 'speech' | 'whisper'
   ============================================================ */

(function () {
  'use strict';

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  /* « Nova » et les transcriptions voisines les plus fréquentes */
  var WAKE_RE = /\b(nova|novah?|no ?va|novas|noba|novac)\b/;

  function normalize(s) {
    s = String(s || '').toLowerCase();
    try {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (_) { /* vieux moteurs : on garde tel quel */ }
    return s;
  }

  function hasWake(text) {
    return WAKE_RE.test(normalize(text));
  }

  /* Ce qui suit le nom : « Nova, coupe-toi » → « coupe-toi ».
     Permet de traiter la demande dans la foulée (comme Siri). */
  function wakeRemainder(text) {
    var m = normalize(text).match(WAKE_RE);
    if (!m) return '';
    var after = String(text).slice(m.index + m[0].length);
    return after.replace(/^[\s,;:.!?…-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  var api = {
    running: false,
    muted: false,
    mode: SR ? 'speech' : 'whisper',
    onWake: null,
    onError: null,
    wakeRemainder: wakeRemainder,
    headers: {},
    sensitivity: 0.5,
    hasWake: hasWake,
  };

  var lastFire = 0;
  var DEBOUNCE_MS = 2000; // évite les déclenchements en rafale

  function fire(source, text) {
    if (!api.running || api.muted) return;
    var now = Date.now();
    if (now - lastFire < DEBOUNCE_MS) return;
    lastFire = now;
    if (api.onWake) api.onWake(source, wakeRemainder(text || ''));
  }

  function fail(msg) {
    if (api.onError) api.onError(msg);
  }

  /* -------------------------------------------------------- */
  /* Moteur 1 : Web Speech API (reconnaissance continue)       */
  /* -------------------------------------------------------- */

  var rec = null;
  var restartTimer = null;
  var backoff = 400;

  function speechStart() {
    if (!SR) return;
    try {
      rec = new SR();
    } catch (e) {
      return fail('Reconnaissance vocale indisponible');
    }
    rec.lang = 'fr-FR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = function () { backoff = 400; };

    rec.onresult = function (e) {
      if (!api.running || api.muted) return;
      var txt = '';
      try {
        for (var i = e.resultIndex || 0; i < e.results.length; i++) {
          var alt = e.results[i] && e.results[i][0];
          if (alt && alt.transcript) txt += alt.transcript + ' ';
        }
      } catch (_) {}
      if (hasWake(txt)) fire('speech', txt);
    };

    rec.onerror = function (e) {
      var err = e && e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        api.running = false;
        fail('Micro refusé pour le mot d\u2019activation');
      }
      /* no-speech / aborted / network : on relancera via onend */
    };

    rec.onend = function () {
      if (!api.running) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function () {
        if (!api.running) return;
        try {
          rec.start();
        } catch (_) { /* déjà en cours */ }
      }, backoff);
      backoff = Math.min(4000, Math.round(backoff * 1.6));
    };

    try {
      rec.start();
    } catch (e) {
      api.running = false;
      fail(e.message);
    }
  }

  /* -------------------------------------------------------- */
  /* Moteur 2 : repli Whisper (VAD + segment court + /api/stt) */
  /* -------------------------------------------------------- */

  var gate = {
    stream: null,
    ctx: null,
    analyser: null,
    data: null,
    raf: 0,
    recorder: null,
    chunks: [],
    capturing: false,
    smooth: 0,
    lastVoice: 0,
    silenceStart: 0,
    stopTimer: null,
  };

  function gateThresholds() {
    var s = Math.max(0, Math.min(1, Number(api.sensitivity)));
    if (isNaN(s)) s = 0.5;
    return { on: 0.18 - s * 0.13, off: 0.11 - s * 0.08 };
  }

  function whisperStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return fail('Micro indisponible dans ce navigateur');
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        if (!api.running) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return;
        }
        gate.stream = stream;
        try {
          gate.ctx = new (window.AudioContext || window.webkitAudioContext)();
          var src = gate.ctx.createMediaStreamSource(stream);
          gate.analyser = gate.ctx.createAnalyser();
          gate.analyser.fftSize = 1024;
          src.connect(gate.analyser);
          gate.data = new Uint8Array(gate.analyser.frequencyBinCount);
        } catch (e) {
          return fail('Analyse audio impossible : ' + e.message);
        }
        gateLoop();
      })
      .catch(function () {
        api.running = false;
        fail('Accès au micro refusé');
      });
  }

  function gateLoop() {
    if (!api.running || api.mode !== 'whisper') return;
    gate.raf = requestAnimationFrame(gateLoop);

    var level = 0;
    if (gate.analyser) {
      gate.analyser.getByteFrequencyData(gate.data);
      var sum = 0;
      for (var i = 0; i < gate.data.length; i++) sum += gate.data[i];
      level = Math.min(1, sum / gate.data.length / 140);
    }
    gate.smooth += (level - gate.smooth) * 0.3;

    var th = gateThresholds();
    var now = performance.now();

    if (gate.smooth > th.on) {
      gate.lastVoice = now;
      if (!gate.capturing && !api.muted) startGateCapture();
      if (gate.capturing) gate.silenceStart = 0;
    } else if (gate.capturing) {
      if (gate.smooth < th.off) {
        if (!gate.silenceStart) gate.silenceStart = now;
        else if (now - gate.silenceStart > 650) stopGateCapture();
      } else {
        gate.silenceStart = 0;
      }
    }
  }

  function startGateCapture() {
    gate.capturing = true;
    gate.chunks = [];
    gate.silenceStart = 0;
    try {
      var mime = '';
      if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
        ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].some(function (m) {
          if (MediaRecorder.isTypeSupported(m)) { mime = m; return true; }
          return false;
        });
      }
      gate.recorder = mime ? new MediaRecorder(gate.stream, { mimeType: mime }) : new MediaRecorder(gate.stream);
    } catch (_) {
      gate.capturing = false;
      return;
    }
    gate.recorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) gate.chunks.push(ev.data);
    };
    gate.recorder.onstop = gateSend;
    try {
      gate.recorder.start(200);
    } catch (_) {
      gate.capturing = false;
      return;
    }
    /* Sécurité : jamais plus de 2,5 s d'écoute pour un simple mot */
    clearTimeout(gate.stopTimer);
    gate.stopTimer = setTimeout(stopGateCapture, 2500);
  }

  function stopGateCapture() {
    if (!gate.capturing) return;
    gate.capturing = false;
    clearTimeout(gate.stopTimer);
    if (gate.recorder && gate.recorder.state !== 'inactive') {
      try { gate.recorder.stop(); } catch (_) {}
    }
  }

  function gateSend() {
    var blob = new Blob(gate.chunks, { type: (gate.recorder && gate.recorder.mimeType) || 'audio/webm' });
    gate.chunks = [];
    if (blob.size < 2500) return;
    var fd = new FormData();
    fd.append('file', blob, 'wake.webm');
    fetch('/api/stt', { method: 'POST', headers: api.headers || {}, body: fd })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.text && hasWake(j.text)) fire('whisper', j.text);
      })
      .catch(function () { /* réseau : on garde la veille */ });
  }

  function stopWhisper() {
    cancelAnimationFrame(gate.raf);
    clearTimeout(gate.stopTimer);
    gate.capturing = false;
    if (gate.recorder && gate.recorder.state !== 'inactive') {
      gate.recorder.onstop = null;
      try { gate.recorder.stop(); } catch (_) {}
    }
    gate.recorder = null;
    if (gate.stream) {
      gate.stream.getTracks().forEach(function (t) { t.stop(); });
      gate.stream = null;
    }
    if (gate.ctx) {
      try { gate.ctx.close(); } catch (_) {}
      gate.ctx = null;
      gate.analyser = null;
    }
  }

  /* -------------------------------------------------------- */
  /* API                                                       */
  /* -------------------------------------------------------- */

  api.start = function (opts) {
    opts = opts || {};
    if (typeof opts.onWake === 'function') api.onWake = opts.onWake;
    if (typeof opts.onError === 'function') api.onError = opts.onError;
    if (opts.headers) api.headers = opts.headers;
    if (typeof opts.sensitivity === 'number') api.sensitivity = opts.sensitivity;
    if (api.running) return api.mode;
    api.running = true;
    api.muted = false;
    if (SR) {
      api.mode = 'speech';
      speechStart();
    } else {
      api.mode = 'whisper';
      whisperStart();
    }
    return api.mode;
  };

  api.stop = function () {
    api.running = false;
    api.muted = false;
    clearTimeout(restartTimer);
    if (rec) {
      try { rec.onend = null; rec.abort(); } catch (_) {}
      rec = null;
    }
    stopWhisper();
  };

  api.setMuted = function (m) {
    api.muted = !!m;
    /* En mode Whisper, couper la capture en cours évite d'enregistrer la voix de Nova */
    if (api.muted && gate.capturing) stopGateCapture();
  };

  /* Hook de test/démo : rejoue un « transcript » comme le ferait le moteur */
  api.simulate = function (text) {
    var ok = hasWake(text);
    if (ok) fire('simulate:' + String(text).trim());
    return ok;
  };

  window.NovaWake = api;
})();
