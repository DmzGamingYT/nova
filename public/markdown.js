/* ============================================================
   Nova — mini-renderer Markdown, résistant au streaming.
   Stratégie : on isole d'abord les blocs de code, puis les
   segments en ligne (inline code / gras / italique / liens),
   et on échappe le HTML autour. Rendu incrémental sûr tant
   que le texte arrive par morceaux.
   ============================================================ */

(function () {
  'use strict';

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderInline(text) {
    var out = '';
    var i = 0;
    var n = text.length;

    while (i < n) {
      var ch = text[i];

      // — code inline `…`
      if (ch === '`') {
        var end = text.indexOf('`', i + 1);
        if (end !== -1) {
          out += '<code>' + escapeHtml(text.slice(i + 1, end)) + '</code>';
          i = end + 1;
          continue;
        }
      }

      // — gras **…** ou __…__
      var boldMatch = null;
      if (ch === '*' || ch === '_') {
        boldMatch = text.slice(i).match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
        if (boldMatch) {
          out += '<strong>' + renderInline(boldMatch[2]) + '</strong>';
          i += boldMatch[0].length;
          continue;
        }
      }

      // — italique *…* ou _…_
      var italicMatch = null;
      if (ch === '*' || ch === '_') {
        italicMatch = text.slice(i).match(/^(\*|_)(?=\S)([^*_\n]*\S)\1/);
        if (italicMatch) {
          out += '<em>' + renderInline(italicMatch[2]) + '</em>';
          i += italicMatch[0].length;
          continue;
        }
      }

      // — liens [texte](url)
      if (ch === '[') {
        var linkMatch = text.slice(i).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
        if (linkMatch) {
          out += '<a href="' + escapeHtml(linkMatch[2]) + '" target="_blank" rel="noopener">' +
                 renderInline(linkMatch[1]) + '</a>';
          i += linkMatch[0].length;
          continue;
        }
      }

      if (ch === '&') {
        out += '&amp;';
        i += 1;
        continue;
      }
      if (ch === '<') {
        out += '&lt;';
        i += 1;
        continue;
      }
      if (ch === '>') {
        out += '&gt;';
        i += 1;
        continue;
      }
      if (ch === '"') {
        out += '&quot;';
        i += 1;
        continue;
      }

      out += ch;
      i += 1;
    }
    return out;
  }

  /**
   * Rend un texte (potentiellement incomplet, en cours de streaming)
   * en HTML sûr. Un bloc de code non fermé est rendu comme bloc ouvert.
   */
  function renderMarkdown(raw) {
    var text = String(raw || '');
    var html = '';
    var i = 0;

    while (i < text.length) {
      // Cherche le prochain ``` ouvre/ferme
      var fence = text.indexOf('```', i);

      if (fence === -1) {
        html += renderBlockText(text.slice(i), false);
        break;
      }

      // Texte avant le bloc
      html += renderBlockText(text.slice(i, fence), false);

      // Ligne de langage après ``` si présente
      var afterFence = text.slice(fence + 3);
      var nl = afterFence.indexOf('\n');
      var lang = '';
      var codeStart = fence + 3;
      if (nl !== -1 && nl <= 24) {
        var maybeLang = afterFence.slice(0, nl).trim();
        if (/^[a-zA-Z0-9+#-]*$/.test(maybeLang)) {
          lang = maybeLang;
          codeStart = fence + 3 + nl + 1;
        }
      }

      var close = text.indexOf('```', codeStart);
      var code, closed;
      if (close === -1) {
        code = text.slice(codeStart);
        closed = false; // bloc encore ouvert (streaming en cours)
      } else {
        code = text.slice(codeStart, close);
        closed = true;
      }

      // Retire un \n final introductif
      if (code.charCodeAt(0) === 10) code = code.slice(1);

      html +=
        '<pre data-lang="' + escapeHtml(lang) + '"><code>' +
        escapeHtml(code.replace(/\n$/, '')) +
        (closed ? '' : '<span class="caret"></span>') +
        '</code></pre>';

      if (closed) {
        i = close + 3;
      } else {
        i = text.length; // consommé jusqu'au bout
      }
    }

    return html;
  }

  /* Rend les lignes hors bloc de code : titres, listes, paragraphes */
  function renderBlockText(chunk, inCode) {
    var lines = chunk.split('\n');
    var html = '';
    var listOpen = null; // 'ul' | 'ol' | null
    var para = [];

    function flushPara() {
      if (para.length) {
        html += '<p>' + renderInline(para.join(' ')) + '</p>';
        para = [];
      }
    }
    function closeList() {
      if (listOpen) {
        html += '</' + listOpen + '>';
        listOpen = null;
      }
    }

    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];

      var h = line.match(/^(#{1,4})\s+(.*)$/);
      var ul = line.match(/^\s*[-*•]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (h) {
        flushPara(); closeList();
        var level = Math.min(h[1].length + 2, 6);
        html += '<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>';
      } else if (ul) {
        flushPara();
        if (listOpen !== 'ul') { closeList(); html += '<ul>'; listOpen = 'ul'; }
        html += '<li>' + renderInline(ul[1]) + '</li>';
      } else if (ol) {
        flushPara();
        if (listOpen !== 'ol') { closeList(); html += '<ol>'; listOpen = 'ol'; }
        html += '<li>' + renderInline(ol[1]) + '</li>';
      } else if (/^\s*$/.test(line)) {
        flushPara(); closeList();
      } else {
        para.push(line.trim());
      }
    }
    flushPara(); closeList();
    return html;
  }

  /* Nettoyage pour la synthèse vocale : retirer la syntaxe markdown */
  function stripForSpeech(raw) {
    var t = String(raw || '');
    t = t.replace(/```[\s\S]*?(```|$)/g, ' (bloc de code) ');
    t = t.replace(/`([^`]+)`/g, '$1');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    t = t.replace(/(^|\s)[#>*_-]{1,4}(\s|$)/g, '$1');
    t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');
    t = t.replace(/(\*|_)([^*_]+)\1/g, '$2');
    t = t.replace(/^\s*\d+[.)]\s+/gm, '');
    t = t.replace(/\s{2,}/g, ' ');
    return t.trim();
  }

  window.NovaMarkdown = { render: renderMarkdown, stripForSpeech: stripForSpeech };
})();
