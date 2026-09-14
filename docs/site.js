/* ============================================================
   Nova — script partagé : nav, icônes, reveal, moteur de démo
   ============================================================ */
(function(){
  const REPO = 'https://github.com/DmzGamingYT/nova';

  /* ---------- navigation commune ---------- */
  function buildNav(active){
    const nav = document.createElement('nav');
    nav.className = 'site-nav';
    const here = ['/', '/index.html'].includes(location.pathname) || location.pathname.endsWith('nova/') ? 'index' : null;
    const page = active || (document.body.getAttribute('data-page') || 'index');
    nav.innerHTML =
      '<a class="brand" href="index.html"><span class="dot"></span>NOVA</a>' +
      '<div class="links">' +
        '<a href="index.html"' + (page==='index'?' class="active"':'') + '>Accueil</a>' +
        '<a href="fonctions.html"' + (page==='fonctions'?' class="active"':'') + '>Fonctions</a>' +
        '<a href="demo.html"' + (page==='demo'?' class="active"':'') + '>Démo</a>' +
        '<a href="commandes.html"' + (page==='commandes'?' class="active"':'') + '>Commandes</a>' +
        '<a href="installation.html"' + (page==='installation'?' class="active"':'') + '>Installation</a>' +
        '<a class="gh" href="' + REPO + '" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z"/></svg>GitHub</a>' +
      '</div>';
    document.body.prepend(nav);
  }

  /* ---------- footer commun ---------- */
  function buildFooter(){
    const f = document.createElement('footer');
    f.innerHTML =
      '<div class="f-brand">✦ Nova</div>' +
      '<p>Fait avec ✦ sur un MacBook Air M4 · <a href="' + REPO + '">GitHub</a> · ' +
      '<a href="' + REPO + '/releases">App macOS</a> · licence MIT · propulsé par <a href="https://groq.com">Groq</a></p>';
    document.body.appendChild(f);
  }

  /* ---------- reveal au scroll ---------- */
  function initReveal(){
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold:.12 });
    document.querySelectorAll('.reveal, .feat').forEach(el => io.observe(el));
  }

  /* ---------- moteur de démo hors-ligne ---------- */
  function initDemo(){
    const log = document.getElementById('demoLog');
    if (!log) return;
    const input = document.getElementById('demoText');
    const send = document.getElementById('demoSend');
    const clearBtn = document.getElementById('demoClear');
    const stateEl = document.getElementById('demoState');
    const orbStage = document.getElementById('orbStage');
    const orbCanvas = document.getElementById('orbCanvas');
    const orbStateEl = document.getElementById('orbState');
    const orb = (window.NovaOrb && orbCanvas) ? window.NovaOrb.init(orbCanvas, orbStateEl) : null;

    const SCRIPT = [
      { re:/bonjour|salut|hello|coucou|hey/i,
        txt:"Bonjour ! Moi c'est Nova. Ici je suis en mode démo — sur ton Mac, je répondrais à voix haute, avec de vraies réponses." },
      { re:/heure|il est/i,
        txt:"Ici, je n'ai pas d'horloge — mais sur ton Mac, je lis l'heure réelle en une passe, sans même passer par le modèle. Essaie : « quelle heure est-il ? » chez toi affichera l'heure exacte, avec la pastille verte « donnée réelle »." },
      { re:/m[ée]t[ée]o/i,
        txt:"Sur ton Mac : « il fait quel temps à Namur ? » interroge wttr.in en direct — sans clé d'API. La démo, elle, reste sagement hors-ligne." },
      { re:/sport|s[ée]ance|muscu|programme/i,
        txt:"Je connais ton programme Pulse : « Quelle séance j'ai aujourd'hui ? » te donne exercices, séries et repos. Et « Nova, séance terminée » valide la séance d'un seul souffle." },
      { re:/qui es[- ]tu|pr[ée]sente/i,
        txt:"Je suis une assistante vocale qui vit entièrement sur ta machine : ma voix est celle de ton Mac, ma mémoire est un fichier local, et mes actions passent par une sandbox avec ta confirmation. Propulsée par Groq pour le cerveau." },
      { re:/volume|lumi[èe]re|capture|[ée]cran|ouvre/i,
        txt:"Je peux régler le volume (« mets le volume à 40 »), ouvrir une app, afficher une notification, prendre une capture d'écran… Toujours avec une carte « Autoriser » avant d'agir." },
      { re:/voix|parle|mémoire|souvenir|retenu/i,
        txt:"Ma voix ? Une voix française de ton Mac, lisible phrase par phrase pendant que le modèle écrit. Ma mémoire ? Les 6 dernières conversations, réinjectées dans mon contexte — même après redémarrage." },
      { re:/merci/i,
        txt:"Avec grand plaisir ! Sur ton Mac, je te répondrais en vrai — et à voix haute." },
    ];
    const FALLBACK = "Ici je tourne en mode démo avec quelques réponses pré-écrites. Sur ton Mac — trois commandes plus une clé Groq gratuite — je réponds vraiment à tout, à voix haute : heure, météo, sport, contrôle du Mac…";

    function bubble(cls, txt){
      const d = document.createElement('div');
      d.className = 'msg '+cls;
      if (txt) d.textContent = txt;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }

    function respond(userTxt){
      if (orb) orb.set('think');
      if (stateEl){ stateEl.textContent = '— réfléchit…'; stateEl.style.color = '#cdc6ff'; }
      const hit = SCRIPT.find(s => s.re.test(userTxt));
      const full = hit ? hit.txt : FALLBACK;
      setTimeout(() => {
        if (orb) orb.set('speak');
        if (stateEl){ stateEl.textContent = '— répond'; stateEl.style.color = '#ffd9a0'; }
        const b = bubble('nova streaming','');
        let i = 0;
        const tick = setInterval(() => {
          b.textContent = full.slice(0, i += 1 + Math.floor(Math.random()*3));
          log.scrollTop = log.scrollHeight;
          if (i >= full.length){
            clearInterval(tick);
            b.classList.remove('streaming');
            if (orb) orb.set('ready');
            if (stateEl){ stateEl.textContent = '— prête'; stateEl.style.color = ''; }
          }
        }, 22);
      }, 500 + Math.random()*500);
    }

    function submit(v){
      v = (v !== undefined ? v : input.value).trim();
      if (!v) return;
      input.value = '';
      bubble('user', v);
      if (orb) orb.set('listen');
      if (stateEl){ stateEl.textContent = '— écoute'; stateEl.style.color = '#9defd8'; }
      respond(v);
    }

    send.addEventListener('click', () => submit());
    input.addEventListener('keydown', e => { if (e.key==='Enter') submit(); });
    clearBtn.addEventListener('click', () => { log.innerHTML=''; input.focus(); });
    document.querySelectorAll('.suggest button[data-say]').forEach(b => {
      b.addEventListener('click', () => submit(b.getAttribute('data-say')));
    });

    /* accueil */
    setTimeout(() => {
      const b = bubble('nova','');
      const hello = "Bonjour — écris-moi, ou clique une suggestion. Sur ton Mac, tout ceci serait dit à voix haute.";
      let i = 0;
      const tk = setInterval(() => {
        b.textContent = hello.slice(0, i += 2);
        if (i >= hello.length) clearInterval(tk);
      }, 24);
    }, 600);

    if (orbStage && orbCanvas) orbStage.style.display = 'none'; /* la démo pilote l'orbe cachée : pas d'étape visuelle */
  }

  /* ---------- démarrage ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    buildNav();
    buildFooter();
    if (window.NovaIcons) window.NovaIcons.hydrate();
    initReveal();
    initDemo();

    const heroCanvas = document.getElementById('heroOrb');
    if (heroCanvas){
      window.NovaOrb.init(heroCanvas, document.getElementById('heroOrbState'));
    }
  });
})();
