/* ============================================================
   Nova — icônes SVG inline (traits, 24×24, zéro emoji)
   Usage : NovaIcons.el('mic') renvoie un <svg> clonable.
   ============================================================ */
window.NovaIcons = (function(){
  const PATHS = {
    mic:      '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/>',
    brain:    '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3.4 3.4 0 0 0 5 17c0 2.2 1.8 4 4 4h1V3H9z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3.4 3.4 0 0 1 19 17c0 2.2-1.8 4-4 4h-1V3h1z"/>',
    shield:   '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
    bolt:     '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
    moon:     '<path d="M21 13.5A8.5 8.5 0 1 1 10.5 3 6.8 6.8 0 0 0 21 13.5z"/>',
    dumbbell: '<path d="M7 8v8M4 9v6M17 8v8M20 9v6M7 12h10"/>',
    display:  '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    app:      '<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9.5" cy="9.5" r="1.4"/><circle cx="14.5" cy="9.5" r="1.4"/><circle cx="9.5" cy="14.5" r="1.4"/><circle cx="14.5" cy="14.5" r="1.4"/>',
    chat:     '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h7M8.5 13.5h4"/>',
    orb:      '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10" stroke-dasharray="3 4"/><circle cx="9.6" cy="9.6" r="1.6" fill="currentColor" stroke="none"/>',
    clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    volume:   '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    battery:  '<rect x="2" y="8" width="17" height="8" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><rect x="4.5" y="10.5" width="9" height="3" rx="1" fill="currentColor" stroke="none"/>',
    cloud:    '<path d="M7 18a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-1 7H7z"/>',
    github:   '<path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z" fill="currentColor" stroke="none"/>',
    apple:    '<path d="M16.7 12.9c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.5 2.1 2.5 2 1 0 1.4-.6 2.6-.6 1.2 0 1.6.6 2.6.6 1.1 0 1.8-1 2.4-2 .8-1.1 1.1-2.2 1.1-2.3 0 0-2.1-.8-2.1-3zM14.6 6.6c.5-.7.9-1.6.8-2.6-.8 0-1.8.6-2.3 1.2-.5.6-1 1.6-.8 2.5.9.1 1.8-.4 2.3-1.1z" fill="currentColor" stroke="none"/>',
    arrow:    '<path d="M5 12h14M13 6l6 6-6 6"/>',
    download: '<path d="M12 3v11M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    sparkle:  '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/>',
    wave:     '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4"/>',
    key:      '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M16 6l2.5 2.5M14 8l2 2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    package:  '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    memory:   '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  };

  function el(name, cls){
    const wrap = document.createElement('span');
    wrap.setAttribute('data-icon', name);
    if (cls) wrap.className = cls;
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (PATHS[name] || PATHS.sparkle) + '</svg>';
    const svg = wrap.firstElementChild;
    svg.style.width = '1em'; svg.style.height = '1em';
    svg.style.verticalAlign = '-0.15em';
    return wrap;
  }

  /* Remplace tous les <i data-ico="nom"></i> du document par l'icône. */
  function hydrate(root){
    (root || document).querySelectorAll('i[data-ico]').forEach((node) => {
      node.replaceWith(el(node.getAttribute('data-ico'), node.className));
    });
  }

  return { el, hydrate, PATHS };
})();
