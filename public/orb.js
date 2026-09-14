/* ============================================================
   Nova — décor vivant : orbe réactive + blobs d'arrière-plan.
   Tout est dessiné sur deux canvas, sans bibliothèque externe.
   L'orbe réagit au volume du micro (via setMicLevel) et aux
   états : idle · listening · thinking · speaking.
   ============================================================ */

(function () {
  'use strict';

  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -------------------------------------------------------- */
  /* Couleurs par état                                         */
  /* -------------------------------------------------------- */

  var STATE_COLORS = {
    idle:      { core: '#5f7cff', mid: '#4f46e5', rim: '#1e1b4b', glow: 'rgba(79,124,255,0.55)' },
    listening: { core: '#3ff0c0', mid: '#0ea5a0', rim: '#04352e', glow: 'rgba(45,212,167,0.6)' },
    thinking:  { core: '#b28cff', mid: '#7c3aed', rim: '#2a1065', glow: 'rgba(124,108,255,0.6)' },
    speaking:  { core: '#ffc46b', mid: '#f59e0b', rim: '#4a2a05', glow: 'rgba(255,180,92,0.6)' },
    /* Veille : orbe assoupie, veilleuse bleu-gris très discrète */
    sleep:     { core: '#4d5a80', mid: '#2b3350', rim: '#0d1020', glow: 'rgba(110,124,180,0.3)' },
  };

  /* Palettes pour le thème clair : mêmes teintes, rim sombre → pastel
     pour rester lisible sur fond clair, et halos plus doux. */
  var STATE_COLORS_LIGHT = {
    idle:      { core: '#4f6bff', mid: '#7c8cff', rim: '#dfe6ff', glow: 'rgba(99,102,241,0.35)' },
    listening: { core: '#0fbf9a', mid: '#4be3c0', rim: '#d8fbf1', glow: 'rgba(16,185,150,0.38)' },
    thinking:  { core: '#8b5cf6', mid: '#b28cff', rim: '#ece4ff', glow: 'rgba(139,92,246,0.38)' },
    speaking:  { core: '#f59e0b', mid: '#ffc46b', rim: '#fff1d6', glow: 'rgba(245,158,11,0.4)' },
    sleep:     { core: '#8f9ac0', mid: '#c2c9e4', rim: '#f2f4fc', glow: 'rgba(130,142,185,0.28)' },
  };

  function paletteFor(state) {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return (light ? STATE_COLORS_LIGHT : STATE_COLORS)[state] || STATE_COLORS.idle;
  }

  /* Blobs : nuit profonde en sombre, pastels aériens en clair */
  function bgPalette() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return light
      ? ['#dbe4ff', '#d3f1ea', '#e8e0ff', '#d6e8ff', '#ffe6f0']
      : ['#1b1440', '#0c1b3d', '#2a1065', '#10275e', '#3b0f4f'];
  }

  /* -------------------------------------------------------- */
  /* Arrière-plan : blobs lents + étincelles                   */
  /* -------------------------------------------------------- */

  var bgCanvas = document.getElementById('bg-canvas');
  var bgCtx = bgCanvas ? bgCanvas.getContext('2d') : null;
  var blobs = [];
  var sparks = [];

  function makeBlobs() {
    var palette = bgPalette();
    blobs = [];
    for (var i = 0; i < 5; i++) {
      blobs.push({
        hue: palette[i % palette.length],
        x: Math.random(),
        y: Math.random(),
        r: 0.28 + Math.random() * 0.22, // fraction du min(w,h)
        vx: (Math.random() - 0.5) * 0.00016,
        vy: (Math.random() - 0.5) * 0.00014,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /* Reprise des blobs quand le thème change (le couple orb.js ↔ app.js
     appelle makeBlobs() via NovaOrb.retheme()). */

  function makeSparks(n) {
    sparks = [];
    for (var i = 0; i < n; i++) {
      sparks.push({
        x: Math.random(),
        y: Math.random(),
        s: 0.6 + Math.random() * 1.6,
        a: 0.04 + Math.random() * 0.22,
        vy: -(0.00004 + Math.random() * 0.00012),
        vx: (Math.random() - 0.5) * 0.00006,
        tw: Math.random() * Math.PI * 2,
      });
    }
  }

  function resizeBg() {
    if (!bgCanvas) return;
    bgCanvas.width = Math.floor(window.innerWidth * DPR);
    bgCanvas.height = Math.floor(window.innerHeight * DPR);
  }

  function drawBg(t) {
    if (!bgCtx) return;
    var w = bgCanvas.width;
    var h = bgCanvas.height;
    bgCtx.clearRect(0, 0, w, h);

    var min = Math.min(w, h);

    // Blobs
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      b.x += b.vx; b.y += b.vy;
      if (b.x < -0.15) b.x = 1.15; if (b.x > 1.15) b.x = -0.15;
      if (b.y < -0.15) b.y = 1.15; if (b.y > 1.15) b.y = -0.15;

      var wob = 1 + 0.16 * Math.sin(t * 0.00023 + b.phase);
      var rr = b.r * min * wob;
      var cx = b.x * w;
      var cy = b.y * h;

      var g = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, hexA(b.hue, 0.5));
      g.addColorStop(1, hexA(b.hue, 0));
      bgCtx.fillStyle = g;
      bgCtx.beginPath();
      bgCtx.arc(cx, cy, rr, 0, Math.PI * 2);
      bgCtx.fill();
    }

    // Étincelles
    for (var s = 0; s < sparks.length; s++) {
      var p = sparks[s];
      p.x += p.vx; p.y += p.vy;
      if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
      if (p.x < -0.02) p.x = 1.02; if (p.x > 1.02) p.x = -0.02;
      var alpha = p.a * (0.6 + 0.4 * Math.sin(t * 0.0016 + p.tw));
      bgCtx.fillStyle = 'rgba(190,205,255,' + alpha.toFixed(3) + ')';
      bgCtx.beginPath();
      bgCtx.arc(p.x * w, p.y * h, p.s * DPR, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }

  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* -------------------------------------------------------- */
  /* Orbe réactive                                             */
  /* -------------------------------------------------------- */

  var orbCanvas = document.createElement('canvas');
  orbCanvas.id = 'orb';
  document.body.appendChild(orbCanvas);
  var orbCtx = orbCanvas.getContext('2d');

  var ORB = {
    size: 0,            // px (CSS)
    level: 0,           // volume micro lissé 0..1
    targetLevel: 0,
    state: 'idle',
    color: null,        // résolu par paletteFor() au premier rendu
    colorFrom: null,
    colorT: 1,          // transition de couleur 0..1
    breathe: 0,
    wobble: [],         // déformation harmonique
    petals: [],         // particules « pensée »
    sparks2: [],        // particules « parole »
  };

  var HARMONICS = 7;

  function initOrb() {
    sizeOrb();
    ORB.wobble = [];
    for (var i = 0; i < HARMONICS; i++) {
      ORB.wobble.push({
        amp: 0.004 + Math.random() * 0.012,
        speed: 0.4 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
      });
    }
    for (var p = 0; p < 14; p++) ORB.petals.push(newPetal(true));
    for (var q = 0; q < 20; q++) ORB.sparks2.push(newSpark2());
  }

  function sizeOrb() {
    var s = Math.min(window.innerWidth, window.innerHeight);
    ORB.size = Math.max(190, Math.min(300, Math.round(s * 0.27)));
    orbCanvas.width = Math.floor(ORB.size * 1.7 * DPR);
    orbCanvas.height = Math.floor(ORB.size * 1.7 * DPR);
    orbCanvas.style.width = Math.floor(ORB.size * 1.7) + 'px';
    orbCanvas.style.height = Math.floor(ORB.size * 1.7) + 'px';
  }

  function newPetal(scattered) {
    return {
      a: Math.random() * Math.PI * 2,
      r: scattered ? 0.6 + Math.random() * 0.5 : 0.55,
      speed: (0.15 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
      size: 2 + Math.random() * 3.4,
      alpha: 0.16 + Math.random() * 0.4,
      life: Math.random(),
    };
  }

  function newSpark2() {
    return { a: Math.random() * Math.PI * 2, r: 1.05 + Math.random() * 0.35, v: 0.4 + Math.random() * 1.4, size: 1 + Math.random() * 2.2, alpha: 0.5 + Math.random() * 0.5, life: Math.random() };
  }

  /* Transition douce entre deux palettes */
  function lerpColor(c1, c2, t) {
    function px(x) {
      var h = x && x.core ? x.core : x;
      return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    }
    var a = px(c1), b = px(c2);
    function mix(x, y, tt) {
      return [
        Math.round(x[0] + (y[0] - x[0]) * tt),
        Math.round(x[1] + (y[1] - x[1]) * tt),
        Math.round(x[2] + (y[2] - x[2]) * tt),
      ];
    }
    function rgb(v) { return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')'; }
    var core = mix(a, b, t);
    var mid = mix(a, b, 0.35 + 0.6 * t);
    var rim = mix(a, b, 0.15 + 0.45 * t);
    return { core: rgb(core), mid: rgb(mid), rim: rgb(rim), glow: (c2 && c2.glow) || 'rgba(79,124,255,0.55)' };
  }

  function drawOrb(t, dt) {
    var S = ORB.size * 1.7 * DPR;
    var c = S / 2;
    orbCtx.clearRect(0, 0, S, S);

    // lissage du niveau micro
    ORB.level += (ORB.targetLevel - ORB.level) * Math.min(1, dt * 0.012);

    // transition de couleur
    if (ORB.colorT < 1) {
      ORB.colorT = Math.min(1, ORB.colorT + dt * 0.0028);
      ORB.color = lerpColor(ORB.colorFrom || paletteFor(ORB.state) || paletteFor('idle'), paletteFor(ORB.state), easeInOut(ORB.colorT));
    }

    var col = ORB.color;
    var state = ORB.state;
    var lv = ORB.level;

    // respiration
    ORB.breathe += dt * 0.0011;
    var breatheAmp = state === 'thinking' ? 0.05 : 0.028;
    var breathe = 1 + breatheAmp * Math.sin(ORB.breathe * Math.PI * 2);

    // rayon de base
    var baseR = ORB.size * 0.42 * DPR;
    var react = 1 + lv * (state === 'listening' ? 0.16 : 0.1);
    var R = baseR * breathe * react;

    // --- halo externe ---
    var glowR = R * (state === 'speaking' ? 2.6 : 2.2);
    var glow = orbCtx.createRadialGradient(c, c, R * 0.4, c, c, glowR);
    glow.addColorStop(0, col.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    orbCtx.globalAlpha = state === 'idle' ? 0.34 : 0.55;
    orbCtx.fillStyle = glow;
    orbCtx.beginPath();
    orbCtx.arc(c, c, glowR, 0, Math.PI * 2);
    orbCtx.fill();
    orbCtx.globalAlpha = 1;

    // --- corps déformé par harmoniques + micro ---
    var points = 140;
    orbCtx.beginPath();
    for (var i = 0; i <= points; i++) {
      var th = (i / points) * Math.PI * 2;
      var def = 0;
      for (var k = 0; k < ORB.wobble.length; k++) {
        var hb = ORB.wobble[k];
        var amp = hb.amp * (1 + lv * 2.2) * (state === 'thinking' ? 1.6 : 1);
        def += Math.sin(th * (k + 2) + t * 0.001 * hb.speed + hb.phase) * amp;
      }
      // accentuation dans la direction « bas » (écoute)
      var rr = R * (1 + def);
      var x = c + Math.cos(th) * rr;
      var y = c + Math.sin(th) * rr;
      if (i === 0) orbCtx.moveTo(x, y);
      else orbCtx.lineTo(x, y);
    }
    orbCtx.closePath();

    // remplissage dégradé
    var body = orbCtx.createRadialGradient(c - R * 0.32, c - R * 0.38, R * 0.08, c, c, R * 1.06);
    body.addColorStop(0, lighten(col.core, 0.42));
    body.addColorStop(0.42, col.core);
    body.addColorStop(0.78, col.mid);
    body.addColorStop(1, col.rim);
    orbCtx.fillStyle = body;

    orbCtx.shadowColor = col.glow;
    orbCtx.shadowBlur = 34 * DPR;
    orbCtx.fill();
    orbCtx.shadowBlur = 0;

    // --- reflet spéculaire ---
    orbCtx.save();
    orbCtx.clip(); // re-clip sur le path courant ? non : refaire le path
    orbCtx.restore();

    orbCtx.beginPath();
    orbCtx.ellipse(c - R * 0.34, c - R * 0.42, R * 0.34, R * 0.2, -0.6, 0, Math.PI * 2);
    var spec = orbCtx.createRadialGradient(c - R * 0.34, c - R * 0.42, 0, c - R * 0.34, c - R * 0.42, R * 0.36);
    spec.addColorStop(0, 'rgba(255,255,255,0.55)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    orbCtx.fillStyle = spec;
    orbCtx.fill();

    // --- anneaux d'écoute (ondes du micro) ---
    if (state === 'listening' && lv > 0.02) {
      var rings = 3;
      for (var r = 0; r < rings; r++) {
        var ph = (t * 0.0011 + r / rings) % 1;
        orbCtx.beginPath();
        orbCtx.arc(c, c, R * (1 + ph * 0.55), 0, Math.PI * 2);
        orbCtx.strokeStyle = 'rgba(63,240,192,' + (0.3 * (1 - ph)).toFixed(3) + ')';
        orbCtx.lineWidth = 1.6 * DPR;
        orbCtx.stroke();
      }
    }

    // --- particules de pensée (état thinking) ---
    if (state === 'thinking') {
      orbCtx.fillStyle = 'rgba(178,140,255,1)';
      for (var p = 0; p < ORB.petals.length; p++) {
        var pt = ORB.petals[p];
        pt.a += pt.speed * dt * 0.001;
        pt.r += 0.00016 * dt;
        pt.life += dt * 0.0004;
        if (pt.r > 1.5 || pt.life > 1) { ORB.petals[p] = newPetal(false); pt = ORB.petals[p]; pt.r = 0.55; }
        var px2 = c + Math.cos(pt.a) * R * pt.r;
        var py2 = c + Math.sin(pt.a) * R * pt.r * 0.94;
        orbCtx.globalAlpha = Math.max(0, 0.5 - pt.r * 0.3) * pt.alpha + 0.06;
        orbCtx.beginPath();
        orbCtx.arc(px2, py2, pt.size * DPR * 0.6, 0, Math.PI * 2);
        orbCtx.fill();
      }
      orbCtx.globalAlpha = 1;
    }

    // --- étincelles de parole (état speaking) ---
    if (state === 'speaking') {
      for (var s2 = 0; s2 < ORB.sparks2.length; s2++) {
        var sp = ORB.sparks2[s2];
        sp.a += sp.v * dt * 0.0009;
        sp.life += dt * 0.0006;
        if (sp.life > 1) { ORB.sparks2[s2] = newSpark2(); sp = ORB.sparks2[s2]; sp.life = 0; }
        var sx = c + Math.cos(sp.a) * R * sp.r;
        var sy = c + Math.sin(sp.a) * R * sp.r;
        orbCtx.fillStyle = 'rgba(255,196,107,' + (sp.alpha * (1 - sp.life)).toFixed(3) + ')';
        orbCtx.beginPath();
        orbCtx.arc(sx, sy, sp.size * DPR * 0.7, 0, Math.PI * 2);
        orbCtx.fill();
      }
    }
  }

  function parseColor(c) {
    if (c.charAt(0) === '#') {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    var m = c.match(/\d+/g);
    return m ? [parseInt(m[0], 10), parseInt(m[1], 10), parseInt(m[2], 10)] : [95, 124, 255];
  }

  function lighten(color, amt) {
    var v = parseColor(color);
    var r = Math.round(v[0] + (255 - v[0]) * amt);
    var g = Math.round(v[1] + (255 - v[1]) * amt);
    var b = Math.round(v[2] + (255 - v[2]) * amt);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  /* -------------------------------------------------------- */
  /* API publique                                              */
  /* -------------------------------------------------------- */

  window.NovaOrb = {
    /** Fait évoluer l'orbe vers un état. */
    setState: function (s) {
      if (!paletteFor(s) || ORB.state === s) return;
      ORB.colorFrom = paletteFor(ORB.state);
      ORB.state = s;
      ORB.colorT = 0;
    },
    /** Niveau micro temps réel 0..1 (lissé à l'intérieur). */
    setMicLevel: function (v) {
      ORB.targetLevel = Math.max(0, Math.min(1, v));
    },
    /** Nouvelle palette de fond après un changement de thème clair/sombre. */
    retheme: function () {
      makeBlobs();
      ORB.colorFrom = paletteFor(ORB.state);
      ORB.colorT = 0;
    },
    /** Animation du halo CSS en fonction de l'état (déjà géré par CSS). */
  };

  /* -------------------------------------------------------- */
  /* Boucle d'animation                                        */
  /* -------------------------------------------------------- */

  var last = 0;
  function frame(t) {
    var dt = Math.min(50, t - last || 16);
    last = t;
    try {
      if (!reduced) drawBg(t);
      drawOrb(t, dt);
    } catch (_) {
      /* une frame manquée ne doit jamais tuer l'animation */
    }
    requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------- */
  /* Démarrage                                                 */
  /* -------------------------------------------------------- */

  makeBlobs();
  makeSparks(reduced ? 0 : 46);
  resizeBg();
  initOrb();
  window.addEventListener('resize', function () { resizeBg(); sizeOrb(); });
  requestAnimationFrame(frame);
})();
