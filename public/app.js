// Panel baileys_esam — JS ligero sobre Velzon.
(function () {
  // Persistencia del tema claro/oscuro entre navegaciones y sesiones.
  // Velzon aplica el tema en sessionStorage; lo reflejamos en localStorage para
  // que se mantenga también entre pestañas/sesiones, y observamos cambios.
  (function () {
    var KEY = 'baileys-theme';
    function current() {
      return document.documentElement.getAttribute('data-bs-theme') || 'light';
    }
    // Refleja el tema actual en localStorage y sessionStorage (Velzon lee
    // sessionStorage al inicializar en cada página).
    function sync() {
      var t = current();
      try { localStorage.setItem(KEY, t); } catch (e) {}
      try { sessionStorage.setItem('data-bs-theme', t); } catch (e) {}
    }
    sync();
    // Detecta cambios de tema (los hace Velzon sobre <html data-bs-theme>).
    var mo = new MutationObserver(function () { sync(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
  })();

  // Auto-ocultar alertas Bootstrap.
  document.querySelectorAll('[data-auto-hide]').forEach(function (el) {
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }, 5000);
  });

  // Botón "Mostrar QR" del card de conexión.
  var startBtn = document.getElementById('btn-start');
  var qrBox = document.getElementById('qr-box');
  if (startBtn && qrBox) {
    startBtn.addEventListener('click', function () {
      qrBox.innerHTML = '<span class="text-muted">Generando…</span>';
    });
  }

  // Polling de progreso de lote.
  document.querySelectorAll('[data-batch]').forEach(function (el) {
    var id = el.getAttribute('data-batch');
    function tick() {
      fetch('/batches/' + id + '/status')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var bar = el.querySelector('.progress-bar');
          if (bar) bar.style.width = (d.progress || 0) + '%';
          el.querySelectorAll('[data-f]').forEach(function (n) {
            var f = n.getAttribute('data-f');
            if (d[f] !== undefined) n.textContent = d[f];
          });
          var st = el.querySelector('[data-status]');
          if (st) st.textContent = d.status;
          if (d.status === 'running' || d.status === 'scheduled') setTimeout(tick, 3000);
        })
        .catch(function () {});
    }
    tick();
  });

  // Conexión: mostrar QR/periódico.
  var qr = document.getElementById('qr-box');
  if (qr) {
    var sessionId = qr.getAttribute('data-session');
    var qrLinked = false;
    function pollQr() {
      fetch('/settings/qr?session=' + encodeURIComponent(sessionId))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.qrCode) {
            qr.innerHTML = '<div class="qr"><img alt="QR" src="' + d.qrCode + '"></div>';
            setTimeout(pollQr, 5000);
          } else if (d.connected) {
            qr.innerHTML = '<span class="badge bg-success-subtle text-success">Número conectado: ' + (d.phone || '') + '</span>';
            if (!qrLinked) {
              qrLinked = true;
              toast('Número vinculado correctamente' + (d.phone ? ': ' + d.phone : ''));
              setTimeout(function () { window.location.href = '/conversations'; }, 1400);
            }
          } else {
            qr.innerHTML = '<span class="text-muted">Esperando QR…</span>';
            setTimeout(pollQr, 4000);
          }
        })
        .catch(function () { setTimeout(pollQr, 4000); });
    }
    var start = document.getElementById('btn-start');
    if (start) start.addEventListener('click', pollQr);
    pollQr();
  }

  // ── Inbox v2 ───────────────────────────────────────────────────────────────
  // Inbox de tres columnas: lista de conversaciones, hilo y panel de contacto.
  // Los datos se piden a /inbox/* (JSON); la lista y el hilo se refrescan por SSE
  // con polling de respaldo.

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function linkifyHtml(escaped) {
    return String(escaped == null ? '' : escaped).replace(
      /((?:https?:\/\/|www\.)[^\s<]+)/gi,
      function (url) {
        var href = /^www\./i.test(url) ? 'https://' + url : url;
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
      }
    );
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return d.toLocaleTimeString(); }
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' }); }
    catch (e) { return d.toLocaleString(); }
  }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd';
    try { return new Date(iso).toLocaleDateString(); } catch (e) { return ''; }
  }

  function dateKey(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }

  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    var yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    var same = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (same(d, today)) return 'Hoy';
    if (same(d, yesterday)) return 'Ayer';
    try { return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }); }
    catch (e) { return ''; }
  }

  var AV_CLASSES = ['av-0', 'av-1', 'av-2', 'av-3', 'av-4', 'av-5', 'av-6', 'av-7'];
  function avClass(name) {
    var label = String(name == null ? '' : name);
    var hash = 0;
    for (var i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
    return AV_CLASSES[Math.abs(hash) % AV_CLASSES.length];
  }
  function initials(name) {
    return (String(name == null ? '' : name).trim() || '?')
      .split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }

  var TICKS = { sending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠', received: '' };
  var QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏', '🔥', '😊', '👏'];
  var EMOJI_LIST = ['😀','😁','😂','🤣','😊','😍','🤔','😎','😢','😡','👍','👎','❤️','🔥','🎉','🙏','👏','💯','✅','❌'];

  function toast(msg, isErr) {
    var el = document.createElement('div');
    el.className = 'inbox-toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function api(url, options) {
    return fetch(url, Object.assign({
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin',
    }, options || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || d.message || r.statusText);
        return d;
      });
    });
  }

  function jsonApi(url, method, body) {
    return api(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function avatarHtml(name, cls) {
    return '<span class="' + (cls || 'avatar-xs') + ' ' + avClass(name) + '">' + escapeHtml(initials(name)) + '</span>';
  }

  /* ── Construcción de una burbuja ── */
  function buildBubble(msg, ctx) {
    var isOut = msg.direction === 'out';
    var row = document.createElement('div');
    row.className = 'bubble-row ' + (isOut ? 'out' : 'in');
    row.setAttribute('data-id', msg.id);
    row.setAttribute('data-day', dateKey(msg.occurred_at));

    // Acciones al hover (antes de la burbuja según el lado).
    var actions = buildActions(msg, ctx);
    if (isOut) { row.appendChild(actions.right); }

    var wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';

    var sender;
    if (isOut) {
      sender = (msg.sender_type === 'agent' && msg.sender && msg.sender.name) ? msg.sender.name : 'Agente';
    } else if (msg.is_group) {
      // Nombre o, si falta, el número; nunca el JID crudo (@lid).
      sender = msg.sender_name || msg.sender_phone || null;
    } else {
      sender = null;
    }
    if (sender) {
      var author = document.createElement('span');
      author.className = 'bubble-author';
      author.textContent = sender;
      // En grupos, el autor es un contacto: clic abre/crea su conversación.
      if (msg.is_group && !isOut && msg.sender_chat_id) {
        author.classList.add('bubble-author-link');
        author.title = 'Abrir conversación con ‘' + sender + '’';
        author.addEventListener('click', function () { ctx.onOpenContact(msg.sender_chat_id); });
      }
      wrap.appendChild(author);
    }

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    // Cita (clic para ir al mensaje original + contacto para abrir su chat).
    if (msg.reply_to) {
      var q = document.createElement('div');
      q.className = 'quote';
      var qBody = '<div class="quote-body">' + linkifyHtml(escapeHtml(msg.reply_to.body || '[' + msg.reply_to.content_type + ']')) + '</div>';

      var qName = msg.reply_to.sender_name || '';
      var qPhone = msg.reply_to.sender_phone || '';
      var qContact = msg.reply_to.sender_chat_id || '';
      var nameLabel = qName || qPhone || 'Contacto';
      var clickable = qContact && !/@g\.us$/.test(qContact);
      var linkCls = clickable ? ' quote-contact-link' : '';
      q.innerHTML = '<div class="quote-title">Respondiendo</div>' +
        (nameLabel !== 'Contacto' || qPhone
          ? '<div class="quote-info"><span class="quote-author' + linkCls + '">' + escapeHtml(nameLabel) + '</span>' +
            (qPhone ? '<span class="quote-wa' + linkCls + '"><span class="ri-whatsapp-line"></span> ' + escapeHtml(qPhone) + '</span>' : '') +
            (clickable ? '<span class="quote-tap"><span class="ri-corner-up-left-line"></span> Abrir conversación</span>' : '') + '</div>'
          : '') + qBody;
      if (clickable) {
        Array.prototype.forEach.call(q.querySelectorAll('.quote-contact-link'), function (el) {
          el.title = 'Abrir conversación con ' + nameLabel;
          el.addEventListener('click', function (ev) { ev.stopPropagation(); ctx.onOpenContact(qContact); });
        });
      }

      if (msg.reply_to.id) {
        q.classList.add('quote-clickable');
        q.title = 'Ir al mensaje original';
        q.addEventListener('click', function () { ctx.onGoto(msg.reply_to.id); });
      }
      bubble.appendChild(q);
    }

    // Contenido según tipo
    bubble.appendChild(buildContent(msg, ctx));

    // Meta (hora + tics + reacciones)
    var meta = document.createElement('div');
    meta.className = 'meta';
    var tick = isOut ? (TICKS[msg.status] || '') : '';
    meta.innerHTML = (tick ? '<span class="tick">' + tick + '</span>' : '') +
      '<span class="ms-1">' + fmtTime(msg.occurred_at) + '</span>';
    if (msg.reactions && msg.reactions.length) {
      var rx = document.createElement('span');
      rx.className = 'reactions';
      rx.textContent = msg.reactions.map(function (r) { return r.emoji; }).join('');
      meta.appendChild(rx);
    }
    bubble.appendChild(meta);

    wrap.appendChild(bubble);
    row.appendChild(wrap);
    if (!isOut) { row.appendChild(actions.left); }
    return row;
  }

  var MEDIA_LABELS = {
    image: ['Imagen', 'ri-image-line'],
    video: ['Video', 'ri-video-line'],
    audio: ['Audio', 'ri-mic-line'],
    document: ['Documento', 'ri-file-text-line'],
    sticker: ['Sticker', 'ri-emotion-line']
  };

  // Adjuntos que se muestran como aviso (sin descargar o no disponibles), para
  // poder completarlos cuando otro "Descargar" recupera ese tramo del chat.
  var mediaBoxes = {};

  function swapInMedia(msg, type, box) {
    var ready = {}; for (var k in msg) ready[k] = msg[k];
    ready.media_status = 'ok';
    var fresh = buildMediaNode(ready, type);
    if (fresh && box.parentNode) box.parentNode.replaceChild(fresh, box);
    delete mediaBoxes[msg.id];
  }

  // Tras recuperar un adjunto, los vecinos del mismo tramo suelen quedar
  // también recuperables: se prueban sin pedir de nuevo el historial.
  function refreshNeighbourMedia(exceptId) {
    Object.keys(mediaBoxes).forEach(function (id) {
      var entry = mediaBoxes[id];
      if (+id === exceptId || !document.body.contains(entry.box)) return;
      fetch('/media/' + id, { credentials: 'same-origin' }).then(function (r) {
        if (r.ok) swapInMedia(entry.msg, entry.type, entry.box);
      }).catch(function () {});
    });
  }

  // Aviso de adjunto sin archivo. "unfetched" = guardado sin descargar (se busca
  // en el teléfono al pulsar Descargar); "missing" = WhatsApp ya no lo tiene.
  // No se pide el archivo solo: el intento es manual.
  function mediaUnavailable(msg, type) {
    var info = MEDIA_LABELS[type] || ['Archivo', 'ri-file-line'];
    var unfetched = msg.media_status === 'unfetched';
    var box = document.createElement('div');
    box.className = 'media-missing' + (unfetched ? ' mm-unfetched' : '');
    box.innerHTML = '<span class="mm-ic ' + info[1] + '" aria-hidden="true"></span>' +
      '<span class="mm-text"><span class="mm-title">' + escapeHtml(info[0]) + (unfetched ? ' sin descargar' : ' no disponible') + '</span>' +
      '<span class="mm-sub">' + (unfetched ? 'Se busca en tu teléfono (debe estar conectado).' : 'WhatsApp ya no tiene este archivo.') + '</span></span>' +
      '<button type="button" class="mm-retry" title="Descargar el archivo desde WhatsApp">' + (unfetched ? 'Descargar' : 'Reintentar') + '</button>';
    mediaBoxes[msg.id] = { msg: msg, type: type, box: box };
    var btn = box.querySelector('.mm-retry');
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Buscando…';
      fetch('/media/' + msg.id + '?retry=1', { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('no');
        swapInMedia(msg, type, box);
        refreshNeighbourMedia(msg.id);
      }).catch(function () {
        btn.disabled = false; btn.textContent = label;
        box.classList.remove('mm-unfetched');
        box.querySelector('.mm-title').textContent = info[0] + ' no disponible';
        box.querySelector('.mm-sub').textContent = 'No se pudo obtener del teléfono ni de WhatsApp.';
        box.classList.add('mm-failed');
      });
    });
    return box;
  }

  // Si el archivo falla al cargar (borrado del disco o caducado), se reemplaza
  // por el aviso en vez de dejar un recuadro roto o un reproductor colgado.
  function guardMedia(node, target, msg, type) {
    var swapped = false;
    target.addEventListener('error', function () {
      if (swapped) return; swapped = true;
      if (node.parentNode) node.parentNode.replaceChild(mediaUnavailable(msg, type), node);
    });
    return node;
  }

  function buildMediaNode(msg, type) {
    var murl = '/media/' + msg.id;
    if (msg.media_status === 'missing' || msg.media_status === 'unfetched') return mediaUnavailable(msg, type);
    if (type === 'image' || type === 'sticker') {
      var a = document.createElement('a');
      a.className = 'js-lightbox';
      a.href = murl;
      var img = document.createElement('img');
      img.className = type === 'sticker' ? 'sticker' : 'media';
      img.alt = type === 'sticker' ? 'sticker' : 'imagen';
      img.loading = 'lazy'; img.decoding = 'async';
      if (msg.media_status === 'pending') a.classList.add('media-pending');
      img.addEventListener('load', function () { a.classList.remove('media-pending'); });
      img.src = murl;
      a.appendChild(img);
      return guardMedia(a, img, msg, type);
    }
    if (type === 'video' || type === 'audio') {
      var el = document.createElement(type);
      el.controls = true; el.preload = msg.media_status === 'pending' ? 'none' : 'metadata';
      el.src = murl;
      return guardMedia(el, el, msg, type);
    }
    return null;
  }

  function buildContent(msg, ctx) {
    var frag = document.createDocumentFragment();
    var type = msg.content_type || 'text';
    var status = msg.media_status || (msg.media_path ? 'ok' : null);
    var hasMedia = status === 'ok' || status === 'pending';
    var murl = '/media/' + msg.id;
    if (MEDIA_LABELS[type] && (status === 'missing' || status === 'unfetched')) {
      frag.appendChild(mediaUnavailable(msg, type));
      if (msg.body && type !== 'sticker') frag.appendChild(paragraph(msg.body, ctx));
    } else if ((type === 'image' || type === 'sticker' || type === 'video') && hasMedia) {
      frag.appendChild(buildMediaNode(msg, type));
      if (msg.body && type !== 'sticker') frag.appendChild(paragraph(msg.body, ctx));
    } else if (type === 'audio' && hasMedia) {
      frag.appendChild(buildMediaNode(msg, type));
      if (msg.transcription) {
        var tr = document.createElement('div');
        tr.className = 'transcript';
        tr.textContent = '🎙 ' + msg.transcription;
        frag.appendChild(tr);
      }
    } else if (type === 'document' && hasMedia) {
      var fileName = msg.media_filename || msg.body || 'Documento';
      var doc = document.createElement('div');
      doc.className = 'doc-card';
      doc.innerHTML = '<a class="doc-open" href="' + murl + '" target="_blank" rel="noopener">' +
          '<span class="ic ri-file-text-line"></span>' +
          '<span class="doc-meta"><span class="nm">' + escapeHtml(fileName) + '</span>' +
          '<span class="doc-sub">' + escapeHtml(typeForMimeLabel(msg.media_mime)) + '</span></span>' +
        '</a>' +
        '<a class="doc-download" href="' + murl + '" download="' + escapeHtml(fileName) + '" title="Descargar">' +
          '<span class="ri-download-2-line"></span></a>';
      frag.appendChild(doc);
      if (msg.body && msg.media_filename) frag.appendChild(paragraph(msg.body, ctx));
    } else if (MEDIA_LABELS[type]) {
      // Adjunto sin archivo ni forma de recuperarlo (mensajes antiguos).
      frag.appendChild(mediaUnavailable(msg, type));
      if (msg.body && type !== 'sticker') frag.appendChild(paragraph(msg.body, ctx));
    } else {
      frag.appendChild(paragraph(msg.body != null ? msg.body : '[' + type + ']', ctx));
    }
    return frag;
  }

  function paragraph(text, ctx) {
    var p = document.createElement('span');
    p.className = 'bubble-text';
    p.innerHTML = linkifyHtml(escapeHtml(text));
    if (ctx && ctx.onOpenContact) linkifyPhones(p, ctx);
    return p;
  }

  // Convierte números de WhatsApp del texto en enlaces a su conversación.
  function linkifyPhones(container, ctx) {
    var re = /\+?(\d[\d\s().-]{6,}\d)/g;
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.nodeValue || '';
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      var frag = document.createDocumentFragment();
      var last = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        var digits = m[0].replace(/\D+/g, '');
        // Solo 8-15 dígitos (números plausibles de WhatsApp).
        if (digits.length < 8 || digits.length > 15) continue;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement('a');
        a.className = 'phone-link';
        a.href = '#';
        a.setAttribute('data-phone', digits);
        a.textContent = m[0];
        a.title = 'Abrir conversación con ' + m[0];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      if (!last) return;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    Array.prototype.forEach.call(container.querySelectorAll('.phone-link'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var digits = a.getAttribute('data-phone');
        if (digits) ctx.onOpenContact(digits + '@c.us');
      });
    });
  }

  function typeForMimeLabel(mime) {
    var m = String(mime || '');
    if (m.indexOf('pdf') !== -1) return 'PDF';
    if (m.indexOf('word') !== -1 || m.indexOf('document') !== -1) return 'Documento';
    if (m.indexOf('sheet') !== -1 || m.indexOf('excel') !== -1) return 'Hoja de cálculo';
    if (m.indexOf('text') !== -1) return 'Texto';
    return 'Archivo';
  }

  function buildActions(msg, ctx) {
    function make(side) {
      var box = document.createElement('div');
      box.className = 'bubble-actions ' + side;
      box.innerHTML =
        '<button type="button" class="act-speak" title="Leer en voz alta">' +
          '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5L6 9H2v6h4l5 4V5z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15.5 8.5a5 5 0 010 7"/></svg>' +
        '</button>' +
        '<button type="button" class="act-reply" title="Responder">' +
          '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/></svg>' +
        '</button>' +
        '<button type="button" class="act-react" title="Reaccionar">' +
          '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' +
        '</button>';
      box.querySelector('.act-reply').addEventListener('click', function () { ctx.onReply(msg); });
      box.querySelector('.act-speak').addEventListener('click', function () { ctx.onSpeak(msg); });
      var reactBtn = box.querySelector('.act-react');
      reactBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var existing = box.querySelector('.emoji-pop');
        if (existing) { existing.remove(); return; }
        var pop = document.createElement('div');
        pop.className = 'emoji-pop';
        QUICK_EMOJIS.forEach(function (e) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = e;
          b.addEventListener('click', function () { ctx.onReact(msg, e); pop.remove(); });
          pop.appendChild(b);
        });
        box.appendChild(pop);
      });
      return box;
    }
    return { left: make('in'), right: make('out') };
  }

  /* ── Visor de imágenes ── */
  function openLightbox(src) {
    var box = document.getElementById('lightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'lightbox';
      box.className = 'lightbox';
      box.innerHTML = '<button type="button" class="lightbox-close" aria-label="Cerrar"><i class="ri-close-line"></i></button><img alt="" />';
      box.addEventListener('click', function () { box.classList.remove('open'); });
      document.body.appendChild(box);
    }
    box.querySelector('img').src = src;
    box.classList.add('open');
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var box = document.getElementById('lightbox');
    if (box && box.classList.contains('open')) box.classList.remove('open');
  });
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('.js-lightbox');
    if (!a) return;
    var img = a.querySelector('img');
    if (!img) return;
    ev.preventDefault();
    openLightbox(img.getAttribute('src'));
  });

  /* ── TTS ── */
  var ttsState = { current: null };
  function speakText(text, onEnd) {
    if (!('speechSynthesis' in window)) { onEnd && onEnd(); return; }
    if (ttsState.current) {
      window.speechSynthesis.cancel();
      var prev = ttsState.current;
      ttsState.current = null;
      prev.onEnd && prev.onEnd();
      if (prev.text === text) return;
    }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-BO'; u.rate = 1.05;
    u.onend = function () { ttsState.current = null; onEnd && onEnd(); };
    u.onerror = function () { ttsState.current = null; onEnd && onEnd(); };
    window.speechSynthesis.speak(u);
    ttsState.current = { text: text, onEnd: onEnd };
  }

  /* ── Grabador de voz: OGG/Opus (opus-recorder) con fallback a MediaRecorder ── */
  var opusLoading = null;
  function loadOpusRecorder() {
    if (window.Recorder) return Promise.resolve(window.Recorder);
    if (opusLoading) return opusLoading;
    opusLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/assets/libs/opus-recorder/recorder.min.js';
      s.onload = function () { resolve(window.Recorder); };
      s.onerror = function () { reject(new Error('No se pudo cargar opus-recorder')); };
      document.head.appendChild(s);
    });
    return opusLoading;
  }

  function VoiceRecorder(onSend, onCancel) {
    var wrap = document.createElement('span');
    var rec = null, timer = null, seconds = 0, mode = 'opus';

    function renderIdle() {
      wrap.className = '';
      wrap.innerHTML = '<button type="button" class="btn btn-icon btn-soft-secondary" title="Grabar nota de voz">' +
        '<span class="ri-mic-line fs-5"></span></button>';
      wrap.querySelector('button').addEventListener('click', start);
    }

    function start() {
      if (!navigator.mediaDevices) { toast('Tu navegador no soporta grabación de voz.', true); return; }
      loadOpusRecorder().then(startOpus).catch(function () { startFallback(); });
    }

    // Opus → OGG/Opus, el formato que espera WhatsApp para notas de voz.
    function startOpus(Recorder) {
      try {
        mode = 'opus';
        rec = new Recorder({
          encoderPath: '/assets/libs/opus-recorder/encoderWorker.min.js',
          numberOfChannels: 1,
          encoderSampleRate: 48000,
          encoderApplication: 2049, // VOIP
          streamPages: false,
        });
        // Con streamPages:false, ondataavailable se dispara UNA vez al terminar
        // con el OGG/Opus completo (es el mecanismo correcto, no el retorno de stop()).
        rec.ondataavailable = function (data) {
          if (data && data.byteLength) {
            var blob = new Blob([data], { type: 'audio/ogg' });
            var file = new File([blob], 'voz-' + Date.now() + '.ogg', { type: 'audio/ogg' });
            onSend(file);
          } else {
            toast('No se grabó audio. Revisá el micrófono.', true);
          }
          renderIdle();
        };
        rec.start().then(function () { tickRec(true); })
          .catch(function () { startFallback(); });
      } catch (e) { startFallback(); }
    }

    function startFallback() {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var chunks = [];
        var mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        mode = 'webm';
        mr.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        mr.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(chunks, { type: 'audio/webm' });
          var file = new File([blob], 'voz-' + Date.now() + '.webm', { type: 'audio/webm' });
          onSend(file, true);
          renderIdle();
        };
        rec = {
          stop: function () { return new Promise(function (res) { mr.onstop = function () { res(); }; mr.stop(); }); },
          cancel: function () { mr.onstop = null; mr.stop(); stream.getTracks().forEach(function (t) { t.stop(); }); },
        };
        mr.start();
        tickRec(false);
      }).catch(function () { toast('No se pudo acceder al micrófono.', true); renderIdle(); });
    }

    function tickRec(isOpus) {
      seconds = 0;
      clearInterval(timer);
      timer = setInterval(function () { seconds++; renderRec(); }, 1000);
      renderRec();
    }

    function stop() {
      clearInterval(timer);
      if (!rec) { renderIdle(); return; }
      // opus-recorder: el OGG llega por `ondataavailable`; aquí solo se pide el fin.
      try {
        rec.stop();
      } catch (e) {
        toast('Error al procesar el audio.', true);
        renderIdle();
      }
      rec = null;
    }

    function cancel() {
      clearInterval(timer);
      try { if (rec && rec.cancel) rec.cancel(); } catch (e) { /* ignore */ }
      onCancel && onCancel();
      renderIdle();
    }

    function renderRec() {
      wrap.className = '';
      wrap.innerHTML = '<span class="recorder rec"><span class="ri-record-circle-line"></span> ' + seconds + 's' +
        ' <button type="button" class="btn btn-sm btn-danger py-0 px-2 stop">Detener</button>' +
        ' <button type="button" class="btn btn-sm btn-light py-0 px-2 cancel">×</button></span>';
      wrap.querySelector('.stop').addEventListener('click', stop);
      wrap.querySelector('.cancel').addEventListener('click', cancel);
    }

    renderIdle();
    return wrap;
  }

  /* ── Inbox principal ── */
  /* ── Notas internas: componentes compartidos (ficha del contacto y /notes) ──
     Una nota registra un detalle del contacto y, si tiene fecha, un seguimiento
     pendiente que alguien del equipo marca como hecho. */
  var NoteKit = (function () {
    var DUE_PRESETS = [
      { days: 0, label: 'Hoy' },
      { days: 1, label: 'Mañana' },
      { days: 3, label: 'En 3 días' },
      { days: 7, label: 'En 1 semana' },
    ];

    function ymd(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
    function parseYmd(s) { var p = String(s || '').split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    function daysFromToday(s) { return Math.round((parseYmd(s) - parseYmd(localToday())) / 86400000); }

    function fmtDay(s) {
      try { return parseYmd(s).toLocaleDateString('es-BO', { weekday: 'short', day: 'numeric', month: 'short' }); }
      catch (e) { return s; }
    }

    // Estado del seguimiento: done | overdue | today | soon (≤7 días) | later | none.
    function dueState(n) {
      if (n.done_at) return 'done';
      if (!n.due_at) return 'none';
      var d = daysFromToday(n.due_at);
      if (d < 0) return 'overdue';
      if (d === 0) return 'today';
      return d <= 7 ? 'soon' : 'later';
    }

    function dueLabel(n) {
      if (!n.due_at) return '';
      var d = daysFromToday(n.due_at);
      if (n.done_at) return 'Era para el ' + fmtDay(n.due_at);
      if (d < -1) return 'Venció hace ' + (-d) + ' días';
      if (d === -1) return 'Venció ayer';
      if (d === 0) return 'Seguimiento hoy';
      if (d === 1) return 'Mañana';
      if (d <= 7) return 'En ' + d + ' días · ' + fmtDay(n.due_at);
      return fmtDay(n.due_at);
    }

    function relTime(iso) {
      if (!iso) return '';
      var diff = (Date.now() - new Date(iso).getTime()) / 1000;
      if (diff < 60) return 'recién';
      if (diff < 3600) return 'hace ' + Math.floor(diff / 60) + ' min';
      if (diff < 86400) return 'hace ' + Math.floor(diff / 3600) + ' h';
      if (diff < 172800) return 'ayer';
      if (diff < 604800) return 'hace ' + Math.floor(diff / 86400) + ' días';
      try { return new Date(iso).toLocaleDateString('es-BO', { day: 'numeric', month: 'short', year: 'numeric' }); }
      catch (e) { return ''; }
    }

    function tagStyle(t, on) {
      return on
        ? 'background:' + t.color + ';border-color:' + t.color + ';color:#fff'
        : 'color:' + t.color + ';border-color:' + t.color;
    }

    function tagPickerHtml(tags, selected) {
      if (!tags.length) {
        return '<span class="nk-hint">No hay etiquetas. Crealas en <a href="/notes#tags">Notas</a>.</span>';
      }
      return tags.map(function (t) {
        var on = selected.indexOf(t.id) !== -1;
        return '<button type="button" class="nk-chip' + (on ? ' on' : '') + '" data-tag="' + t.id + '" style="' + tagStyle(t, on) + '"' +
          ' aria-pressed="' + on + '">' + escapeHtml(t.name) + '</button>';
      }).join('');
    }

    function duePickerHtml(due) {
      var chips = DUE_PRESETS.map(function (p) {
        var v = addDays(p.days);
        return '<button type="button" class="nk-due-chip' + (due === v ? ' on' : '') + '" data-due="' + v + '">' + p.label + '</button>';
      }).join('');
      return '<div class="nk-due-picker">' +
        '<button type="button" class="nk-due-chip' + (!due ? ' on' : '') + '" data-due="">Sin fecha</button>' + chips +
        '<label class="nk-due-custom' + (due && !DUE_PRESETS.some(function (p) { return addDays(p.days) === due; }) ? ' on' : '') + '" title="Elegir otra fecha">' +
          '<span class="ri-calendar-event-line" aria-hidden="true"></span>' +
          '<input type="date" class="nk-due-input" value="' + escapeHtml(due || '') + '" aria-label="Fecha de seguimiento" />' +
        '</label>' +
      '</div>';
    }

    // Selector de etiquetas y fecha dentro de un contenedor; devuelve getters.
    function bindPickers(box, tags, initialTags, initialDue, onChange) {
      var selected = (initialTags || []).slice();
      var due = initialDue || '';
      var tagBox = box.querySelector('.nk-tag-picker');
      var dueBox = box.querySelector('.nk-due-wrap');
      function renderTags() {
        if (!tagBox) return;
        tagBox.innerHTML = tagPickerHtml(tags, selected);
        Array.prototype.forEach.call(tagBox.querySelectorAll('.nk-chip'), function (chip) {
          chip.addEventListener('click', function () {
            var id = Number(chip.getAttribute('data-tag'));
            var i = selected.indexOf(id);
            if (i === -1) selected.push(id); else selected.splice(i, 1);
            renderTags();
            if (onChange) onChange();
          });
        });
      }
      function renderDue() {
        if (!dueBox) return;
        dueBox.innerHTML = duePickerHtml(due);
        Array.prototype.forEach.call(dueBox.querySelectorAll('.nk-due-chip'), function (chip) {
          chip.addEventListener('click', function () { due = chip.getAttribute('data-due') || ''; renderDue(); if (onChange) onChange(); });
        });
        var input = dueBox.querySelector('.nk-due-input');
        input.addEventListener('change', function () { due = input.value || ''; renderDue(); if (onChange) onChange(); });
      }
      renderTags();
      renderDue();
      return {
        tags: function () { return selected.slice(); },
        due: function () { return due || null; },
        reset: function () { selected = []; due = ''; renderTags(); renderDue(); },
      };
    }

    function tagsHtml(n) {
      return (n.tags || []).map(function (t) {
        return '<span class="nk-tag" style="--tag:' + t.color + '">' + escapeHtml(t.name) + '</span>';
      }).join('');
    }

    function cardHtml(n, opts) {
      opts = opts || {};
      var st = dueState(n);
      var name = n.contact_name || n.contact_phone || String(n.chat_id || '').split('@')[0];
      var contact = opts.showContact
        ? '<div class="nk-contact">' + avatarHtml(name, 'avatar-xs') +
            '<a href="/conversations/' + encodeURIComponent(n.chat_id) + '" class="nk-contact-name" title="Abrir la conversación">' + escapeHtml(name) + '</a>' +
            (n.contact_phone && n.contact_phone !== name ? '<span class="nk-contact-phone">' + escapeHtml(n.contact_phone) + '</span>' : '') +
          '</div>'
        : '';
      var due = n.due_at
        ? '<span class="nk-due nk-due-' + st + '"><span class="' + (st === 'overdue' ? 'ri-alarm-warning-line' : st === 'done' ? 'ri-calendar-check-line' : 'ri-calendar-event-line') + '" aria-hidden="true"></span>' + escapeHtml(dueLabel(n)) + '</span>'
        : '';
      var meta = '<span class="nk-meta-item" title="' + escapeHtml(fmtDateTime(n.created_at)) + '">' +
          escapeHtml(n.author_name || 'Equipo') + ' · ' + escapeHtml(relTime(n.created_at)) +
          (n.updated_at ? ' · editada' : '') + '</span>' +
        (n.done_at ? '<span class="nk-meta-item nk-done-by"><span class="ri-check-double-line" aria-hidden="true"></span>Hecho por ' + escapeHtml(n.done_by_name || 'el equipo') + ' ' + escapeHtml(relTime(n.done_at)) + '</span>' : '');
      var actions = n.can_edit
        ? '<button type="button" class="nk-icon nk-edit" title="Editar nota" aria-label="Editar nota"><span class="ri-pencil-line"></span></button>' +
          '<button type="button" class="nk-icon nk-del" title="Eliminar nota" aria-label="Eliminar nota"><span class="ri-delete-bin-6-line"></span></button>'
        : '';
      var checkTitle = n.done_at ? 'Reabrir seguimiento' : (n.due_at ? 'Marcar seguimiento como hecho' : 'Marcar como resuelta');
      return '<article class="nk-card nk-' + st + '" data-id="' + n.id + '">' +
        contact +
        '<div class="nk-row">' +
          '<button type="button" class="nk-check' + (n.done_at ? ' on' : '') + '" title="' + checkTitle + '" aria-label="' + checkTitle + '" aria-pressed="' + !!n.done_at + '">' +
            '<span class="ri-check-line" aria-hidden="true"></span></button>' +
          '<div class="nk-main">' +
            '<div class="nk-view">' +
              (n.note_text ? '<p class="nk-text">' + linkifyHtml(escapeHtml(n.note_text)) + '</p>' : '') +
              (n.audio_path ? '<audio controls preload="none" src="/inbox/notes/' + n.id + '/audio"></audio>' : '') +
              ((n.tags && n.tags.length) || due ? '<div class="nk-badges">' + due + tagsHtml(n) + '</div>' : '') +
              '<div class="nk-meta">' + meta + '</div>' +
            '</div>' +
            '<div class="nk-editor" hidden></div>' +
          '</div>' +
          '<div class="nk-actions">' + actions + '</div>' +
        '</div>' +
        '<div class="nk-confirm" hidden>' +
          '<span>¿Eliminar esta nota? No se puede deshacer.</span>' +
          '<button type="button" class="btn btn-sm btn-danger nk-confirm-yes">Eliminar</button>' +
          '<button type="button" class="btn btn-sm btn-light nk-confirm-no">Cancelar</button>' +
        '</div>' +
      '</article>';
    }

    function editorHtml(n) {
      return '<textarea class="form-control nk-textarea nk-edit-text" rows="3" maxlength="4000">' + escapeHtml(n.note_text || '') + '</textarea>' +
        '<div class="nk-field-label">Etiquetas</div><div class="nk-tag-picker"></div>' +
        '<div class="nk-field-label">Seguimiento</div><div class="nk-due-wrap"></div>' +
        '<div class="nk-editor-foot">' +
          '<span class="nk-hint">Ctrl + Enter para guardar · Esc para cancelar</span>' +
          '<button type="button" class="btn btn-sm btn-light nk-edit-cancel">Cancelar</button>' +
          '<button type="button" class="btn btn-sm btn-primary nk-edit-save"><span class="ri-check-line me-1"></span>Guardar</button>' +
        '</div>';
    }

    function autosize(ta) {
      if (!ta) return;
      var fit = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; };
      ta.addEventListener('input', fit);
      fit();
    }

    // Interacción de las tarjetas: completar, editar en línea y borrar con confirmación.
    // `onChanged(note|null, id)` se llama con la nota actualizada (o null si se borró).
    function bindCards(container, opts) {
      Array.prototype.forEach.call(container.querySelectorAll('.nk-card'), function (card) {
        var id = Number(card.getAttribute('data-id'));
        var note = opts.find(id);
        if (!note) return;
        var view = card.querySelector('.nk-view');
        var editor = card.querySelector('.nk-editor');
        var confirmBox = card.querySelector('.nk-confirm');

        card.querySelector('.nk-check').addEventListener('click', function (ev) {
          var btn = ev.currentTarget;
          btn.disabled = true;
          jsonApi('/inbox/notes/' + id + '/done', 'PATCH', { done: !note.done_at })
            .then(function (updated) {
              toast(updated.done_at ? 'Seguimiento marcado como hecho' : 'Seguimiento reabierto');
              opts.onChanged(updated, id);
            })
            .catch(function (e) { btn.disabled = false; toast(e.message, true); });
        });

        var editBtn = card.querySelector('.nk-edit');
        if (editBtn) editBtn.addEventListener('click', function () {
          editor.innerHTML = editorHtml(note);
          var pickers = bindPickers(editor, opts.tags(), (note.tags || []).map(function (t) { return t.id; }), note.due_at);
          var ta = editor.querySelector('.nk-edit-text');
          var close = function () { editor.hidden = true; editor.innerHTML = ''; view.hidden = false; card.classList.remove('editing'); };
          var save = function () {
            var text = ta.value.trim();
            if (!text && !note.audio_path) { toast('La nota no puede quedar vacía', true); ta.focus(); return; }
            var saveBtn = editor.querySelector('.nk-edit-save');
            saveBtn.disabled = true;
            jsonApi('/inbox/notes/' + id, 'PUT', { text: text, due_at: pickers.due(), tag_ids: pickers.tags() })
              .then(function (updated) { toast('Nota actualizada'); opts.onChanged(updated, id); })
              .catch(function (e) { saveBtn.disabled = false; toast(e.message, true); });
          };
          editor.querySelector('.nk-edit-cancel').addEventListener('click', close);
          editor.querySelector('.nk-edit-save').addEventListener('click', save);
          ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
          });
          view.hidden = true;
          editor.hidden = false;
          card.classList.add('editing');
          autosize(ta);
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        });

        var delBtn = card.querySelector('.nk-del');
        if (delBtn) delBtn.addEventListener('click', function () {
          confirmBox.hidden = false;
          card.classList.add('confirming');
          confirmBox.querySelector('.nk-confirm-no').focus();
        });
        confirmBox.querySelector('.nk-confirm-no').addEventListener('click', function () {
          confirmBox.hidden = true;
          card.classList.remove('confirming');
        });
        confirmBox.querySelector('.nk-confirm-yes').addEventListener('click', function (ev) {
          ev.currentTarget.disabled = true;
          api('/inbox/notes/' + id, { method: 'DELETE' })
            .then(function () { toast('Nota eliminada'); opts.onChanged(null, id); })
            .catch(function (e) { ev.currentTarget.disabled = false; toast(e.message, true); });
        });
      });
    }

    return {
      dueState: dueState,
      relTime: relTime,
      fmtDay: fmtDay,
      daysFromToday: daysFromToday,
      cardHtml: cardHtml,
      bindCards: bindCards,
      bindPickers: bindPickers,
      autosize: autosize,
      tagStyle: tagStyle,
    };
  })();

  function initInbox() {
    var root = document.getElementById('inbox');
    if (!root) return;

    var state = {
      conversations: [],
      selectedSession: '',
      selectedChat: '',
      search: '',
      tab: 'individual',
      quickReplies: [],
      replyTo: null,
      messages: [],
      messagesAfter: 0,
      oldest: null,
      hasMore: false,
      loadingOlder: false,
      syntheticConv: null,
      participants: [],
      memberFilter: '',
      notes: [],
      tags: [],
      noteDraft: emptyNoteDraft(),
      notesShowDone: false,
      chatToken: 0,
      sending: false,
    };

    var els = {
      list: root.querySelector('#chatlist-items'),
      search: root.querySelector('#chat-search'),
      clear: root.querySelector('#chat-clear'),
      tabs: root.querySelector('#chat-tabs'),
      pane: root.querySelector('#chat-pane'),
      contact: root.querySelector('#contact-pane'),
      rail: root.querySelector('#list-rail'),
    };

    function selectedConversation() {
      var found = state.conversations.filter(function (c) {
        return c.session_id === state.selectedSession && c.chat_id === state.selectedChat;
      })[0];
      if (found) return found;
      var s = state.syntheticConv;
      if (s && s.session_id === state.selectedSession && s.chat_id === state.selectedChat) return s;
      return undefined;
    }

    function isGroupChat(c) {
      return /@g\.us$/.test((c && c.chat_id) || '');
    }

    function inActiveTab(c) {
      return (state.tab === 'group') === isGroupChat(c);
    }

    function loadConversations() {
      return api('/inbox/conversations')
        .then(function (rows) { state.conversations = rows; renderTabs(); renderList(); })
        .catch(function () {});
    }

    function filteredConversations() {
      var s = state.search.trim().toLowerCase();
      return state.conversations.filter(function (c) {
        if (!inActiveTab(c)) return false;
        if (!s) return true;
        var name = (c.contact && c.contact.name) || '';
        var phone = (c.contact && c.contact.phone) || '';
        var last = c.last_message_text || '';
        return (name + ' ' + phone + ' ' + last).toLowerCase().indexOf(s) !== -1;
      });
    }

    function renderTabs() {
      if (!els.tabs) return;
      ['individual', 'group'].forEach(function (t) {
        var btn = els.tabs.querySelector('[data-tab="' + t + '"]');
        if (!btn) return;
        var list = state.conversations.filter(function (c) {
          return (t === 'group') === isGroupChat(c);
        });
        btn.classList.toggle('active', state.tab === t);
        var badge = btn.querySelector('[data-count="' + t + '"]');
        if (badge) badge.textContent = list.length;
        btn.classList.toggle('has-unread', list.some(function (c) { return c.unread_count > 0; }));
      });
    }

    function renderList() {
      if (!els.list) return;
      var rows = filteredConversations();
      els.list.innerHTML = '';
      if (!rows.length) {
        if (state.search.trim()) {
          els.list.innerHTML = '<div class="cl-empty"><span class="ri-search-eye-line"></span><p>Sin coincidencias</p></div>';
        } else if (state.tab === 'group') {
          els.list.innerHTML = '<div class="cl-empty"><span class="ri-group-line"></span><p>Aún no hay grupos</p><small>Aparecerán cuando un grupo tenga actividad.</small></div>';
        } else {
          els.list.innerHTML = '<div class="cl-empty"><span class="ri-chat-smile-2-line"></span><p>Aún no hay conversaciones</p><small>Aparecerán cuando un contacto escriba.</small></div>';
        }
        return;
      }
      rows.forEach(function (c) { els.list.appendChild(renderConvo(c)); });
    }

    function convoName(c) {
      var name = c.contact && c.contact.name;
      if (name) return name;
      var phone = c.contact && c.contact.phone;
      if (phone) return phone;
      return String(c.chat_id || '').split('@')[0];
    }

    function renderConvo(c) {
      var el = document.createElement('div');
      var active = c.session_id === state.selectedSession && c.chat_id === state.selectedChat;
      el.className = 'convo' + (active ? ' active' : '') + (c.unread_count > 0 ? ' unread' : '');
      el.setAttribute('data-session', c.session_id);
      el.setAttribute('data-chat', c.chat_id);
      var isGroup = /@g\.us$/.test(c.chat_id);
      var name = convoName(c);
      var nameHtml = (isGroup ? '<span class="ri-group-line group-ico" title="Grupo"></span>' : '') + escapeHtml(name);
      var phone = (c.contact && c.contact.phone) ? c.contact.phone : '';
      el.innerHTML =
        '<span class="avatar-sm ' + avClass(name) + (isGroup ? ' is-group' : '') + '">' + escapeHtml(initials(name)) + '</span>' +
        '<div class="convo-body">' +
          '<div class="convo-top"><span class="convo-name">' + nameHtml + '</span>' +
            '<span class="convo-time">' + timeAgo(c.last_message_at) + '</span></div>' +
          '<div class="convo-last">' + escapeHtml(c.last_message_text || '—') + '</div>' +
        '</div>' +
        (c.unread_count > 0 ? '<span class="unread-pill">' + c.unread_count + '</span>' : '') +
        (phone ? '<span class="convo-phone-mini" title="' + escapeHtml(phone) + '"></span>' : '');
      el.addEventListener('click', function () { openChat(c.session_id, c.chat_id, true); });
      return el;
    }

    function emptyPane() {
      return '<div class="chat-empty-col">' +
        '<span class="ce-glow"><span class="ri-whatsapp-line"></span></span>' +
        '<h5>Tus conversaciones</h5>' +
        '<p>Elegí un chat de la lista para ver el historial y responder.</p>' +
        '</div>';
    }

    function openChat(sessionId, chatId, push, synthetic) {
      state.selectedSession = sessionId;
      state.selectedChat = chatId;
      state.tab = /@g\.us$/.test(chatId) ? 'group' : 'individual';
      state.replyTo = null;
      state.messages = [];
      state.messagesAfter = 0;
      state.oldest = null;
      state.hasMore = false;
      state.loadingOlder = false;
      state.syntheticConv = synthetic || null;
      state.participants = [];
      state.memberFilter = '';
      state.notes = [];
      state.noteDraft = emptyNoteDraft();
      state.chatToken++;
      root.classList.remove('list-hidden');
      renderTabs();
      renderList();
      renderPane();
      fetchMessages(true);
      loadNotes();
      loadTags();
      if (state.tab === 'group') loadParticipants();
      if (push) history.pushState({ chat: chatId }, '', '/conversations/' + encodeURIComponent(chatId));
      // Acuse de lectura (local + WhatsApp).
      jsonApi('/inbox/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(chatId) + '/read', 'POST').then(function () {
        var c = selectedConversation();
        if (c) c.unread_count = 0;
        renderList();
      }).catch(function () {});
    }

    function messagesUrl(params) {
      return '/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) +
        '/messages?' + params;
    }

    // Carga inicial: últimos 10. `after`: nuevos (SSE/polling). `before`: anteriores.
    function fetchMessages(reset) {
      if (!state.selectedChat) return Promise.resolve();
      var token = state.chatToken;
      var url = reset
        ? messagesUrl('limit=10')
        : messagesUrl('after=' + state.messagesAfter + '&limit=50');
      return api(url).then(function (data) {
        if (token !== state.chatToken) return; // se cambió de chat: respuesta obsoleta
        var msgs = data.messages || [];
        if (reset) {
          // El backend puede resolver el chat a otro id (@s.whatsapp.net -> @c.us):
          // se adopta el id real para que enviar/refrescar apunten al mismo chat.
          if (data.chatId && data.chatId !== state.selectedChat) {
            state.selectedChat = data.chatId;
            if (state.syntheticConv) state.syntheticConv.chat_id = data.chatId;
            renderList();
          }
          state.messages = msgs.slice();
          state.hasMore = !!data.hasMore;
          state.loadingOlder = false;
          updateCursors();
          renderThread('bottom');
        } else if (msgs.length) {
          var known = {};
          state.messages.forEach(function (m) { known[m.id] = true; });
          var added = 0;
          msgs.forEach(function (m) { if (!known[m.id]) { state.messages.push(m); added++; } });
          if (!added) return;
          // Los mensajes nuevos pueden llegar desordenados (sobre todo durante
          // la sincronización): se ordena por fecha para que el hilo no cambie.
          state.messages.sort(msgCompare);
          updateCursors();
          renderThread('auto');
        }
      }).catch(function () {});
    }

    // Orden cronológico estable (fecha y, a igual fecha, id).
    function msgCompare(a, b) {
      if (a.occurred_at < b.occurred_at) return -1;
      if (a.occurred_at > b.occurred_at) return 1;
      return a.id - b.id;
    }

    function updateCursors() {
      var max = 0;
      state.messages.forEach(function (m) { if (m.id > max) max = m.id; });
      state.messagesAfter = max;
      state.oldest = state.messages.length
        ? { occurredAt: state.messages[0].occurred_at, id: state.messages[0].id }
        : null;
    }

    // Paginación hacia atrás: trae 10 mensajes anteriores al más antiguo cargado.
    function loadOlder() {
      if (!state.selectedChat || !state.hasMore || state.loadingOlder || !state.oldest) return Promise.resolve(false);
      var body = els.pane.querySelector('.chat-body');
      var prev = body ? { scrollHeight: body.scrollHeight, scrollTop: body.scrollTop } : null;
      state.loadingOlder = true;
      if (body) {
        var hint = document.createElement('div');
        hint.className = 'older-loading';
        hint.textContent = 'Cargando mensajes anteriores…';
        body.insertBefore(hint, body.firstChild);
      }
      var token = state.chatToken;
      var before = encodeURIComponent(state.oldest.occurredAt) + '|' + state.oldest.id;
      return api(messagesUrl('before=' + before + '&limit=10')).then(function (data) {
        if (token !== state.chatToken) return false; // se cambió de chat
        var msgs = data.messages || [];
        state.hasMore = !!data.hasMore;
        state.messages = msgs.concat(state.messages);
        state.messages.sort(msgCompare);
        updateCursors();
        renderThread('keep', prev);
        return true;
      }).catch(function () { return false; }).finally(function () { state.loadingOlder = false; });
    }

    // Salta al mensaje citado; si no está cargado, va trayendo páginas anteriores.
    function goToMessage(targetId, attempts) {
      attempts = attempts || 0;
      var body = els.pane.querySelector('.chat-body');
      if (!body) return;
      var el = body.querySelector('.bubble-row[data-id="' + targetId + '"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('bubble-highlight');
        setTimeout(function () { el.classList.remove('bubble-highlight'); }, 1600);
        return;
      }
      if (state.hasMore && attempts < 40) {
        loadOlder().then(function (ok) {
          if (ok) goToMessage(targetId, attempts + 1);
          else toast('No se encontró el mensaje citado.', true);
        });
        return;
      }
      toast('El mensaje citado no está en el historial cargado.', true);
    }

    // Redibuja el hilo desde state.messages con separadores por día.
    // mode: 'bottom' (ir al final), 'keep' (preservar scroll), 'auto' (si estaba abajo).
    function renderThread(mode, prev) {
      var body = els.pane.querySelector('.chat-body');
      if (!body) return;
      state.messages.sort(msgCompare);
      var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      var prevHeight = prev ? prev.scrollHeight : body.scrollHeight;
      var prevTop = prev ? prev.scrollTop : body.scrollTop;
      body.innerHTML = '';
      if (!state.messages.length) {
        body.innerHTML = '<div class="chat-empty-col"><span class="ri-chat-smile-2-line"></span><p>Sin mensajes.</p></div>';
        return;
      }
      var lastDay = '';
      state.messages.forEach(function (m) {
        var key = dateKey(m.occurred_at);
        if (key && key !== lastDay) {
          var sep = document.createElement('div');
          sep.className = 'day-sep';
          sep.innerHTML = '<span>' + escapeHtml(dayLabel(m.occurred_at)) + '</span>';
          body.appendChild(sep);
          lastDay = key;
        }
        body.appendChild(buildBubble(m, bubbleCtx));
      });
      if (mode === 'keep') {
        body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
      } else if (mode === 'bottom' || (mode === 'auto' && atBottom)) {
        body.scrollTop = body.scrollHeight;
      }
    }

    var bubbleCtx = {
      onReply: function (msg) { state.replyTo = msg; renderPane(); focusComposer(); },
      onGoto: function (id) { goToMessage(id); },
      onOpenContact: function (chatId) { if (chatId) openContactChat(chatId); },
      onReact: function (msg, emoji) {
        jsonApi('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/reaction', 'POST', { message_id: msg.id, emoji: emoji })
          .then(function () { reloadStream(); })
          .catch(function (e) { toast(e.message, true); });
      },
      onSpeak: function (msg) {
        var text = msg.content_type === 'text' ? msg.body : msg.transcription;
        if (text) speakText(text);
      },
    };

    function reloadStream() {
      state.messages = [];
      state.messagesAfter = 0;
      state.oldest = null;
      state.hasMore = false;
      state.loadingOlder = false;
      fetchMessages(true);
    }

    function renderPane() {
      var c = selectedConversation();
      if (!c) { els.pane.innerHTML = emptyPane(); els.contact.innerHTML = ''; els.contact.classList.add('d-none'); root.classList.add('contact-hidden'); return; }
      els.pane.innerHTML = chatHeaderHtml(c) + '<div class="chat-body"></div>' + composerHtml(c);
      els.contact.classList.remove('d-none');
      root.classList.remove('contact-hidden');
      bindPane(c);
      var body = els.pane.querySelector('.chat-body');
      body.innerHTML = '<div class="text-muted text-center p-3">Cargando mensajes…</div>';
    }

    function chatHeaderHtml(c) {
      var name = convoName(c);
      var isGroup = /@g\.us$/.test(c.chat_id);
      var phone = (c.contact && c.contact.phone) ? c.contact.phone : '';
      return '<div class="chat-header">' +
        '<button type="button" class="btn btn-icon btn-soft-secondary" id="toggle-list" title="Conversaciones"><span class="ri-menu-line"></span></button>' +
        avatarHtml(name, 'avatar-sm') +
        '<div class="chat-id"><div class="name">' + (isGroup ? '<span class="ri-group-line group-ico" title="Grupo"></span>' : '') + escapeHtml(name) + '</div>' +
          '<div class="sub"><span class="font-monospace">' + escapeHtml(phone) + '</span>' +
            '<span id="typing-hint" class="typing-hint"></span></div></div>' +
        '<div class="chat-actions">' +
          '<button type="button" class="btn btn-soft-primary btn-sm" id="sync-history" title="Sincronizar historial"><span class="ri-refresh-line"></span><span class="d-none d-md-inline ms-1">Sincronizar</span></button>' +
          '<button type="button" class="btn btn-icon btn-soft-secondary" id="toggle-contact" title="Ficha del contacto"><span class="ri-user-line"></span></button>' +
        '</div></div>';
    }

    function composerHtml() {
      var reply = state.replyTo
        ? '<div class="reply-preview"><div style="min-width:0;flex:1"><div class="rp-title">Respondiendo</div>' +
            '<div class="rp-body">' + escapeHtml(state.replyTo.body || '[' + state.replyTo.content_type + ']') + '</div></div>' +
            '<button type="button" id="cancel-reply" aria-label="Cancelar respuesta"><span class="ri-close-line"></span></button></div>'
        : '';
      return '<div class="composer">' + reply +
        '<div id="quick-list" class="quick-pop d-none"></div>' +
        '<div class="composer-row">' +
          '<button type="button" class="btn btn-icon btn-soft-secondary" id="btn-attach" title="Adjuntar archivo"><span class="ri-attachment-2 fs-5"></span></button>' +
          '<input type="file" id="attach-input" hidden accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" />' +
          '<span id="recorder-slot"></span>' +
          '<button type="button" class="btn btn-icon btn-soft-secondary" id="btn-quick" title="Plantillas rápidas"><span class="ri-flashlight-line fs-5"></span></button>' +
          '<div class="composer-field">' +
            '<textarea class="composer-input" id="composer-input" rows="1" placeholder="Escribí un mensaje…"></textarea>' +
            '<div id="emoji-list" class="emoji-pop2 d-none"></div>' +
          '</div>' +
          '<button type="button" class="btn btn-icon btn-soft-secondary" id="btn-emoji" title="Emoji"><span class="ri-emotion-line fs-5"></span></button>' +
          '<button type="button" class="btn btn-primary btn-icon btn-send" id="btn-send" title="Enviar"><span class="ri-send-plane-2-fill fs-5"></span></button>' +
        '</div></div>';
    }

    function bindPane(c) {
      var syncBtn = els.pane.querySelector('#sync-history');
      if (syncBtn) syncBtn.addEventListener('click', function () {
        syncBtn.disabled = true;
        jsonApi('/inbox/' + encodeURIComponent(c.session_id) + '/' + encodeURIComponent(c.chat_id) + '/sync', 'POST', { count: 50 })
          .then(function (d) { toast(d.message || 'Sincronizado'); reloadStream(); })
          .catch(function (e) { toast(e.message, true); })
          .finally(function () { syncBtn.disabled = false; });
      });

      var toggleList = els.pane.querySelector('#toggle-list');
      if (toggleList) toggleList.addEventListener('click', function () { root.classList.toggle('list-hidden'); });
      var toggleContact = els.pane.querySelector('#toggle-contact');
      if (toggleContact) toggleContact.addEventListener('click', function () {
        root.classList.toggle('contact-hidden');
      });

      var cancelReply = els.pane.querySelector('#cancel-reply');
      if (cancelReply) cancelReply.addEventListener('click', function () { state.replyTo = null; renderPane(); });

      var input = els.pane.querySelector('#composer-input');
      input.addEventListener('input', function () { autoGrow(input); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendText(); }
      });

      els.pane.querySelector('#btn-send').addEventListener('click', sendText);
      els.pane.querySelector('#btn-attach').addEventListener('click', function () { els.pane.querySelector('#attach-input').click(); });
      els.pane.querySelector('#attach-input').addEventListener('change', function (ev) {
        if (ev.target.files && ev.target.files[0]) sendFile(ev.target.files[0]);
      });
      els.pane.querySelector('#recorder-slot').appendChild(VoiceRecorder(function (file) { sendFile(file, true); }));

      // Plantillas rápidas
      var quickBtn = els.pane.querySelector('#btn-quick');
      var quickList = els.pane.querySelector('#quick-list');
      quickBtn.addEventListener('click', function () { renderQuickList(quickList, input); quickList.classList.toggle('d-none'); });

      // Emojis
      var emojiBtn = els.pane.querySelector('#btn-emoji');
      var emojiList = els.pane.querySelector('#emoji-list');
      EMOJI_LIST.forEach(function (e) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'emoji-btn'; b.textContent = e;
        b.addEventListener('click', function () { input.value += e; autoGrow(input); input.focus(); });
        emojiList.appendChild(b);
      });
      emojiBtn.addEventListener('click', function () { emojiList.classList.toggle('d-none'); });

      var body = els.pane.querySelector('.chat-body');
      body.addEventListener('scroll', function () {
        if (body.scrollTop < 40) loadOlder();
      });
    }

    function renderQuickList(container, input) {
      container.innerHTML = '';
      if (!state.quickReplies.length) {
        container.innerHTML = '<p class="text-muted small m-2">Sin plantillas. Creálas en Ajustes → Plantillas rápidas.</p>';
        return;
      }
      state.quickReplies.forEach(function (r) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'quick-item';
        b.innerHTML = '<code>/' + escapeHtml(r.shortcut) + '</code><p>' + escapeHtml(r.content) + '</p>';
        b.addEventListener('click', function () {
          input.value = renderVars(r.content);
          container.classList.add('d-none');
          autoGrow(input); input.focus();
        });
        container.appendChild(b);
      });
    }

    function renderVars(content) {
      var c = selectedConversation();
      var ct = (c && c.contact) || {};
      return String(content)
        .replace(/\{\{?\s*name\s*\}?\}/gi, ct.name || '')
        .replace(/\{\{?\s*phone\s*\}?\}/gi, ct.phone || '')
        .replace(/\{\{?\s*email\s*\}?\}/gi, ct.email || '')
        .replace(/\{\{?\s*company\s*\}?\}/gi, ct.company || '');
    }

    function focusComposer() {
      var input = els.pane.querySelector('#composer-input');
      if (input) input.focus();
    }

    function autoGrow(el) {
      if (!el || el.tagName !== 'TEXTAREA') return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }

    function sendText() {
      var input = els.pane.querySelector('#composer-input');
      if (!input) return;
      var text = input.value.trim();
      if (!text || state.sending) return;
      state.sending = true;
      var payload = { text: text, reply_to_wa_id: state.replyTo ? state.replyTo.wa_message_id : null };
      jsonApi('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/send', 'POST', payload)
        .then(function () {
          input.value = ''; autoGrow(input);
          state.replyTo = null;
          reloadStream();
          loadConversations();
        })
        .catch(function (e) { toast(e.message, true); })
        .finally(function () { state.sending = false; input.focus(); });
    }

    function sendFile(file, isVoice) {
      if (!file || state.sending) return;
      state.sending = true;
      var fd = new FormData();
      var endpoint = isVoice ? '/voice' : '/media';
      var field = isVoice ? 'audio' : 'file';
      fd.append(field, file);
      if (!isVoice) {
        var input = els.pane.querySelector('#composer-input');
        if (input && input.value.trim()) { fd.append('caption', input.value.trim()); input.value = ''; }
      }
      fetch('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + endpoint, {
        method: 'POST', body: fd, headers: { 'Accept': 'application/json' }, credentials: 'same-origin',
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Error al enviar');
        reloadStream(); loadConversations();
      }); }).catch(function (e) { toast(e.message, true); })
        .finally(function () { state.sending = false; });
    }

    /* ── Panel de contacto ── */
    function loadNotes() {
      if (!state.selectedChat) return;
      var token = state.chatToken;
      api('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/notes')
        .then(function (notes) { if (token !== state.chatToken) return; state.notes = notes || []; refreshNotesSection(); })
        .catch(function () { if (token !== state.chatToken) return; state.notes = []; refreshNotesSection(); });
    }

    // Solo la lista si la ficha ya está dibujada; si no, la ficha completa (primer render).
    function refreshNotesSection() {
      if (els.contact.querySelector('#nk-list')) renderNotesList();
      else renderContact();
    }

    // Etiquetas de notas (globales).
    function loadTags() {
      return api('/notes/tags')
        .then(function (d) {
          state.tags = (d && d.tags) || [];
          if (!selectedConversation()) return;
          if (els.contact.querySelector('#nk-composer')) { renderNoteComposer(); renderNotesList(); } else renderContact();
        })
        .catch(function () {});
    }

    function emptyNoteDraft() { return { open: false, text: '', tags: [], due: '' }; }

    function notesSectionHtml() {
      return '<div class="panel-section nk-section">' +
        '<div class="nk-section-head">' +
          '<h6><span class="ri-sticky-note-line"></span> Notas internas</h6>' +
          '<span class="nk-counts" id="nk-counts"></span>' +
        '</div>' +
        '<p class="nk-intro">Lo que sabés del contacto y no queda en el chat: preferencias, acuerdos, próximos pasos. Solo lo ve tu equipo.</p>' +
        '<div id="nk-composer"></div>' +
        '<div id="nk-list" class="nk-list"></div>' +
      '</div>';
    }

    // Compositor: plegado por defecto; el borrador sobrevive a los re-render.
    function renderNoteComposer() {
      var box = els.contact.querySelector('#nk-composer');
      if (!box) return;
      var d = state.noteDraft;
      if (!d.open) {
        box.innerHTML = '<button type="button" class="nk-composer-collapsed">' +
          '<span class="ri-add-line" aria-hidden="true"></span> Agregar una nota sobre este contacto</button>';
        box.firstChild.addEventListener('click', function () {
          d.open = true;
          renderNoteComposer();
          var t = box.querySelector('textarea');
          if (t) t.focus();
        });
        return;
      }
      box.innerHTML = '<form class="nk-composer" novalidate>' +
        '<textarea class="form-control nk-textarea" rows="3" maxlength="4000" aria-label="Texto de la nota"' +
          ' placeholder="Ej.: Prefiere que lo llamen por la tarde. Consultó por el diplomado; volver a escribirle con el cronograma."></textarea>' +
        '<div class="nk-field-label">Etiquetas</div><div class="nk-tag-picker"></div>' +
        '<div class="nk-field-label">¿Requiere seguimiento?</div><div class="nk-due-wrap"></div>' +
        '<div class="nk-composer-foot">' +
          '<span class="nk-rec" title="Grabar una nota de voz"></span>' +
          '<span class="nk-hint">Ctrl + Enter</span>' +
          '<button type="button" class="btn btn-sm btn-light nk-cancel">Cancelar</button>' +
          '<button type="submit" class="btn btn-sm btn-primary nk-save"><span class="ri-save-3-line me-1"></span>Registrar</button>' +
        '</div>' +
      '</form>';
      var form = box.querySelector('form');
      var ta = form.querySelector('textarea');
      ta.value = d.text;
      ta.addEventListener('input', function () { d.text = ta.value; });
      var pickers = NoteKit.bindPickers(form, state.tags, d.tags, d.due, function () {
        d.tags = pickers.tags();
        d.due = pickers.due() || '';
      });
      NoteKit.autosize(ta);

      var notesUrl = '/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/notes';
      var token = state.chatToken;
      var done = function () {
        if (token !== state.chatToken) return;
        state.noteDraft = emptyNoteDraft();
        renderNoteComposer();
        loadNotes();
        toast('Nota registrada');
      };
      var submit = function () {
        var text = ta.value.trim();
        if (!text) { toast('Escribí la nota (o grabá un audio)', true); ta.focus(); return; }
        var btn = form.querySelector('.nk-save');
        btn.disabled = true;
        jsonApi(notesUrl, 'POST', { text: text, due_at: pickers.due(), tag_ids: pickers.tags() })
          .then(done)
          .catch(function (e) { btn.disabled = false; toast(e.message, true); });
      };
      form.addEventListener('submit', function (ev) { ev.preventDefault(); submit(); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        if (e.key === 'Escape' && !ta.value.trim()) { e.preventDefault(); state.noteDraft = emptyNoteDraft(); renderNoteComposer(); }
      });
      form.querySelector('.nk-cancel').addEventListener('click', function () {
        state.noteDraft = emptyNoteDraft();
        renderNoteComposer();
      });
      form.querySelector('.nk-rec').appendChild(VoiceRecorder(function (file) {
        var fd = new FormData();
        fd.append('audio', file);
        if (ta.value.trim()) fd.append('text', ta.value.trim());
        if (pickers.due()) fd.append('due_at', pickers.due());
        fd.append('tag_ids', JSON.stringify(pickers.tags()));
        fetch(notesUrl, { method: 'POST', body: fd, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('No se pudo guardar la nota de voz'); done(); })
          .catch(function (e) { toast(e.message, true); });
      }));
    }

    // Lista: pendientes arriba (por fecha de seguimiento) y resueltas plegadas.
    function renderNotesList() {
      var list = els.contact.querySelector('#nk-list');
      if (!list) return;
      var notes = state.notes || [];
      var open = notes.filter(function (n) { return !n.done_at; });
      var done = notes.filter(function (n) { return n.done_at; });
      var overdue = open.filter(function (n) { return NoteKit.dueState(n) === 'overdue'; }).length;
      var today = open.filter(function (n) { return NoteKit.dueState(n) === 'today'; }).length;
      var counts = els.contact.querySelector('#nk-counts');
      if (counts) {
        counts.innerHTML =
          (overdue ? '<span class="nk-count danger">' + overdue + ' vencida' + (overdue > 1 ? 's' : '') + '</span>' : '') +
          (today ? '<span class="nk-count warn">' + today + ' hoy</span>' : '') +
          (notes.length ? '<span class="nk-count">' + notes.length + '</span>' : '');
      }
      if (!notes.length) {
        list.innerHTML = '<div class="nk-empty"><span class="ri-sticky-note-add-line" aria-hidden="true"></span>' +
          '<p>Todavía no hay notas sobre este contacto.</p></div>';
        return;
      }
      var card = function (n) { return NoteKit.cardHtml(n); };
      list.innerHTML = open.map(card).join('') +
        (done.length
          ? '<details class="nk-done-group"' + (state.notesShowDone ? ' open' : '') + '>' +
              '<summary>Resueltas (' + done.length + ')</summary>' + done.map(card).join('') + '</details>'
          : '');
      var group = list.querySelector('.nk-done-group');
      if (group) group.addEventListener('toggle', function () { state.notesShowDone = group.open; });
      NoteKit.bindCards(list, {
        find: function (id) { return notes.filter(function (n) { return n.id === id; })[0]; },
        tags: function () { return state.tags; },
        onChanged: function () { loadNotes(); },
      });
    }

    // Miembros del grupo (solo para chats de grupo).
    function loadParticipants() {
      if (!state.selectedChat) return;
      var token = state.chatToken;
      api('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/participants')
        .then(function (list) { if (token !== state.chatToken) return; state.participants = list || []; renderContact(); })
        .catch(function () { if (token !== state.chatToken) return; state.participants = []; });
    }

    // Abre la conversación existente con un contacto o crea una si no la hay.
    // Resuelve variantes de JID (@lid, @s.whatsapp.net) al chat ya guardado.
    function openContactChat(jid, name) {
      if (!jid) return;
      var c = findConversation(jid);
      if (c) { openChat(c.session_id, c.chat_id, true); return; }
      openChat(state.selectedSession, jid, true, {
        id: 0,
        session_id: state.selectedSession,
        chat_id: jid,
        status: 'open',
        unread_count: 0,
        last_message_text: null,
        last_message_at: null,
        last_direction: null,
        created_at: null,
        contact: { id: null, name: name || null, phone: memberPhone(jid), email: null, company: null, avatar_path: null },
      });
    }

    // Busca la conversación de un contacto tolerando @lid / @c.us / @s.whatsapp.net.
    function findConversation(jid) {
      var base = String(jid || '').trim();
      var digits = base.replace(/@.*$/, '').replace(/\D+/g, '');
      var variants = {};
      variants[base] = true;
      if (digits) { variants[digits + '@c.us'] = true; variants[digits + '@s.whatsapp.net'] = true; variants[digits + '@lid'] = true; }
      var found;
      state.conversations.some(function (c) {
        if (variants[c.chat_id]) { found = c; return true; }
        return false;
      });
      return found;
    }

    function memberPhone(jid) {
      var m = String(jid || '').match(/^(\d+)@/);
      return m ? m[1] : null;
    }

    function memberLabel(p) {
      return p.name || p.phone || memberPhone(p.id) || String(p.id || '').split('@')[0];
    }

    function renderContact() {
      var c = selectedConversation();
      if (!c) return;
      var name = convoName(c);
      var ct = c.contact || {};
      var membersHtml = '';
      if (state.tab === 'group') {
        var members = state.participants || [];
        membersHtml = '<div class="panel-section"><h6><span class="ri-group-line"></span> Miembros del grupo (' + members.length + ')</h6>' +
          '<label class="members-search" for="members-search">' +
            '<span class="ri-search-line"></span>' +
            '<input type="search" id="members-search" placeholder="Buscar miembro por nombre o número…" autocomplete="off" />' +
          '</label>' +
          '<div class="members-list" id="members-list"></div></div>';
      }

      els.contact.innerHTML =
        '<div class="contact-head">' + avatarHtml(name, 'avatar-xl') +
          '<div class="contact-name">' + escapeHtml(ct.name || 'Sin nombre') + '</div>' +
          '<div class="contact-phone">' + escapeHtml(ct.phone || '') + '</div>' +
          (ct.email ? '<div class="contact-email">' + escapeHtml(ct.email) + '</div>' : '') +
        '</div>' +
        membersHtml +
        notesSectionHtml() +
        '<div class="panel-section contact-meta"><h6>Conversación</h6><dl>' +
          '<dt>Inicio</dt><dd>' + (c.created_at ? new Date(c.created_at).toLocaleDateString() : '—') + '</dd>' +
          '<dt>Último mensaje</dt><dd>' + timeAgo(c.last_message_at) + '</dd>' +
        '</dl></div>';

      // Notas internas: compositor (con borrador) y lista.
      renderNoteComposer();
      renderNotesList();

      // Miembros del grupo: buscador + clic para iniciar conversación.
      var msearch = els.contact.querySelector('#members-search');
      if (msearch) {
        msearch.value = state.memberFilter || '';
        msearch.addEventListener('input', function () {
          state.memberFilter = msearch.value;
          renderMembers();
        });
        renderMembers();
      }
    }

    // Lista de miembros filtrada por el buscador (nombre, número o JID).
    function renderMembers() {
      var box = els.contact.querySelector('#members-list');
      if (!box) return;
      var list = state.participants || [];
      var q = (state.memberFilter || '').trim().toLowerCase();
      var rows = q
        ? list.filter(function (p) {
            return ((p.name || '') + ' ' + (p.phone || '') + ' ' + (p.id || '')).toLowerCase().indexOf(q) !== -1;
          })
        : list;
      if (!rows.length) {
        box.innerHTML = '<p class="text-muted small fst-italic">' +
          (list.length ? 'Sin coincidencias' : 'Cargando miembros…') + '</p>';
        return;
      }
      box.innerHTML = rows.map(function (p) {
        var nm = p.name || '';
        var num = p.phone ? '+' + p.phone : '';
        var primary = nm || num || String(p.id || '').split('@')[0];
        var initialsName = memberLabel(p);
        return '<button type="button" class="member-item" data-jid="' + escapeHtml(p.id) + '" title="Iniciar conversación">' +
          '<span class="avatar-xs ' + avClass(initialsName) + '">' + escapeHtml(initials(initialsName)) + '</span>' +
          '<span class="member-main">' +
            '<span class="member-name">' + escapeHtml(primary) + '</span>' +
            (nm && num ? '<span class="member-num">' + escapeHtml(num) + '</span>' : '') +
          '</span>' +
          (p.admin ? '<span class="member-admin">admin</span>' : '<span class="member-msg ri-chat-1-line"></span>') +
          '</button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.member-item'), function (btn) {
        btn.addEventListener('click', function () {
          var jid = btn.getAttribute('data-jid');
          var nmEl = btn.querySelector('.member-name');
          if (jid) openContactChat(jid, nmEl ? nmEl.textContent : null);
        });
      });
    }

    /* ── Solapas Números / Grupos ── */
    if (els.tabs) {
      Array.prototype.forEach.call(els.tabs.querySelectorAll('.cl-tab'), function (btn) {
        btn.addEventListener('click', function () {
          var t = btn.getAttribute('data-tab');
          if (t && t !== state.tab) { state.tab = t; renderTabs(); renderList(); }
        });
      });
    }

    /* ── Búsqueda local / riel ── */
    if (els.search) {
      els.search.addEventListener('input', function () {
        state.search = els.search.value;
        if (els.clear) els.clear.hidden = !state.search;
        renderList();
      });
    }
    if (els.clear) els.clear.addEventListener('click', function () {
      els.search.value = ''; state.search = ''; els.clear.hidden = true; renderList(); els.search.focus();
    });
    if (els.rail) els.rail.addEventListener('click', function () { root.classList.remove('list-hidden'); });

    /* ── SSE + polling ── */
    function initLive() {
      if (window.EventSource) {
        var es = new EventSource('/events');
        var timer = null;
        // Agrupa ráfagas de eventos (p. ej. cientos de mensajes offline al
        // reconectar): refresca como mucho cada ~1,5 s. Antes era un debounce
        // puro que se reiniciaba con cada evento y no refrescaba hasta que la
        // ráfaga terminaba, por eso "tardaba" en verse lo recibido.
        var lastRun = 0;
        var flush = function () {
          timer = null; lastRun = Date.now();
          loadConversations();
          if (state.selectedChat) fetchMessages(false);
        };
        var queue = function () {
          if (timer) return;
          var wait = Math.max(400, 1500 - (Date.now() - lastRun));
          timer = setTimeout(flush, wait);
        };
        es.addEventListener('media', function (e) {
          // Llegó en segundo plano un adjunto offline: re-renderiza el chat abierto.
          try {
            var d = JSON.parse(e.data);
            if (d && d.chatId === state.selectedChat) queue();
          } catch (_) {}
        });
        ['message', 'ack', 'read', 'conversation', 'reaction'].forEach(function (evt) {
          es.addEventListener(evt, function (e) {
            try {
              var d = JSON.parse(e.data);
              if (d && d.chatId && state.selectedChat && d.chatId !== state.selectedChat) { queue(); return; }
            } catch (_) {}
            queue();
          });
        });
        es.addEventListener('presence', function (e) {
          var d; try { d = JSON.parse(e.data); } catch (_) { return; }
          if (!d || d.chatId !== state.selectedChat) return;
          var hint = els.pane.querySelector('#typing-hint');
          if (hint) hint.textContent = d.typing ? 'escribiendo…' : '';
        });
        es.onerror = function () {};
      }
      setInterval(function () { loadConversations(); if (state.selectedChat) fetchMessages(false); }, 20000);
    }

    /* ── Arranque ── */
    loadConversations();
    api('/inbox/quick-replies').then(function (q) { state.quickReplies = q; }).catch(function () {});
    initLive();

    // Selector de sesión/número para administradores con más de una sesión.
    api('/inbox/sessions').then(function (list) {
      var sessions = (list && list.sessions) || [];
      var head = root.querySelector('.chatlist-head');
      if (!head || sessions.length < 2) return;
      var sel = document.createElement('select');
      sel.className = 'form-select form-select-sm';
      sel.style.maxWidth = '9rem';
      var all = document.createElement('option');
      all.value = ''; all.textContent = 'Todas';
      sel.appendChild(all);
      sessions.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id; o.textContent = s.phone || s.expected_phone || s.name;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { loadConversations(); });
      head.appendChild(sel);
    }).catch(function () {});

    var initialChat = root.getAttribute('data-active');
    if (initialChat) {
      loadConversations().then(function () {
        var found = state.conversations.filter(function (c) { return c.chat_id === initialChat; })[0];
        if (found) openChat(found.session_id, found.chat_id, false);
      });
    }
  }

  /* ── Página de Notas: tablero de seguimiento + etiquetas ── */
  function initNotes() {
    var root = document.getElementById('notes-page');
    if (!root) return;

    var STATUS = [
      { key: 'overdue', label: 'Vencidas', icon: 'ri-alarm-warning-line', tone: 'danger' },
      { key: 'today', label: 'Para hoy', icon: 'ri-sun-line', tone: 'warn' },
      { key: 'week', label: 'Próximos 7 días', icon: 'ri-calendar-event-line', tone: 'info' },
      { key: 'pending', label: 'Pendientes', icon: 'ri-time-line', tone: 'brand' },
      { key: 'done', label: 'Resueltas', icon: 'ri-check-double-line', tone: 'ok' },
      { key: 'all', label: 'Todas', icon: 'ri-stack-line', tone: 'mute' },
    ];
    var GROUP_LABELS = {
      overdue: 'Vencidas', today: 'Para hoy', soon: 'Próximos 7 días',
      later: 'Más adelante', none: 'Sin fecha de seguimiento', done: 'Resueltas',
    };
    var GROUP_ORDER = ['overdue', 'today', 'soon', 'later', 'none', 'done'];

    var els = {
      stats: root.querySelector('#np-stats'),
      search: root.querySelector('#notes-search'),
      order: root.querySelector('#notes-order'),
      mine: root.querySelector('#notes-mine'),
      active: root.querySelector('#np-active'),
      list: root.querySelector('#notes-list'),
      tags: root.querySelector('#np-tags'),
      manage: root.querySelector('#np-manage'),
      tagForm: root.querySelector('#np-tag-form'),
      tagName: root.querySelector('#tag-name'),
      tagColors: root.querySelector('#tag-colors'),
      tagSave: root.querySelector('#tag-save'),
    };
    var st = { status: 'pending', tag: null, tags: [], colors: ['#045474'], color: '#045474', notes: [], stats: null, managing: false };

    function loadTags() {
      return api('/notes/tags').then(function (d) {
        st.tags = (d && d.tags) || [];
        if (d && d.colors && d.colors.length) st.colors = d.colors;
        if (st.colors.indexOf(st.color) === -1) st.color = st.colors[0];
        if (st.tag && !st.tags.some(function (t) { return t.id === st.tag; })) st.tag = null;
        renderTags();
        renderColors();
        renderActive();
      }).catch(function () {});
    }

    function loadNotes() {
      var p = ['status=' + st.status, 'order=' + (els.order.value || 'due')];
      if (els.search.value.trim()) p.push('q=' + encodeURIComponent(els.search.value.trim()));
      if (st.tag) p.push('tag=' + st.tag);
      if (els.mine.checked) p.push('mine=1');
      els.list.classList.add('loading');
      return api('/notes/all?' + p.join('&')).then(function (d) {
        st.notes = (d && d.notes) || [];
        st.stats = d && d.stats;
        renderStats();
        renderNotes();
      }).catch(function (e) { toast(e.message, true); })
        .then(function () { els.list.classList.remove('loading'); });
    }

    function refresh() { return loadNotes().then(loadTags); }

    function renderStats() {
      var s = st.stats || {};
      els.stats.innerHTML = STATUS.map(function (x) {
        var n = s[x.key] != null ? s[x.key] : 0;
        var on = st.status === x.key;
        return '<button type="button" role="tab" class="np-stat np-' + x.tone + (on ? ' on' : '') + (n ? '' : ' zero') + '" data-status="' + x.key + '" aria-selected="' + on + '">' +
          '<span class="np-stat-ic ' + x.icon + '" aria-hidden="true"></span>' +
          '<span class="np-stat-num">' + n + '</span>' +
          '<span class="np-stat-label">' + x.label + '</span>' +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(els.stats.querySelectorAll('.np-stat'), function (b) {
        b.addEventListener('click', function () { st.status = b.getAttribute('data-status'); loadNotes(); });
      });
    }

    function renderActive() {
      var t = st.tag && st.tags.filter(function (x) { return x.id === st.tag; })[0];
      els.active.innerHTML = t
        ? 'Filtrando por <span class="nk-tag" style="--tag:' + t.color + '">' + escapeHtml(t.name) + '</span>' +
          '<button type="button" class="np-clear">Quitar filtro</button>'
        : '';
      var clear = els.active.querySelector('.np-clear');
      if (clear) clear.addEventListener('click', function () { st.tag = null; renderTags(); renderActive(); loadNotes(); });
    }

    function groupKey(n) {
      if ((els.order.value || 'due') === 'created') {
        var days = Math.floor((Date.now() - new Date(n.created_at).getTime()) / 86400000);
        return days < 1 ? 'Registradas hoy' : days < 2 ? 'Ayer' : days < 7 ? 'Esta semana' : days < 31 ? 'Este mes' : 'Anteriores';
      }
      return NoteKit.dueState(n);
    }

    function renderNotes() {
      var notes = st.notes;
      if (!notes.length) {
        var msg = {
          overdue: '¡Al día! No hay seguimientos vencidos.',
          today: 'No hay seguimientos para hoy.',
          week: 'No hay seguimientos en los próximos 7 días.',
          pending: 'No hay notas pendientes de seguimiento.',
          done: 'Todavía no se marcó ninguna nota como resuelta.',
          all: 'Todavía no hay notas.',
        }[st.status];
        var filtered = els.search.value.trim() || st.tag || els.mine.checked;
        els.list.innerHTML = '<div class="np-empty"><span class="' + (st.status === 'overdue' ? 'ri-checkbox-circle-line' : 'ri-sticky-note-line') + '" aria-hidden="true"></span>' +
          '<p>' + (filtered ? 'No hay notas para los filtros elegidos.' : msg) + '</p>' +
          '<span class="np-empty-sub">Las notas se registran desde la ficha del contacto, dentro de cada conversación.</span></div>';
        return;
      }
      var byDue = (els.order.value || 'due') === 'due';
      var groups = {};
      var order = [];
      notes.forEach(function (n) {
        var k = groupKey(n);
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(n);
      });
      if (byDue) order.sort(function (a, b) { return GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b); });
      els.list.innerHTML = order.map(function (k) {
        var label = byDue ? GROUP_LABELS[k] : k;
        return '<section class="np-group np-group-' + (byDue ? k : 'time') + '">' +
          '<h6 class="np-group-title">' + escapeHtml(label) + ' <span>' + groups[k].length + '</span></h6>' +
          '<div class="np-cards">' + groups[k].map(function (n) { return NoteKit.cardHtml(n, { showContact: true }); }).join('') + '</div>' +
        '</section>';
      }).join('');
      NoteKit.bindCards(els.list, {
        find: function (id) { return st.notes.filter(function (n) { return n.id === id; })[0]; },
        tags: function () { return st.tags; },
        onChanged: function () { refresh(); },
      });
    }

    function renderTags() {
      if (!st.tags.length) {
        els.tags.innerHTML = '<p class="nk-hint">Todavía no hay etiquetas. Usá <b>Gestionar</b> para crear la primera (p. ej. "Interesado", "Pago pendiente").</p>';
        return;
      }
      if (!st.managing) {
        els.tags.innerHTML = st.tags.map(function (t) {
          var on = st.tag === t.id;
          return '<button type="button" class="np-tag' + (on ? ' on' : '') + '" data-id="' + t.id + '" aria-pressed="' + on + '">' +
            '<span class="np-tag-dot" style="background:' + t.color + '"></span>' +
            '<span class="np-tag-name">' + escapeHtml(t.name) + '</span>' +
            '<span class="np-tag-count" title="' + t.pending + ' pendientes de ' + t.notes + ' notas">' +
              (t.pending ? '<b>' + t.pending + '</b> / ' : '') + t.notes + '</span>' +
          '</button>';
        }).join('');
        Array.prototype.forEach.call(els.tags.querySelectorAll('.np-tag'), function (b) {
          b.addEventListener('click', function () {
            var id = Number(b.getAttribute('data-id'));
            st.tag = st.tag === id ? null : id;
            renderTags(); renderActive(); loadNotes();
          });
        });
        return;
      }
      els.tags.innerHTML = st.tags.map(function (t) {
        return '<div class="np-tag-edit" data-id="' + t.id + '">' +
          '<input type="color" class="np-tag-color" value="' + t.color + '" aria-label="Color de ' + escapeHtml(t.name) + '" />' +
          '<input class="form-control form-control-sm np-tag-input" value="' + escapeHtml(t.name) + '" maxlength="40" aria-label="Nombre de la etiqueta" />' +
          '<button type="button" class="nk-icon np-tag-save" title="Guardar cambios" aria-label="Guardar cambios"><span class="ri-check-line"></span></button>' +
          '<button type="button" class="nk-icon nk-del np-tag-del" title="Eliminar etiqueta" aria-label="Eliminar etiqueta"><span class="ri-delete-bin-6-line"></span></button>' +
          '<div class="np-tag-confirm" hidden>' +
            '<span>Se quitará de ' + t.notes + ' nota' + (t.notes === 1 ? '' : 's') + '.</span>' +
            '<button type="button" class="btn btn-sm btn-danger np-yes">Eliminar</button>' +
            '<button type="button" class="btn btn-sm btn-light np-no">Cancelar</button>' +
          '</div>' +
        '</div>';
      }).join('');
      Array.prototype.forEach.call(els.tags.querySelectorAll('.np-tag-edit'), function (row) {
        var id = Number(row.getAttribute('data-id'));
        var save = function () {
          jsonApi('/notes/tags/' + id, 'PUT', {
            name: row.querySelector('.np-tag-input').value,
            color: row.querySelector('.np-tag-color').value,
          }).then(function () { toast('Etiqueta actualizada'); refresh(); })
            .catch(function (e) { toast(e.message, true); });
        };
        row.querySelector('.np-tag-save').addEventListener('click', save);
        row.querySelector('.np-tag-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        var confirmBox = row.querySelector('.np-tag-confirm');
        row.querySelector('.np-tag-del').addEventListener('click', function () { confirmBox.hidden = false; });
        row.querySelector('.np-no').addEventListener('click', function () { confirmBox.hidden = true; });
        row.querySelector('.np-yes').addEventListener('click', function () {
          api('/notes/tags/' + id, { method: 'DELETE' })
            .then(function () { toast('Etiqueta eliminada'); if (st.tag === id) st.tag = null; refresh(); })
            .catch(function (e) { toast(e.message, true); });
        });
      });
    }

    function renderColors() {
      els.tagColors.innerHTML = st.colors.map(function (c) {
        return '<button type="button" class="tag-color' + (c === st.color ? ' on' : '') + '" data-color="' + c + '" style="background:' + c + '" aria-label="Color ' + c + '" aria-pressed="' + (c === st.color) + '"></button>';
      }).join('');
      Array.prototype.forEach.call(els.tagColors.querySelectorAll('.tag-color'), function (b) {
        b.addEventListener('click', function () { st.color = b.getAttribute('data-color'); renderColors(); });
      });
    }

    function setManaging(on) {
      st.managing = on;
      els.manage.textContent = on ? 'Listo' : 'Gestionar';
      els.manage.setAttribute('aria-pressed', String(on));
      els.tagForm.hidden = !on;
      renderTags();
      if (on) els.tagName.focus();
    }

    els.manage.addEventListener('click', function () { setManaging(!st.managing); });
    var createTag = function () {
      var name = els.tagName.value.trim();
      if (!name) { toast('Escribí un nombre para la etiqueta', true); els.tagName.focus(); return; }
      jsonApi('/notes/tags', 'POST', { name: name, color: st.color })
        .then(function () { els.tagName.value = ''; toast('Etiqueta creada'); return loadTags(); })
        .catch(function (e) { toast(e.message, true); });
    };
    els.tagSave.addEventListener('click', createTag);
    els.tagName.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createTag(); } });

    var timer = null;
    els.search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(loadNotes, 250); });
    els.order.addEventListener('change', loadNotes);
    els.mine.addEventListener('change', loadNotes);

    // Desde el compositor de la ficha se llega con #tags para crear etiquetas.
    loadTags().then(function () { if (location.hash === '#tags') setManaging(true); });
    loadNotes();
  }

  /* ── Actividad por usuario (auto-refresco) ── */
  function initActivity() {
    var card = document.getElementById('activity-card');
    if (!card) return;
    var body = document.getElementById('activity-body');
    var updated = document.getElementById('activity-updated');
    var btn = document.getElementById('activity-refresh');
    var url = card.getAttribute('data-activity-url') || '/api/activity';
    var params = {
      from: card.getAttribute('data-activity-from') || '',
      to: card.getAttribute('data-activity-to') || '',
      account: card.getAttribute('data-activity-account') || '',
      area: card.getAttribute('data-activity-area') || '',
    };

    function apartadoBadge(a) {
      var kind = a === 'Académico' ? 'info' : a === 'Contable' ? 'warning' : 'secondary';
      return '<span class="badge bg-' + kind + '-subtle text-' + kind + '">' + escapeHtml(a) + '</span>';
    }

    function render(data) {
      var rows = (data && data.rows) || [];
      if (!rows.length) {
        body.innerHTML = '<div class="text-muted text-center py-3">Sin actividad en el período seleccionado.</div>';
        return;
      }
      var html = '<div class="table-responsive"><table class="table table-hover align-middle mb-0">' +
        '<thead class="table-light"><tr><th>Usuario</th><th>Número</th><th>Apartado</th>' +
        '<th class="text-end">Cronogramas</th><th class="text-end">Panel ESAM</th><th class="text-end">Total</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        html += '<tr>' +
          '<td>' + escapeHtml(r.name) + '</td>' +
          '<td><span class="ff-monospace">' + escapeHtml(r.phone || '—') + '</span></td>' +
          '<td>' + apartadoBadge(r.apartado) + '</td>' +
          '<td class="text-end">' + r.cronogramas + '</td>' +
          '<td class="text-end">' + r.panel + '</td>' +
          '<td class="text-end"><b>' + r.total + '</b></td>' +
          '</tr>';
      });
      var t = data.totals || { cronogramas: 0, panel: 0, total: 0 };
      html += '</tbody><tfoot><tr class="table-light"><th>Total</th><th></th><th></th>' +
        '<th class="text-end">' + t.cronogramas + '</th>' +
        '<th class="text-end">' + t.panel + '</th>' +
        '<th class="text-end">' + t.total + '</th></tr></tfoot></table></div>';
      body.innerHTML = html;
    }

    function load() {
      var qs = [];
      Object.keys(params).forEach(function (k) { if (params[k]) qs.push(k + '=' + encodeURIComponent(params[k])); });
      return fetch(url + (qs.length ? '?' + qs.join('&') : ''), { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          render(d);
          if (updated) updated.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
        })
        .catch(function () {});
    }

    if (btn) btn.addEventListener('click', load);
    load();
    setInterval(load, 60000);
  }

  initInbox();
  initNotes();
  initActivity();
})();
