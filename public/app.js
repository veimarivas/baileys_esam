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
          } else if (d.reason) {
            // Sin QR: se explica por qué y qué hacer (y se sigue intentando).
            qr.innerHTML = '<div class="qr-reason">' +
              '<div class="qr-reason-title"><i class="ri-error-warning-line"></i> ' + escapeHtml(d.reason.title) + '</div>' +
              (d.reason.detail ? '<div class="qr-reason-text">' + escapeHtml(d.reason.detail) + '</div>' : '') +
              '<div class="qr-reason-action"><b>Qué hacer:</b> ' + escapeHtml(d.reason.action) + '</div>' +
              '<div class="qr-reason-wait"><span class="spinner-border spinner-border-sm"></span> Reintentando…</div></div>';
            setTimeout(pollQr, 8000);
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

  // Una sola conexión SSE por página, compartida por el inbox, /notes y los
  // recordatorios. Solo en páginas del panel con acceso a Conversaciones.
  var liveSourceInstance;
  function liveSource() {
    if (liveSourceInstance !== undefined) return liveSourceInstance;
    liveSourceInstance = null;
    if (window.EventSource && document.getElementById('page-topbar') && document.querySelector('a[href="/conversations"]')) {
      liveSourceInstance = new EventSource('/events');
    }
    return liveSourceInstance;
  }

  // `action` opcional: { label, run } agrega un botón (p. ej. «Deshacer»).
  function toast(msg, isErr, action) {
    var el = document.createElement('div');
    el.className = 'inbox-toast' + (isErr ? ' err' : '') + (action ? ' has-action' : '');
    el.textContent = msg;
    if (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function () { el.remove(); action.run(); });
      el.appendChild(btn);
    }
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, action ? 6000 : 3200);
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

  function avatarHtml(name, cls, photoUrl, extraCls) {
    return '<span class="' + (cls || 'avatar-xs') + ' ' + avClass(name) + (extraCls ? ' ' + extraCls : '') + (photoUrl ? ' has-photo' : '') + '">' +
      escapeHtml(initials(name)) +
      (photoUrl ? '<img src="' + escapeHtml(photoUrl) + '" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.remove(\'has-photo\');this.remove()">' : '') +
    '</span>';
  }

  // Foto de perfil de una conversación (propia o de la misma persona en otra línea).
  function convoPhoto(c) {
    return c && c.contact && c.contact.avatar && c.contact.id ? '/inbox/avatar/' + c.contact.id : null;
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

    // En grupos, la foto de perfil de quien escribió (como en WhatsApp).
    if (!isOut && msg.is_group && msg.sender_chat_id && ctx.sessionId) {
      var who = msg.sender_name || msg.sender_phone || '?';
      var av = document.createElement('span');
      av.className = 'bubble-avatar';
      av.innerHTML = avatarHtml(who, 'avatar-xs', '/inbox/participant-avatar/' + encodeURIComponent(ctx.sessionId()) + '/' + encodeURIComponent(msg.sender_chat_id));
      av.title = who;
      av.addEventListener('click', function () { ctx.onOpenContact(msg.sender_chat_id); });
      row.appendChild(av);
    }

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
        '</button>' +
        (ctx.onNote
          ? '<button type="button" class="act-note" title="Guardar como nota o tarea">' +
              '<svg class="w-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h4M7 3h10a2 2 0 012 2v14l-4-3H7a2 2 0 01-2-2V5a2 2 0 012-2z"/></svg>' +
            '</button>'
          : '');
      box.querySelector('.act-reply').addEventListener('click', function () { ctx.onReply(msg); });
      box.querySelector('.act-speak').addEventListener('click', function () { ctx.onSpeak(msg); });
      var noteBtn = box.querySelector('.act-note');
      if (noteBtn) noteBtn.addEventListener('click', function () { ctx.onNote(msg); });
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
      var at = n.due_time ? ' · ' + n.due_time : '';
      if (n.done_at) return 'Era para el ' + fmtDay(n.due_at);
      if (d < -1) return 'Venció hace ' + (-d) + ' días';
      if (d === -1) return 'Venció ayer';
      if (d === 0) return (n.due_time ? 'Hoy a las ' + n.due_time : 'Seguimiento hoy');
      if (d === 1) return 'Mañana' + at;
      if (d <= 7) return 'En ' + d + ' días · ' + fmtDay(n.due_at) + at;
      return fmtDay(n.due_at) + at;
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

    function duePickerHtml(due, time) {
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
      '</div>' +
      (due
        ? '<label class="nk-time"><span class="ri-alarm-line" aria-hidden="true"></span>Recordarme a las ' +
            '<input type="time" class="nk-time-input" value="' + escapeHtml(time || '') + '" aria-label="Hora del recordatorio" />' +
            '<span class="nk-hint">(opcional)</span></label>'
        : '');
    }

    // Selector de etiquetas y fecha dentro de un contenedor; devuelve getters.
    function bindPickers(box, tags, initialTags, initialDue, onChange, initialTime) {
      var selected = (initialTags || []).slice();
      var due = initialDue || '';
      var time = initialTime || '';
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
        dueBox.innerHTML = duePickerHtml(due, time);
        Array.prototype.forEach.call(dueBox.querySelectorAll('.nk-due-chip'), function (chip) {
          chip.addEventListener('click', function () { due = chip.getAttribute('data-due') || ''; renderDue(); if (onChange) onChange(); });
        });
        var input = dueBox.querySelector('.nk-due-input');
        input.addEventListener('change', function () { due = input.value || ''; renderDue(); if (onChange) onChange(); });
        var timeInput = dueBox.querySelector('.nk-time-input');
        if (timeInput) timeInput.addEventListener('change', function () { time = timeInput.value || ''; if (onChange) onChange(); });
      }
      renderTags();
      renderDue();
      return {
        tags: function () { return selected.slice(); },
        due: function () { return due || null; },
        time: function () { return due && time ? time : null; },
        reset: function () { selected = []; due = ''; time = ''; renderTags(); renderDue(); },
      };
    }

    function tagsHtml(n) {
      return (n.tags || []).map(function (t) {
        return '<span class="nk-tag" style="--tag:' + t.color + '">' + escapeHtml(t.name) + '</span>';
      }).join('');
    }

    // Línea (número de WhatsApp del sistema) desde la que se registró la nota.
    function lineLabel(n) {
      var name = n.session_name || '';
      var phone = n.session_phone ? '+' + String(n.session_phone).replace(/^\+/, '') : '';
      return name && phone ? name + ' · ' + phone : (name || phone || 'otra línea');
    }

    function isPinned(n) { return !!n.pinned && !n.done_at; }

    // Personas a las que se puede asignar una tarea (se pide una vez por página).
    var assigneesPromise = null;
    var assigneesData = { me: null, users: [] };
    function loadAssignees() {
      if (!assigneesPromise) {
        assigneesPromise = api('/notes/assignees')
          .then(function (d) { assigneesData = { me: d.me, users: d.users || [] }; return assigneesData; })
          .catch(function () { assigneesPromise = null; return assigneesData; });
      }
      return assigneesPromise;
    }

    function assigneeOptions(selected) {
      var me = assigneesData.me;
      var opts = '<option value="">Sin derivar</option>';
      if (me) opts += '<option value="' + me + '"' + (selected === me ? ' selected' : '') + '>Yo</option>';
      assigneesData.users.forEach(function (u) {
        if (u.id === me) return;
        var area = u.area ? ' · ' + u.area.charAt(0).toUpperCase() + u.area.slice(1) : '';
        opts += '<option value="' + u.id + '"' + (selected === u.id ? ' selected' : '') + '>' + escapeHtml((u.name || ('Usuario ' + u.id)) + area) + '</option>';
      });
      return opts;
    }

    // Llena un <select> de responsables cuando llega la lista.
    function bindAssignee(select, selected, onChange) {
      if (!select) return function () { return null; };
      var value = selected || null;
      select.innerHTML = assigneeOptions(value);
      loadAssignees().then(function () { select.innerHTML = assigneeOptions(value); });
      select.addEventListener('change', function () { value = Number(select.value) || null; if (onChange) onChange(value); });
      return function () { return value; };
    }

    function cardHtml(n, opts) {
      opts = opts || {};
      var st = dueState(n);
      var pinned = isPinned(n);
      // En la ficha del chat solo se marca el origen si vino de otra línea; en /notes siempre.
      var fromOther = opts.currentSession && n.session_id && n.session_id !== opts.currentSession;
      var origin = (fromOther || (opts.showContact && n.session_id))
        ? '<span class="nk-meta-item nk-origin' + (fromOther ? ' other' : '') + '" title="' +
            (fromOther ? 'Registrada al atender a esta persona desde otra línea' : 'Línea desde la que se registró') + '">' +
            '<span class="ri-smartphone-line" aria-hidden="true"></span>' + (fromOther ? 'Desde ' : '') + escapeHtml(lineLabel(n)) + '</span>'
        : '';
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
      var pinBadge = pinned
        ? '<span class="nk-pin-badge"><span class="ri-pushpin-2-fill" aria-hidden="true"></span>Importante</span>'
        : '';
      if (n.assigned_to) {
        pinBadge += '<span class="nk-assignee' + (n.assigned_to_me ? ' me' : '') + '" title="Responsable de la tarea">' +
          '<span class="ri-user-received-2-line" aria-hidden="true"></span>' +
          (n.assigned_to_me ? 'Para vos' : escapeHtml(n.assigned_name || 'Asignada')) + '</span>';
      }
      var canGoto = n.source_message_id && opts.onGotoMessage && n.session_id === opts.currentSession;
      var gotoLink = canGoto
        ? '<button type="button" class="nk-goto" title="Ir al mensaje del chat que originó la nota">' +
            '<span class="ri-chat-quote-line" aria-hidden="true"></span>Ver mensaje</button>'
        : '';
      var meta = '<span class="nk-meta-item" title="' + escapeHtml(fmtDateTime(n.created_at)) + '">' +
          '<span class="ri-user-3-line" aria-hidden="true"></span>' +
          escapeHtml(n.author_name || 'Equipo') + ' · ' + escapeHtml(relTime(n.created_at)) +
          (n.updated_at ? ' · editada' : '') + '</span>' +
        origin + gotoLink +
        (n.done_at ? '<span class="nk-meta-item nk-done-by"><span class="ri-check-double-line" aria-hidden="true"></span>Hecho por ' + escapeHtml(n.done_by_name || 'el equipo') + ' ' + escapeHtml(relTime(n.done_at)) + '</span>' : '');
      var pinTitle = n.pinned ? 'Quitar de importantes' : 'Marcar como importante (se fija arriba del chat en todas las líneas)';
      if (n.deleted_at) return trashCardHtml(n, opts, contact);
      var actions = '<button type="button" class="nk-icon nk-hist" title="Ver historial de cambios" aria-label="Ver historial de cambios" aria-expanded="false">' +
          '<span class="ri-history-line"></span></button>' +
        '<button type="button" class="nk-icon nk-pin' + (n.pinned ? ' on' : '') + '" title="' + pinTitle + '" aria-label="' + pinTitle + '" aria-pressed="' + !!n.pinned + '">' +
          '<span class="' + (n.pinned ? 'ri-pushpin-2-fill' : 'ri-pushpin-2-line') + '"></span></button>' +
        (n.can_edit
        ? '<button type="button" class="nk-icon nk-edit" title="Editar nota" aria-label="Editar nota"><span class="ri-pencil-line"></span></button>' +
          '<button type="button" class="nk-icon nk-del" title="Eliminar nota" aria-label="Eliminar nota"><span class="ri-delete-bin-6-line"></span></button>'
        : '');
      var checkTitle = n.done_at ? 'Reabrir' : (n.due_at ? 'Marcar tarea como hecha' : 'Marcar como resuelta');
      return '<article class="nk-card nk-' + st + (pinned ? ' nk-pinned' : '') + '" data-id="' + n.id + '">' +
        contact +
        '<div class="nk-row">' +
          '<button type="button" class="nk-check' + (n.done_at ? ' on' : '') + '" title="' + checkTitle + '" aria-label="' + checkTitle + '" aria-pressed="' + !!n.done_at + '">' +
            '<span class="ri-check-line" aria-hidden="true"></span></button>' +
          '<div class="nk-main">' +
            '<div class="nk-view">' +
              (n.note_text ? '<p class="nk-text">' + linkifyHtml(escapeHtml(n.note_text)) + '</p>' : '') +
              (n.audio_path ? '<audio controls preload="none" src="/inbox/notes/' + n.id + '/audio"></audio>' : '') +
              ((n.tags && n.tags.length) || due || pinBadge ? '<div class="nk-badges">' + pinBadge + due + tagsHtml(n) + '</div>' : '') +
              '<div class="nk-meta">' + meta + '</div>' +
            '</div>' +
            derivationHtml(n) +
            '<div class="nk-editor" hidden></div>' +
            '<div class="nk-history" hidden></div>' +
          '</div>' +
          '<div class="nk-actions">' + actions + '</div>' +
        '</div>' +
        '<div class="nk-confirm" hidden>' +
          '<span>¿Enviar esta nota a la papelera? Se puede restaurar desde Notas y tareas.</span>' +
          '<button type="button" class="btn btn-sm btn-danger nk-confirm-yes">Enviar a la papelera</button>' +
          '<button type="button" class="btn btn-sm btn-light nk-confirm-no">Cancelar</button>' +
        '</div>' +
      '</article>';
    }

    // Nota en la papelera: solo lectura, con quién la eliminó y «Restaurar».
    function trashCardHtml(n, opts, contact) {
      return '<article class="nk-card nk-trashed" data-id="' + n.id + '">' + contact +
        '<div class="nk-row"><span class="nk-trash-ic ri-delete-bin-6-line" aria-hidden="true"></span>' +
          '<div class="nk-main">' +
            (n.note_text ? '<p class="nk-text">' + linkifyHtml(escapeHtml(n.note_text)) + '</p>' : '<p class="nk-text"><i>Nota de voz</i></p>') +
            '<div class="nk-meta">' +
              '<span class="nk-meta-item"><span class="ri-user-3-line" aria-hidden="true"></span>' + escapeHtml(n.author_name || 'Equipo') + ' · ' + escapeHtml(relTime(n.created_at)) + '</span>' +
              '<span class="nk-meta-item nk-deleted-by"><span class="ri-delete-bin-line" aria-hidden="true"></span>Eliminada por ' +
                escapeHtml(n.deleted_by_name || 'el equipo') + ' ' + escapeHtml(relTime(n.deleted_at)) + '</span>' +
            '</div>' +
            '<div class="nk-history" hidden></div>' +
          '</div>' +
          '<div class="nk-trash-actions">' +
            '<button type="button" class="nk-icon nk-hist" title="Ver historial de cambios" aria-label="Ver historial de cambios" aria-expanded="false"><span class="ri-history-line"></span></button>' +
            (n.can_edit ? '<button type="button" class="btn btn-sm btn-soft-primary nk-restore"><span class="ri-arrow-go-back-line me-1"></span>Restaurar</button>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
    }

    var HISTORY_LABELS = {
      edited: 'Editó la nota',
      done: 'La marcó como hecha',
      reopened: 'La reabrió',
      pinned: 'La marcó como importante',
      unpinned: 'La quitó de importantes',
      deleted: 'La envió a la papelera',
      restored: 'La restauró',
      assigned: 'Cambió el responsable',
      snoozed: 'Pospuso el recordatorio',
      template: 'La creó desde una plantilla',
      seen: 'Vio la derivación',
      contacted: 'Confirmó que se comunicó con el contacto',
    };
    var HISTORY_ICONS = {
      edited: 'ri-pencil-line', done: 'ri-check-double-line', reopened: 'ri-restart-line',
      pinned: 'ri-pushpin-2-fill', unpinned: 'ri-unpin-line', deleted: 'ri-delete-bin-6-line', restored: 'ri-arrow-go-back-line',
      assigned: 'ri-user-received-2-line',
      snoozed: 'ri-alarm-snooze-line', template: 'ri-file-list-3-line',
      seen: 'ri-eye-line', contacted: 'ri-phone-line', stage: 'ri-kanban-view',
    };

    // Línea de tiempo: la creación sale de la propia nota; el resto, del historial.
    function historyHtml(n, entries) {
      var item = function (icon, who, what, when, extra) {
        return '<li class="nk-h-item"><span class="nk-h-ic ' + icon + '" aria-hidden="true"></span>' +
          '<div><b>' + escapeHtml(who || 'Equipo') + '</b> ' + escapeHtml(what) +
          ' <span class="nk-h-when" title="' + escapeHtml(fmtDateTime(when)) + '">' + escapeHtml(relTime(when)) + '</span>' +
          (extra || '') + '</div></li>';
      };
      var rows = [item('ri-add-circle-line', n.author_name, 'Registró la nota', n.created_at)];
      entries.forEach(function (e) {
        var extra = '';
        if (e.action === 'edited') {
          var prev = [];
          if (e.prev_text) prev.push('<span class="nk-h-prev">' + escapeHtml(e.prev_text) + '</span>');
          prev.push('<span class="nk-h-sub">Fecha: ' + escapeHtml(e.prev_due_at ? fmtDay(e.prev_due_at) : 'sin fecha') +
            (e.prev_tags && e.prev_tags.length ? ' · Etiquetas: ' + escapeHtml(e.prev_tags.join(', ')) : '') + '</span>');
          extra = '<div class="nk-h-before"><span class="nk-h-label">Antes decía</span>' + prev.join('') + '</div>';
        }
        var what = HISTORY_LABELS[e.action] || e.action;
        if (e.action === 'assigned') what = e.detail ? 'Asignó la tarea a ' + e.detail : 'Quitó el responsable';
        if (e.action === 'snoozed' && e.detail) what = 'Pospuso el recordatorio para ' + e.detail;
        if (e.action === 'template' && e.detail) what = 'La creó desde la plantilla «' + e.detail + '»';
        if (e.action === 'stage') what = 'La movió a «' + (e.detail || 'otra etapa') + '»';
        if (e.action === 'contacted' && e.detail) extra = '<div class="nk-h-before"><span class="nk-h-label">Resultado</span><span>' + escapeHtml(e.detail) + '</span></div>';
        rows.push(item(HISTORY_ICONS[e.action] || 'ri-record-circle-line', e.user_name, what, e.created_at, extra));
      });
      return '<div class="nk-h-head">Historial</div><ol class="nk-h-list">' + rows.join('') + '</ol>';
    }

    // Derivación: quién derivó a quién y en qué quedó (vista, contacto, resuelta).
    function derivationHtml(n) {
      if (!n.assigned_to || n.deleted_at) return '';
      var area = n.assigned_area ? ' · ' + n.assigned_area.charAt(0).toUpperCase() + n.assigned_area.slice(1) : '';
      var step = function (state, icon, label, detail) {
        return '<li class="nk-step is-' + state + '"><span class="' + icon + '" aria-hidden="true"></span><div><b>' + label + '</b>' +
          (detail ? '<span>' + detail + '</span>' : '') + '</div></li>';
      };
      var seen = n.seen_at
        ? step('ok', 'ri-eye-line', 'Vista', escapeHtml(relTime(n.seen_at)))
        : step(n.contacted_at ? 'ok' : 'wait', 'ri-eye-off-line', 'Sin ver', 'todavía no abrió la derivación');
      var contacted = n.contacted_at
        ? step('ok', 'ri-phone-line', 'Se comunicó', escapeHtml((n.contacted_by_name || n.assigned_name || '') + ' · ' + relTime(n.contacted_at)) +
            (n.contact_result ? '<q>' + escapeHtml(n.contact_result) + '</q>' : ''))
        : step('wait', 'ri-phone-line', 'Sin confirmar contacto', '');
      var done = n.done_at ? step('ok', 'ri-check-double-line', 'Resuelta', escapeHtml((n.done_by_name || '') + ' · ' + relTime(n.done_at))) : '';
      var digits = String(n.contact_phone || '').replace(/\D+/g, '');
      var mine = n.assigned_to_me && !n.contacted_at && !n.done_at;
      var actions = mine
        ? '<div class="nk-deriv-actions">' +
            (digits ? '<a class="btn btn-sm btn-primary" href="/conversations/' + digits + '%40c.us"><span class="ri-whatsapp-line me-1"></span>Escribirle desde mi línea</a>' +
              '<a class="btn btn-sm btn-light" href="tel:+' + digits + '"><span class="ri-phone-line me-1"></span>Llamar</a>' : '') +
            '<button type="button" class="btn btn-sm btn-soft-success nk-contacted-btn"><span class="ri-check-line me-1"></span>Ya me comuniqué</button>' +
          '</div>' +
          '<div class="nk-contact-form" hidden>' +
            '<label class="nk-field-label">¿Cómo fue la comunicación?</label>' +
            '<textarea class="form-control nk-textarea nk-contact-result" rows="2" maxlength="1000" placeholder="Ej.: Lo llamé, confirmó que paga el viernes por transferencia."></textarea>' +
            '<div class="nk-editor-foot"><span class="nk-hint">Le avisa a quien derivó y al Super Admin.</span>' +
              '<button type="button" class="btn btn-sm btn-light nk-contact-cancel">Cancelar</button>' +
              '<button type="button" class="btn btn-sm btn-success nk-contact-save">Confirmar contacto</button></div>' +
          '</div>'
        : '';
      return '<div class="nk-deriv' + (mine ? ' is-mine' : '') + '">' +
        '<div class="nk-deriv-head"><span class="ri-share-forward-line" aria-hidden="true"></span>' +
          '<span><b>' + escapeHtml(n.assigned_by_name || n.author_name || 'Alguien') + '</b> derivó a <b>' +
          (n.assigned_to_me ? 'vos' : escapeHtml(n.assigned_name || 'otra persona')) + '</b>' + escapeHtml(n.assigned_to_me ? '' : area) +
          ' · ' + escapeHtml(relTime(n.assigned_at || n.created_at)) + '</span></div>' +
        '<ol class="nk-steps">' + seen + contacted + done + '</ol>' + actions +
      '</div>';
    }

    function editorHtml(n) {
      return '<textarea class="form-control nk-textarea nk-edit-text" rows="3" maxlength="4000">' + escapeHtml(n.note_text || '') + '</textarea>' +
        '<div class="nk-field-label">Etiquetas</div><div class="nk-tag-picker"></div>' +
        '<div class="nk-field-label">Seguimiento</div><div class="nk-due-wrap"></div>' +
        '<div class="nk-field-label">Responsable</div><select class="form-select form-select-sm nk-assignee-select" aria-label="Responsable"></select>' +
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
        var histBox = card.querySelector('.nk-history');

        var histBtn = card.querySelector('.nk-hist');
        if (histBtn) histBtn.addEventListener('click', function () {
          if (!histBox.hidden) { histBox.hidden = true; histBtn.setAttribute('aria-expanded', 'false'); return; }
          histBox.hidden = false;
          histBtn.setAttribute('aria-expanded', 'true');
          histBox.innerHTML = '<div class="nk-hint">Cargando historial…</div>';
          api('/inbox/notes/' + id + '/history')
            .then(function (entries) { histBox.innerHTML = historyHtml(note, entries || []); })
            .catch(function (e) { histBox.innerHTML = '<div class="nk-hint">' + escapeHtml(e.message) + '</div>'; });
        });

        var contactedBtn = card.querySelector('.nk-contacted-btn');
        if (contactedBtn) {
          var cform = card.querySelector('.nk-contact-form');
          var cresult = cform.querySelector('.nk-contact-result');
          contactedBtn.addEventListener('click', function () { cform.hidden = false; contactedBtn.disabled = true; cresult.focus(); });
          cform.querySelector('.nk-contact-cancel').addEventListener('click', function () { cform.hidden = true; contactedBtn.disabled = false; });
          cform.querySelector('.nk-contact-save').addEventListener('click', function (ev) {
            var text = cresult.value.trim();
            if (text.length < 3) { toast('Contá brevemente cómo fue la comunicación', true); cresult.focus(); return; }
            var b = ev.currentTarget;
            b.disabled = true;
            jsonApi('/inbox/notes/' + id + '/contacted', 'POST', { result: text })
              .then(function (updated) { toast('Contacto confirmado: ya les avisamos'); opts.onChanged(updated, id); })
              .catch(function (e) { b.disabled = false; toast(e.message, true); });
          });
        }

        var gotoBtn = card.querySelector('.nk-goto');
        if (gotoBtn) gotoBtn.addEventListener('click', function () { opts.onGotoMessage(note.source_message_id); });

        var restoreBtn = card.querySelector('.nk-restore');
        if (restoreBtn) restoreBtn.addEventListener('click', function () {
          restoreBtn.disabled = true;
          jsonApi('/inbox/notes/' + id + '/restore', 'POST')
            .then(function (updated) { toast('Nota restaurada'); opts.onChanged(updated, id); })
            .catch(function (e) { restoreBtn.disabled = false; toast(e.message, true); });
        });
        if (note.deleted_at) return;

        card.querySelector('.nk-check').addEventListener('click', function (ev) {
          histBox.hidden = true;
          var btn = ev.currentTarget;
          btn.disabled = true;
          jsonApi('/inbox/notes/' + id + '/done', 'PATCH', { done: !note.done_at })
            .then(function (updated) {
              toast(updated.done_at ? (updated.due_at ? 'Tarea marcada como hecha' : 'Nota marcada como resuelta') : 'Nota reabierta');
              opts.onChanged(updated, id);
            })
            .catch(function (e) { btn.disabled = false; toast(e.message, true); });
        });

        var pinBtn = card.querySelector('.nk-pin');
        if (pinBtn) pinBtn.addEventListener('click', function () {
          pinBtn.disabled = true;
          jsonApi('/inbox/notes/' + id + '/pin', 'PATCH', { pinned: !note.pinned })
            .then(function (updated) {
              toast(updated.pinned ? 'Marcada como importante: la verá todo el equipo al abrir el chat' : 'Quitada de importantes');
              opts.onChanged(updated, id);
            })
            .catch(function (e) { pinBtn.disabled = false; toast(e.message, true); });
        });

        var editBtn = card.querySelector('.nk-edit');
        if (editBtn) editBtn.addEventListener('click', function () {
          editor.innerHTML = editorHtml(note);
          var pickers = bindPickers(editor, opts.tags(), (note.tags || []).map(function (t) { return t.id; }), note.due_at, null, note.due_time);
          var assignee = bindAssignee(editor.querySelector('.nk-assignee-select'), note.assigned_to);
          var ta = editor.querySelector('.nk-edit-text');
          var close = function () { editor.hidden = true; editor.innerHTML = ''; view.hidden = false; card.classList.remove('editing'); };
          var save = function () {
            var text = ta.value.trim();
            if (!text && !note.audio_path) { toast('La nota no puede quedar vacía', true); ta.focus(); return; }
            var saveBtn = editor.querySelector('.nk-edit-save');
            saveBtn.disabled = true;
            jsonApi('/inbox/notes/' + id, 'PUT', { text: text, due_at: pickers.due(), due_time: pickers.time(), tag_ids: pickers.tags(), assigned_to: assignee() })
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
            .then(function () {
              opts.onChanged(null, id);
              toast('Nota enviada a la papelera', false, {
                label: 'Deshacer',
                run: function () {
                  jsonApi('/inbox/notes/' + id + '/restore', 'POST')
                    .then(function (restored) { toast('Nota restaurada'); opts.onChanged(restored, id); })
                    .catch(function (e) { toast(e.message, true); });
                },
              });
            })
            .catch(function (e) { ev.currentTarget.disabled = false; toast(e.message, true); });
        });
      });
    }

    return {
      dueState: dueState,
      dueLabel: dueLabel,
      isPinned: isPinned,
      lineLabel: lineLabel,
      loadAssignees: loadAssignees,
      bindAssignee: bindAssignee,
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

  /* ── Notificaciones (campana de la barra superior) ── */
  function initNotifications() {
    var btn = document.getElementById('notif-btn');
    if (!btn) return;
    var badge = document.getElementById('notif-badge');
    var list = document.getElementById('notif-list');
    var ICONS = {
      note_created: 'ri-sticky-note-line', derived_to_you: 'ri-share-forward-line', derived: 'ri-share-forward-line',
      contacted: 'ri-phone-line', resolved: 'ri-check-double-line',
    };
    function setBadge(n) {
      n = Number(n) || 0;
      badge.hidden = !n;
      badge.textContent = n > 99 ? '99+' : String(n);
      btn.setAttribute('aria-label', n ? 'Notificaciones: ' + n + ' sin leer' : 'Notificaciones');
    }
    window.__setNotifBadge = setBadge;
    function go(item) {
      var done = function () { if (item.link) location.href = item.link; };
      if (item.read_at) { done(); return; }
      jsonApi('/notifications/read', 'POST', { ids: [item.id] }).then(function (r) { setBadge(r.unread); done(); }).catch(done);
    }
    function render(items) {
      if (!items.length) { list.innerHTML = '<div class="notif-empty"><span class="ri-notification-off-line"></span>No tenés notificaciones.</div>'; return; }
      list.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="notif-item' + (it.read_at ? '' : ' unread') + ' k-' + it.kind + '" data-i="' + i + '">' +
          '<span class="notif-ic ' + (ICONS[it.kind] || 'ri-notification-3-line') + '" aria-hidden="true"></span>' +
          '<span class="notif-body"><span class="notif-title">' + escapeHtml(it.title) + '</span>' +
            (it.body ? '<span class="notif-text">' + escapeHtml(it.body) + '</span>' : '') +
            '<span class="notif-time">' + escapeHtml(NoteKit.relTime(it.created_at)) + '</span></span>' +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('.notif-item'), function (el) {
        el.addEventListener('click', function () { go(items[Number(el.getAttribute('data-i'))]); });
      });
    }
    function load() {
      return api('/notifications').then(function (d) { setBadge(d.unread); render(d.items || []); }).catch(function () {});
    }
    btn.parentElement.addEventListener('show.bs.dropdown', load);
    var readAll = document.getElementById('notif-readall');
    if (readAll) readAll.addEventListener('click', function () {
      jsonApi('/notifications/read', 'POST', { all: true }).then(function (r) { setBadge(r.unread); load(); }).catch(function () {});
    });
    var es = liveSource();
    if (es) es.addEventListener('notification', function (e) {
      var d; try { d = JSON.parse(e.data); } catch (_) { return; }
      setBadge(d.unread);
      toast(d.title, false, d.link ? { label: 'Ver', run: function () { go({ id: d.id, link: d.link }); } } : null);
      if (btn.getAttribute('aria-expanded') === 'true') load();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(d.title, { body: d.body || '', tag: 'notif-' + d.id }); } catch (_) {}
      }
    });
  }

  /* ── Recordatorios y resumen del día (en cualquier página del panel) ── */
  function initReminders() {
    var es = liveSource();
    if (!es) return;
    var stack = null;
    function getStack() {
      if (!stack) {
        stack = document.createElement('div');
        stack.className = 'rem-stack';
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
      }
      return stack;
    }
    function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function minutesUntilTomorrow9() {
      var t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
      return Math.round((t - Date.now()) / 60000);
    }

    function showReminder(d) {
      var card = document.createElement('section');
      card.className = 'rem-card';
      card.setAttribute('role', 'alert');
      card.innerHTML =
        '<div class="rem-head"><span class="ri-alarm-line" aria-hidden="true"></span>Recordatorio · ' + escapeHtml(d.dueTime || '') +
          '<button type="button" class="rem-x" aria-label="Cerrar"><span class="ri-close-line"></span></button></div>' +
        '<p class="rem-text">' + escapeHtml(d.text || '') + '</p>' +
        '<div class="rem-contact"><span class="ri-user-3-line" aria-hidden="true"></span>' + escapeHtml(d.contact || '') + '</div>' +
        '<div class="rem-actions">' +
          '<button type="button" class="btn btn-sm btn-primary rem-done"><span class="ri-check-line me-1"></span>Hecho</button>' +
          '<a class="btn btn-sm btn-soft-primary" href="/conversations/' + encodeURIComponent(d.chatId || '') + '">Abrir chat</a>' +
          '<span class="rem-snooze"><span class="nk-hint">Posponer:</span>' +
            '<button type="button" data-min="15">15 min</button><button type="button" data-min="60">1 h</button>' +
            '<button type="button" data-min="tomorrow">Mañana 9:00</button></span>' +
        '</div>' +
        ('Notification' in window && Notification.permission === 'default'
          ? '<button type="button" class="rem-notify">Avisarme también cuando esté en otra pestaña</button>' : '');
      getStack().appendChild(card);
      var close = function () { card.remove(); };
      card.querySelector('.rem-x').addEventListener('click', close);
      card.querySelector('.rem-done').addEventListener('click', function (ev) {
        ev.currentTarget.disabled = true;
        jsonApi('/inbox/notes/' + d.noteId + '/done', 'PATCH', { done: true })
          .then(function () { toast('Tarea marcada como hecha'); close(); })
          .catch(function (e) { toast(e.message, true); });
      });
      Array.prototype.forEach.call(card.querySelectorAll('.rem-snooze button'), function (b) {
        b.addEventListener('click', function () {
          var m = b.getAttribute('data-min');
          var minutes = m === 'tomorrow' ? minutesUntilTomorrow9() : Number(m);
          jsonApi('/inbox/notes/' + d.noteId + '/snooze', 'POST', { minutes: minutes })
            .then(function (n) { toast('Te lo recuerdo ' + (m === 'tomorrow' ? 'mañana a las 9:00' : 'a las ' + n.due_time)); close(); })
            .catch(function (e) { toast(e.message, true); });
        });
      });
      var notify = card.querySelector('.rem-notify');
      if (notify) notify.addEventListener('click', function () {
        Notification.requestPermission().then(function () { notify.remove(); });
      });
      // Si la pestaña no está a la vista, también una notificación del sistema.
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Recordatorio: ' + (d.contact || ''), { body: d.text || '', tag: 'note-' + d.noteId }); } catch (e) {}
      }
    }

    es.addEventListener('reminder', function (e) {
      var d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d && d.noteId) showReminder(d);
    });

    // Resumen del día: una vez por día y navegador.
    var key = 'myday:' + ymd(new Date());
    var seen = false;
    try { seen = !!localStorage.getItem(key); } catch (e) {}
    if (seen) return;
    api('/notes/my-day').then(function (day) {
      if (!day || (!day.today && !day.overdue)) return;
      try { localStorage.setItem(key, '1'); } catch (e) {}
      var parts = [];
      if (day.today) parts.push(day.today + ' para hoy');
      if (day.overdue) parts.push(day.overdue + ' vencida' + (day.overdue > 1 ? 's' : ''));
      var card = document.createElement('section');
      card.className = 'rem-card rem-day';
      card.innerHTML =
        '<div class="rem-head"><span class="ri-sun-line" aria-hidden="true"></span>Tu día: ' + escapeHtml(parts.join(' · ')) +
          '<button type="button" class="rem-x" aria-label="Cerrar"><span class="ri-close-line"></span></button></div>' +
        '<ul class="rem-list">' + (day.items || []).map(function (i) {
          var late = i.due_at < ymd(new Date());
          return '<li class="' + (late ? 'late' : '') + '"><span class="rem-when">' + (late ? 'Vencida' : (i.due_time || 'Hoy')) + '</span>' +
            '<span class="rem-what">' + escapeHtml(i.note_text || 'Nota de voz') + '</span>' +
            '<span class="rem-who">' + escapeHtml(i.contact || '') + '</span></li>';
        }).join('') + '</ul>' +
        '<div class="rem-actions"><a class="btn btn-sm btn-primary" href="/notes#asignadas">Ver mis tareas</a></div>';
      getStack().appendChild(card);
      card.querySelector('.rem-x').addEventListener('click', function () { card.remove(); });
    }).catch(function () {});
  }

  /* ── /notes: gestor de plantillas de tareas ── */
  function initTemplatesManager() {
    var box = document.getElementById('np-templates');
    if (!box) return;
    var list = [];
    var editing = null; // plantilla en edición (o {} si es nueva)

    function load() {
      return api('/notes/templates').then(function (d) { list = d || []; render(); }).catch(function (e) { toast(e.message, true); });
    }

    function stepRow(i) {
      i = i || { text: '', due_days: '', due_time: '', pinned: false };
      return '<div class="tpl-step">' +
        '<input class="form-control form-control-sm tpl-text" maxlength="500" placeholder="Ej.: Pedir comprobante de pago" value="' + escapeHtml(i.text || '') + '" aria-label="Tarea" />' +
        '<label class="tpl-days" title="Días desde que se aplica (vacío = sin fecha)"><span>en</span>' +
          '<input type="number" min="0" max="365" class="form-control form-control-sm tpl-days-input" value="' + (i.due_days === null || i.due_days === undefined ? '' : i.due_days) + '" aria-label="Días" /><span>días</span></label>' +
        '<input type="time" class="form-control form-control-sm tpl-time" value="' + escapeHtml(i.due_time || '') + '" aria-label="Hora del recordatorio" />' +
        '<label class="tpl-pin" title="Importante"><input type="checkbox" class="tpl-pin-input"' + (i.pinned ? ' checked' : '') + ' /><span class="ri-pushpin-2-line"></span></label>' +
        '<button type="button" class="nk-icon tpl-del" title="Quitar paso" aria-label="Quitar paso"><span class="ri-close-line"></span></button>' +
      '</div>';
    }

    function render() {
      if (editing) return renderEditor();
      box.innerHTML =
        (list.length
          ? list.map(function (t) {
              return '<div class="tpl-item" data-id="' + t.id + '">' +
                '<div class="tpl-item-main"><b>' + escapeHtml(t.name) + '</b>' +
                  '<span>' + t.items.length + ' tarea' + (t.items.length > 1 ? 's' : '') + (t.programa ? ' · ' + escapeHtml(t.programa) : '') + '</span></div>' +
                '<button type="button" class="nk-icon tpl-edit" title="Editar plantilla" aria-label="Editar plantilla"><span class="ri-pencil-line"></span></button>' +
              '</div>';
            }).join('')
          : '<p class="nk-hint">Agrupá pasos que se repiten (p. ej. «Inscripción»: comprobante, documentos, cronograma) y crealos en un clic desde el chat.</p>') +
        '<button type="button" class="btn btn-sm btn-soft-primary w-100 tpl-new"><span class="ri-add-line"></span> Nueva plantilla</button>';
      box.querySelector('.tpl-new').addEventListener('click', function () { editing = {}; render(); });
      Array.prototype.forEach.call(box.querySelectorAll('.tpl-edit'), function (b) {
        b.addEventListener('click', function () {
          var id = Number(b.closest('.tpl-item').getAttribute('data-id'));
          editing = list.filter(function (t) { return t.id === id; })[0] || null;
          render();
        });
      });
    }

    function renderEditor() {
      var t = editing;
      box.innerHTML =
        '<div class="nk-field-label">Nombre</div><input class="form-control form-control-sm tpl-name" maxlength="60" placeholder="Ej.: Inscripción" value="' + escapeHtml(t.name || '') + '" />' +
        '<div class="nk-field-label">Programa <span class="nk-field-hint">· opcional, se sugiere primero en esos chats</span></div>' +
        '<input class="form-control form-control-sm tpl-prog" maxlength="120" placeholder="Ej.: Diplomado en Educación Superior" value="' + escapeHtml(t.programa || '') + '" />' +
        '<div class="nk-field-label">Tareas</div><div class="tpl-steps">' + ((t.items && t.items.length ? t.items : [null]).map(stepRow).join('')) + '</div>' +
        '<button type="button" class="btn btn-sm btn-light w-100 tpl-add"><span class="ri-add-line"></span> Agregar tarea</button>' +
        '<div class="tpl-foot">' +
          (t.id ? '<button type="button" class="btn btn-sm btn-soft-danger tpl-remove">Eliminar</button>' : '') +
          '<button type="button" class="btn btn-sm btn-light tpl-cancel">Cancelar</button>' +
          '<button type="button" class="btn btn-sm btn-primary tpl-save"><span class="ri-check-line me-1"></span>Guardar</button>' +
        '</div>';
      var steps = box.querySelector('.tpl-steps');
      var bindDel = function () {
        Array.prototype.forEach.call(steps.querySelectorAll('.tpl-del'), function (b) {
          b.onclick = function () { if (steps.children.length > 1) b.closest('.tpl-step').remove(); };
        });
      };
      bindDel();
      box.querySelector('.tpl-add').addEventListener('click', function () {
        steps.insertAdjacentHTML('beforeend', stepRow());
        bindDel();
        steps.lastElementChild.querySelector('.tpl-text').focus();
      });
      box.querySelector('.tpl-cancel').addEventListener('click', function () { editing = null; render(); });
      var remove = box.querySelector('.tpl-remove');
      if (remove) remove.addEventListener('click', function () {
        if (!confirm('¿Eliminar la plantilla «' + t.name + '»? Las tareas ya creadas no se tocan.')) return;
        api('/notes/templates/' + t.id, { method: 'DELETE' })
          .then(function () { toast('Plantilla eliminada'); editing = null; load(); })
          .catch(function (e) { toast(e.message, true); });
      });
      box.querySelector('.tpl-save').addEventListener('click', function (ev) {
        var items = Array.prototype.map.call(steps.querySelectorAll('.tpl-step'), function (row) {
          var days = row.querySelector('.tpl-days-input').value;
          return {
            text: row.querySelector('.tpl-text').value.trim(),
            due_days: days === '' ? null : Number(days),
            due_time: row.querySelector('.tpl-time').value || null,
            pinned: row.querySelector('.tpl-pin-input').checked,
          };
        });
        var body = { name: box.querySelector('.tpl-name').value.trim(), programa: box.querySelector('.tpl-prog').value.trim(), items: items };
        ev.currentTarget.disabled = true;
        var btn = ev.currentTarget;
        (t.id ? jsonApi('/notes/templates/' + t.id, 'PUT', body) : jsonApi('/notes/templates', 'POST', body))
          .then(function () { toast('Plantilla guardada'); editing = null; load(); })
          .catch(function (e) { btn.disabled = false; toast(e.message, true); });
      });
      box.querySelector('.tpl-name').focus();
    }

    load();
    if (location.hash === '#plantillas') box.closest('.np-side-card').scrollIntoView({ behavior: 'smooth' });
  }

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
        var person = c.person || {};
        var extra = (person.full_name || '') + ' ' + (person.programas || []).join(' ');
        return (name + ' ' + phone + ' ' + last + ' ' + extra).toLowerCase().indexOf(s) !== -1;
      });
    }

    // ── Equipo: compañeros del sistema, siempre visibles ──
    function loadTeam() {
      return api('/inbox/team')
        .then(function (d) { state.team = (d && d.members) || []; renderTabs(); if (state.tab === 'team') renderList(); })
        .catch(function () {});
    }

    // Conversación con un compañero: la de la lista (en vivo) o la que informó el servidor.
    function teamConversation(m) {
      var mine = state.conversations.filter(function (c) { return c.team && c.team.user_id === m.user_id; });
      if (mine.length) {
        return mine.filter(function (c) { return c.session_id === state.selectedSession; })[0] || mine[0];
      }
      return m.conversation || null;
    }

    function openTeamMember(m) {
      var c = teamConversation(m);
      if (c) {
        if (!state.conversations.some(function (x) { return x.session_id === c.session_id && x.chat_id === c.chat_id; })) state.conversations.unshift(c);
        openChat(c.session_id, c.chat_id, true);
        return;
      }
      var own = root.getAttribute('data-session') || state.selectedSession;
      if (!own) { toast('No tenés una línea de WhatsApp para escribirle.', true); return; }
      var chatId = String(m.phone).replace(/\D+/g, '') + '@c.us';
      openChat(own, chatId, true, {
        id: 0, session_id: own, chat_id: chatId, status: 'open', unread_count: 0,
        last_message_text: null, last_message_at: null, last_direction: null, created_at: null,
        contact: { id: null, avatar: false, name: null, phone: String(m.phone), email: null, company: null, avatar_path: null },
        person: { full_name: null, programas: [] }, notes: { open: 0, pinned: 0, overdue: 0 },
        team: { user_id: m.user_id, name: m.name, area: m.area },
      });
    }

    function renderTeamList() {
      var s = state.search.trim().toLowerCase();
      var rows = (state.team || []).filter(function (m) {
        return !s || (m.name + ' ' + m.area + ' ' + m.phone).toLowerCase().indexOf(s) !== -1;
      }).map(function (m) { return { m: m, c: teamConversation(m) }; });
      // Con mensajes sin leer arriba, luego por actividad reciente y después por nombre.
      rows.sort(function (a, b) {
        var ua = a.c ? a.c.unread_count : 0, ub = b.c ? b.c.unread_count : 0;
        if ((ua > 0) !== (ub > 0)) return ub > 0 ? 1 : -1;
        var ta = (a.c && a.c.last_message_at) || '', tb = (b.c && b.c.last_message_at) || '';
        if (ta !== tb) return ta < tb ? 1 : -1;
        return a.m.name.localeCompare(b.m.name, 'es');
      });
      if (!rows.length) {
        els.list.innerHTML = '<div class="cl-empty"><span class="ri-team-line"></span><p>' +
          (s ? 'Sin coincidencias' : 'No hay compañeros con número registrado') + '</p></div>';
        return;
      }
      rows.forEach(function (r) {
        var m = r.m, c = r.c;
        var el = document.createElement('div');
        var active = c && c.session_id === state.selectedSession && c.chat_id === state.selectedChat;
        el.className = 'convo team-row' + (active ? ' active' : '') + (c && c.unread_count > 0 ? ' unread' : '');
        el.innerHTML =
          avatarHtml(m.name, 'avatar-sm', c ? convoPhoto(c) : null) +
          '<div class="convo-body">' +
            '<div class="convo-team"><span class="ri-team-line" aria-hidden="true"></span>' + escapeHtml(m.area) + '</div>' +
            '<div class="convo-top"><span class="convo-name">' + escapeHtml(m.name) + '</span>' +
              (c && c.last_message_at ? '<span class="convo-time">' + timeAgo(c.last_message_at) + '</span>' : '') + '</div>' +
            '<div class="convo-number"><span class="ri-whatsapp-line" aria-hidden="true"></span>' + escapeHtml(fmtPhone(m.phone)) +
              (m.line_ready ? ' <span class="team-online" title="Su línea está conectada"></span>' : '') + '</div>' +
            '<div class="convo-last">' + (c ? escapeHtml(c.last_message_text || '—') : '<span class="team-start">Iniciar conversación</span>') + '</div>' +
          '</div>' +
          (c && c.unread_count > 0 ? '<span class="unread-pill">' + c.unread_count + '</span>' : '');
        el.addEventListener('click', function () { openTeamMember(m); });
        els.list.appendChild(el);
      });
    }

    // Compañero del sistema: área bajo la que trabaja (en lista, cabecera y ficha).
    function teamLine(c) {
      if (!c.team) return '';
      return '<div class="convo-team" title="Usuario del sistema"><span class="ri-team-line" aria-hidden="true"></span>' + escapeHtml(c.team.area) + '</div>';
    }

    function renderTabs() {
      if (!els.tabs) return;
      var teamBtn = els.tabs.querySelector('[data-tab="team"]');
      if (teamBtn) {
        teamBtn.classList.toggle('active', state.tab === 'team');
        var tb = teamBtn.querySelector('[data-count="team"]');
        if (tb) tb.textContent = (state.team || []).length;
        teamBtn.classList.toggle('has-unread', state.conversations.some(function (c) { return c.team && c.unread_count > 0; }));
      }
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
      if (state.tab === 'team') { els.list.innerHTML = ''; renderTeamList(); return; }
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
      if (c.team && c.team.name) return c.team.name;
      if (c.person && c.person.full_name) return c.person.full_name;
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
        avatarHtml(name, 'avatar-sm', convoPhoto(c), isGroup ? 'is-group' : '') +
        '<div class="convo-body">' +
          teamLine(c) +
          programaLine(c) +
          '<div class="convo-top"><span class="convo-name">' + nameHtml + '</span>' +
            '<span class="convo-time">' + timeAgo(c.last_message_at) + '</span></div>' +
          (!isGroup && phone ? '<div class="convo-number"><span class="ri-whatsapp-line" aria-hidden="true"></span>' + escapeHtml(fmtPhone(phone)) + '</div>' : '') +
          '<div class="convo-last">' + escapeHtml(c.last_message_text || '—') + '</div>' +
        '</div>' +
        convoNotesHtml(c) +
        (c.unread_count > 0 ? '<span class="unread-pill">' + c.unread_count + '</span>' : '') +
        (phone ? '<span class="convo-phone-mini" title="' + escapeHtml(phone) + '"></span>' : '');
      el.addEventListener('click', function () { openChat(c.session_id, c.chat_id, true); });
      return el;
    }

    // Indicador de notas pendientes de la persona (de cualquier línea).
    function convoNotesHtml(c) {
      var n = c.notes || {};
      if (!n.open) return '';
      var tone = n.overdue ? 'danger' : n.pinned ? 'pin' : 'info';
      var icon = n.pinned ? 'ri-pushpin-2-fill' : n.overdue ? 'ri-alarm-warning-line' : 'ri-sticky-note-line';
      var parts = [n.open + ' pendiente' + (n.open > 1 ? 's' : '')];
      if (n.pinned) parts.push(n.pinned + ' importante' + (n.pinned > 1 ? 's' : ''));
      if (n.overdue) parts.push(n.overdue + ' vencida' + (n.overdue > 1 ? 's' : ''));
      return '<span class="convo-notes ' + tone + '" title="Notas: ' + parts.join(' · ') + '">' +
        '<span class="' + icon + '" aria-hidden="true"></span>' + n.open + '</span>';
    }

    // Número legible: +591 7XXX XXXX (o los dígitos tal cual si no es boliviano).
    function fmtPhone(phone) {
      var d = String(phone || '').replace(/\D+/g, '');
      if (/^591\d{8}$/.test(d)) return '+591 ' + d.slice(3, 7) + ' ' + d.slice(7);
      return d ? '+' + d : '';
    }

    // Programa(s) de la persona según cronogramas: el más reciente y cuántos más.
    function programaLine(c) {
      var progs = (c.person && c.person.programas) || [];
      if (!progs.length) return '';
      return '<div class="convo-prog" title="' + escapeHtml(progs.join(' · ')) + '"><span class="ri-graduation-cap-line" aria-hidden="true"></span>' +
        escapeHtml(progs[0]) + (progs.length > 1 ? ' <b>+' + (progs.length - 1) + '</b>' : '') + '</div>';
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
      // Desde «Equipo» se queda en esa pestaña para seguir eligiendo compañeros.
      state.tab = /@g\.us$/.test(chatId) ? 'group' : (state.tab === 'team' ? 'team' : 'individual');
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
      state.person = null;
      state.chatToken++;
      root.classList.remove('list-hidden');
      renderTabs();
      renderList();
      renderPane();
      fetchMessages(true);
      loadNotes();
      loadTags();
      loadPerson();
      var opened = selectedConversation();
      if (opened && !(opened.contact && opened.contact.avatar)) {
        jsonApi('/inbox/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(chatId) + '/avatar', 'POST').catch(function () {});
      }
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
      sessionId: function () { return state.selectedSession; },
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
      onNote: function (msg) { noteFromMessage(msg); },
    };

    // Abre el compositor de notas con el mensaje citado y enlazado.
    function noteFromMessage(msg) {
      var body = msg.content_type === 'text' ? msg.body : (msg.transcription || msg.body || '');
      var who = msg.direction === 'in' ? 'El contacto escribió' : 'Le respondimos';
      var when = fmtDateTime(msg.occurred_at);
      var quote = body ? who + (when ? ' (' + when + ')' : '') + ': «' + String(body).trim() + '»\n' : '';
      var d = state.noteDraft;
      d.open = true;
      d.text = quote + (d.text && d.text.indexOf(quote) === -1 ? d.text : '');
      d.sourceMessageId = msg.id;
      d.sourceLabel = (msg.direction === 'in' ? 'Mensaje del contacto' : 'Mensaje enviado') + (when ? ' · ' + when : '');
      root.classList.remove('contact-hidden');
      renderNoteComposer();
      var sec = els.contact.querySelector('.nk-section');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var ta = els.contact.querySelector('#nk-composer textarea');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }

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
      els.pane.innerHTML = chatHeaderHtml(c) + '<div id="chat-notes-banner"></div><div class="chat-body"></div>' + composerHtml(c);
      els.contact.classList.remove('d-none');
      root.classList.remove('contact-hidden');
      bindPane(c);
      renderNotesBanner();
      // La ficha se redibuja entera: si no, conservaba la cabecera del chat anterior.
      renderContact();
      var body = els.pane.querySelector('.chat-body');
      body.innerHTML = '<div class="text-muted text-center p-3">Cargando mensajes…</div>';
    }

    function chatHeaderHtml(c) {
      var name = convoName(c);
      var isGroup = /@g\.us$/.test(c.chat_id);
      var phone = (c.contact && c.contact.phone) ? c.contact.phone : '';
      return '<div class="chat-header">' +
        '<button type="button" class="btn btn-icon btn-soft-secondary" id="toggle-list" title="Conversaciones"><span class="ri-menu-line"></span></button>' +
        avatarHtml(name, 'avatar-sm', convoPhoto(c)) +
        '<div class="chat-id">' +
          (c.team ? '<div class="chat-progs"><span class="chat-team" title="Usuario del sistema"><span class="ri-team-line" aria-hidden="true"></span> ' + escapeHtml(c.team.area) + '</span></div>' : '') +
          ((c.person && c.person.programas || []).length
            ? '<div class="chat-progs">' + c.person.programas.map(function (p) { return '<span class="chat-programa" title="Programa según cronogramas">' + escapeHtml(p) + '</span>'; }).join('') + '</div>'
            : '') +
          '<div class="name">' + (isGroup ? '<span class="ri-group-line group-ico" title="Grupo"></span>' : '') + escapeHtml(name) + '</div>' +
          '<div class="sub"><span class="font-monospace">' + escapeHtml(isGroup ? phone : fmtPhone(phone)) + '</span>' +
            (c.person && c.person.full_name && c.contact && c.contact.name && c.contact.name !== c.person.full_name
              ? '<span class="chat-waname" title="Nombre en WhatsApp"> · ' + escapeHtml(c.contact.name) + '</span>' : '') +
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
        .then(function (notes) { if (token !== state.chatToken) return; state.notes = notes || []; refreshNotesSection(); syncNoteCounts(); })
        .catch(function () { if (token !== state.chatToken) return; state.notes = []; refreshNotesSection(); });
    }

    // Mantiene al día el indicador de la lista sin esperar a recargarla.
    function syncNoteCounts() {
      var c = selectedConversation();
      if (!c) return;
      var open = state.notes.filter(function (n) { return !n.done_at; });
      c.notes = {
        open: open.length,
        pinned: open.filter(function (n) { return n.pinned; }).length,
        overdue: open.filter(function (n) { return NoteKit.dueState(n) === 'overdue'; }).length,
      };
      renderList();
    }

    // Aviso fijado arriba del chat: lo importante y lo vencido, para que nadie
    // responda sin verlo (esté atendiendo desde la línea que sea).
    function renderNotesBanner() {
      var box = els.pane.querySelector('#chat-notes-banner');
      if (!box) return;
      var open = (state.notes || []).filter(function (n) { return !n.done_at; });
      var pinned = open.filter(function (n) { return n.pinned; });
      var overdue = open.filter(function (n) { return NoteKit.dueState(n) === 'overdue'; });
      var today = open.filter(function (n) { return NoteKit.dueState(n) === 'today'; });
      var lead = pinned[0] || overdue[0] || today[0];
      if (!lead) { box.innerHTML = ''; return; }
      var tone = pinned.length ? 'pin' : overdue.length ? 'danger' : 'warn';
      var icon = pinned.length ? 'ri-pushpin-2-fill' : overdue.length ? 'ri-alarm-warning-line' : 'ri-calendar-todo-line';
      var label = pinned.length ? 'Importante' : overdue.length ? 'Tarea vencida' : 'Tarea para hoy';
      var text = lead.note_text || 'Nota de voz';
      if (text.length > 160) text = text.slice(0, 157) + '…';
      var extra = [];
      if (pinned.length > 1) extra.push((pinned.length - 1) + ' importante' + (pinned.length > 2 ? 's' : '') + ' más');
      if (pinned.length && overdue.length) extra.push(overdue.length + ' vencida' + (overdue.length > 1 ? 's' : ''));
      if ((pinned.length || overdue.length) && today.length) extra.push(today.length + ' para hoy');
      if (!pinned.length && overdue.length > 1) extra.push((overdue.length - 1) + ' vencida' + (overdue.length > 2 ? 's' : '') + ' más');
      box.innerHTML = '<div class="chat-notes-banner ' + tone + '" role="note">' +
        '<span class="cnb-ic ' + icon + '" aria-hidden="true"></span>' +
        '<div class="cnb-body"><b>' + label + ':</b> ' + escapeHtml(text) +
          (extra.length ? '<span class="cnb-more">' + escapeHtml(extra.join(' · ')) + '</span>' : '') +
          '<span class="cnb-by">' + escapeHtml(lead.author_name || 'Equipo') + ' · ' + escapeHtml(NoteKit.relTime(lead.created_at)) + '</span>' +
        '</div>' +
        '<button type="button" class="cnb-open">Ver notas</button>' +
      '</div>';
      box.querySelector('.cnb-open').addEventListener('click', function () {
        root.classList.remove('contact-hidden');
        var sec = els.contact.querySelector('.nk-section');
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Solo la lista si la ficha ya está dibujada; si no, la ficha completa (primer render).
    function refreshNotesSection() {
      if (els.contact.querySelector('#nk-list')) renderNotesList();
      else renderContact();
      renderNotesBanner();
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

    function emptyNoteDraft() {
      return { open: false, text: '', tags: [], due: '', time: '', pinned: false, assignedTo: null, sourceMessageId: null, sourceLabel: '' };
    }

    function notesSectionHtml() {
      return '<div class="panel-section nk-section">' +
        '<div class="nk-section-head">' +
          '<h6><span class="ri-sticky-note-line"></span> Notas y tareas</h6>' +
          '<span class="nk-counts" id="nk-counts"></span>' +
        '</div>' +
        '<p class="nk-intro"><span class="ri-team-line" aria-hidden="true"></span>' +
          'Acuerdos, datos y pendientes de esta persona. Los ve todo el equipo, escriba al número del sistema que escriba. No se envían al contacto.</p>' +
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
        box.innerHTML = '<div class="nk-composer-row">' +
          '<button type="button" class="nk-composer-collapsed">' +
            '<span class="ri-add-line" aria-hidden="true"></span> Registrar una nota o tarea</button>' +
          '<button type="button" class="nk-template-btn" title="Crear varias tareas desde una plantilla" aria-expanded="false">' +
            '<span class="ri-file-list-3-line" aria-hidden="true"></span><span class="visually-hidden">Usar plantilla</span></button>' +
        '</div><div class="nk-template-pick" hidden></div>';
        box.querySelector('.nk-template-btn').addEventListener('click', function (ev) { toggleTemplatePicker(box, ev.currentTarget); });
        box.querySelector('.nk-composer-collapsed').addEventListener('click', function () {
          d.open = true;
          renderNoteComposer();
          var t = box.querySelector('textarea');
          if (t) t.focus();
        });
        return;
      }
      box.innerHTML = '<form class="nk-composer" novalidate>' +
        (d.sourceMessageId
          ? '<div class="nk-source"><span class="ri-chat-quote-line" aria-hidden="true"></span>' +
              '<span>Enlazada a: ' + escapeHtml(d.sourceLabel || 'un mensaje del chat') + '</span>' +
              '<button type="button" class="nk-source-x" title="Quitar el enlace al mensaje" aria-label="Quitar el enlace al mensaje"><span class="ri-close-line"></span></button></div>'
          : '') +
        '<textarea class="form-control nk-textarea" rows="3" maxlength="4000" aria-label="Texto de la nota"' +
          ' placeholder="Ej.: Pagó la 1.ª cuota por transferencia; falta el comprobante. Enviarle el cronograma del diplomado."></textarea>' +
        '<label class="nk-pin-toggle' + (d.pinned ? ' on' : '') + '">' +
          '<input type="checkbox" class="nk-pin-input"' + (d.pinned ? ' checked' : '') + ' />' +
          '<span class="nk-pin-switch" aria-hidden="true"></span>' +
          '<span class="nk-pin-text"><b><span class="ri-pushpin-2-line" aria-hidden="true"></span> Importante</b>' +
            '<small>Se muestra fijada arriba del chat para quien atienda a esta persona.</small></span>' +
        '</label>' +
        '<div class="nk-field-label">¿Es una tarea? Fecha de seguimiento</div><div class="nk-due-wrap"></div>' +
        '<div class="nk-field-label">Derivar a <span class="nk-field-hint">· otra persona o área; le llega una notificación con el detalle</span></div>' +
        '<select class="form-select form-select-sm nk-assignee-select" aria-label="Responsable de la tarea"></select>' +
        '<div class="nk-field-label">Etiquetas</div><div class="nk-tag-picker"></div>' +
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
      var assignee = NoteKit.bindAssignee(form.querySelector('.nk-assignee-select'), d.assignedTo, function (v) { d.assignedTo = v; });
      var sourceX = form.querySelector('.nk-source-x');
      if (sourceX) sourceX.addEventListener('click', function () { d.sourceMessageId = null; d.sourceLabel = ''; renderNoteComposer(); });
      var pinInput = form.querySelector('.nk-pin-input');
      pinInput.addEventListener('change', function () {
        d.pinned = pinInput.checked;
        pinInput.closest('.nk-pin-toggle').classList.toggle('on', d.pinned);
      });
      var pickers = NoteKit.bindPickers(form, state.tags, d.tags, d.due, function () {
        d.tags = pickers.tags();
        d.due = pickers.due() || '';
        d.time = pickers.time() || '';
      }, d.time);
      NoteKit.autosize(ta);

      var notesUrl = '/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/notes';
      var token = state.chatToken;
      var done = function () {
        if (token !== state.chatToken) return;
        state.noteDraft = emptyNoteDraft();
        renderNoteComposer();
        loadNotes();
        toast('Nota registrada. Ya la ve todo el equipo.');
      };
      var submit = function () {
        var text = ta.value.trim();
        if (!text) { toast('Escribí la nota (o grabá un audio)', true); ta.focus(); return; }
        var btn = form.querySelector('.nk-save');
        btn.disabled = true;
        jsonApi(notesUrl, 'POST', {
          text: text, due_at: pickers.due(), due_time: pickers.time(), tag_ids: pickers.tags(), pinned: d.pinned,
          assigned_to: assignee(), source_message_id: d.sourceMessageId,
        })
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
        if (pickers.time()) fd.append('due_time', pickers.time());
        fd.append('tag_ids', JSON.stringify(pickers.tags()));
        if (d.pinned) fd.append('pinned', '1');
        if (assignee()) fd.append('assigned_to', String(assignee()));
        if (d.sourceMessageId) fd.append('source_message_id', String(d.sourceMessageId));
        fetch(notesUrl, { method: 'POST', body: fd, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('No se pudo guardar la nota de voz'); done(); })
          .catch(function (e) { toast(e.message, true); });
      }));
    }

    // Plantillas de tareas: se eligen, se revisan los pasos y se crean de una vez.
    var templatesCache = null;
    function loadTemplates(force) {
      if (!templatesCache || force) templatesCache = api('/notes/templates').catch(function () { templatesCache = null; return []; });
      return templatesCache;
    }

    function toggleTemplatePicker(box, btn) {
      var pick = box.querySelector('.nk-template-pick');
      if (!pick.hidden) { pick.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
      pick.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      pick.innerHTML = '<div class="nk-hint">Cargando plantillas…</div>';
      loadTemplates(true).then(function (list) {
        list = list || [];
        if (!list.length) {
          pick.innerHTML = '<div class="nk-hint">Todavía no hay plantillas. Crealas en <a href="/notes#plantillas">Notas y tareas</a>.</div>';
          return;
        }
        var programa = (state.person && state.person.programa) || '';
        var norm = function (s) { return String(s || '').toLowerCase(); };
        list = list.slice().sort(function (a, b) {
          var am = programa && norm(a.programa) === norm(programa) ? 0 : 1;
          var bm = programa && norm(b.programa) === norm(programa) ? 0 : 1;
          return am - bm || a.name.localeCompare(b.name);
        });
        pick.innerHTML =
          '<label class="nk-field-label" for="nk-tpl-select">Plantilla</label>' +
          '<select id="nk-tpl-select" class="form-select form-select-sm">' + list.map(function (t) {
            var match = programa && norm(t.programa) === norm(programa);
            return '<option value="' + t.id + '">' + escapeHtml(t.name) + (match ? ' · sugerida para ' + escapeHtml(t.programa) : '') + '</option>';
          }).join('') + '</select>' +
          '<ol class="nk-tpl-steps"></ol>' +
          '<div class="nk-field-label">Responsable</div><select class="form-select form-select-sm nk-assignee-select" aria-label="Responsable de las tareas"></select>' +
          '<div class="nk-composer-foot">' +
            '<button type="button" class="btn btn-sm btn-light nk-tpl-cancel">Cancelar</button>' +
            '<button type="button" class="btn btn-sm btn-primary nk-tpl-apply"></button>' +
          '</div>';
        var select = pick.querySelector('#nk-tpl-select');
        var steps = pick.querySelector('.nk-tpl-steps');
        var apply = pick.querySelector('.nk-tpl-apply');
        var assignee = NoteKit.bindAssignee(pick.querySelector('.nk-assignee-select'), null);
        var current = function () { return list.filter(function (t) { return String(t.id) === select.value; })[0]; };
        var when = function (i) {
          if (i.due_days === null || i.due_days === undefined) return 'sin fecha';
          var label = i.due_days === 0 ? 'hoy' : i.due_days === 1 ? 'mañana' : 'en ' + i.due_days + ' días';
          return label + (i.due_time ? ' a las ' + i.due_time : '');
        };
        var renderSteps = function () {
          var t = current();
          steps.innerHTML = t.items.map(function (i) {
            return '<li>' + (i.pinned ? '<span class="ri-pushpin-2-fill nk-tpl-pin" title="Importante"></span>' : '') +
              escapeHtml(i.text) + ' <span class="nk-tpl-when">' + escapeHtml(when(i)) + '</span></li>';
          }).join('');
          apply.innerHTML = '<span class="ri-check-double-line me-1"></span>Crear ' + t.items.length + ' tarea' + (t.items.length > 1 ? 's' : '');
        };
        select.addEventListener('change', renderSteps);
        renderSteps();
        pick.querySelector('.nk-tpl-cancel').addEventListener('click', function () { pick.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
        var token = state.chatToken;
        apply.addEventListener('click', function () {
          apply.disabled = true;
          jsonApi('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/notes/template', 'POST',
            { template_id: Number(select.value), assigned_to: assignee() })
            .then(function (r) {
              if (token !== state.chatToken) return;
              pick.hidden = true;
              btn.setAttribute('aria-expanded', 'false');
              toast(r.created + ' tarea' + (r.created > 1 ? 's' : '') + ' creada' + (r.created > 1 ? 's' : '') + ' desde «' + current().name + '»');
              loadNotes();
            })
            .catch(function (e) { apply.disabled = false; toast(e.message, true); });
        });
      });
    }

    // ── La persona en otras líneas (ficha única) ──
    function loadPerson() {
      if (!state.selectedChat || state.tab === 'group') return;
      var token = state.chatToken;
      api('/inbox/' + encodeURIComponent(state.selectedSession) + '/' + encodeURIComponent(state.selectedChat) + '/person')
        .then(function (p) { if (token !== state.chatToken) return; state.person = p; renderPerson(); })
        .catch(function () { if (token !== state.chatToken) return; state.person = null; });
    }

    function renderPerson() {
      var p = state.person;
      var fillBox = els.contact.querySelector('#person-fill');
      var linesBox = els.contact.querySelector('#person-lines');
      if (!p || !fillBox || !linesBox) return;
      var f = p.fill || {};
      var fillRow = function (label, item) {
        return item ? '<div class="pf-row"><span class="pf-label">' + label + '</span><span class="pf-value">' + escapeHtml(item.value) +
          '</span><span class="pf-src" title="Dato registrado en otra línea">según ' + escapeHtml(item.line) + '</span></div>' : '';
      };
      // Si la cabecera de la ficha ya muestra los programas, no se repiten aquí.
      var conv = selectedConversation();
      var inHead = !!(conv && conv.person && conv.person.programas && conv.person.programas.length);
      var progs = inHead ? [] : (p.programas && p.programas.length ? p.programas : (p.programa ? [p.programa] : []));
      var programa = progs.length
        ? '<div class="pf-row pf-progs"><span class="pf-label">' + (progs.length > 1 ? 'Programas' : 'Programa') + '</span><span class="pf-value">' +
            progs.map(function (x) { return '<span class="pf-prog">' + escapeHtml(x) + '</span>'; }).join('') + '</span></div>'
        : inHead ? '' : fillRow('Programa', f.programa);
      fillBox.innerHTML = fillRow('Nombre', f.name) + fillRow('Email', f.email) + fillRow('Empresa', f.company) + programa;
      var lines = p.lines || [];
      if (!lines.length) { linesBox.innerHTML = ''; linesBox.hidden = true; return; }
      linesBox.hidden = false;
      linesBox.innerHTML = '<h6><span class="ri-links-line" aria-hidden="true"></span> También escribió a</h6>' +
        lines.map(function (l) {
          var line = l.session_name || 'Otra línea';
          var phone = l.session_phone ? '+' + String(l.session_phone).replace(/^\+/, '') : '';
          var waiting = l.last_direction === 'in' && l.status !== 'closed';
          var activity = l.last_message_at
            ? (l.last_direction === 'in' ? 'Escribió ' : 'Le respondieron ') + timeAgo(l.last_message_at)
            : 'Sin mensajes todavía';
          return '<div class="pl-row' + (waiting ? ' waiting' : '') + '">' +
            '<span class="pl-ic ri-whatsapp-line" aria-hidden="true"></span>' +
            '<div class="pl-body"><div class="pl-line">' + escapeHtml(line) + (phone ? ' <span class="pl-phone">' + escapeHtml(phone) + '</span>' : '') + '</div>' +
              '<div class="pl-meta">' + escapeHtml(activity) + (l.programa ? ' · ' + escapeHtml(l.programa) : '') + '</div></div>' +
            (waiting ? '<span class="pl-badge" title="El último mensaje es del contacto">Sin responder</span>' : '') +
          '</div>';
        }).join('') +
        '<p class="nk-hint pl-hint">Las notas y tareas de esas líneas se ven abajo, en «Notas y tareas».</p>';
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
      var others = notes.filter(function (n) { return n.session_id && n.session_id !== state.selectedSession; }).length;
      var counts = els.contact.querySelector('#nk-counts');
      if (counts) {
        counts.innerHTML =
          (overdue ? '<span class="nk-count danger">' + overdue + ' vencida' + (overdue > 1 ? 's' : '') + '</span>' : '') +
          (today ? '<span class="nk-count warn">' + today + ' hoy</span>' : '') +
          (open.length ? '<span class="nk-count" title="Pendientes">' + open.length + ' pend.</span>' : '');
      }
      if (!notes.length) {
        list.innerHTML = '<div class="nk-empty"><span class="ri-sticky-note-add-line" aria-hidden="true"></span>' +
          '<p>Todavía no hay notas sobre esta persona.</p>' +
          '<small>Registrá lo que no hay que olvidar: así cualquier compañero puede continuar la atención.</small></div>';
        return;
      }
      var card = function (n) { return NoteKit.cardHtml(n, { currentSession: state.selectedSession, onGotoMessage: true }); };
      var pinnedOpen = open.filter(function (n) { return n.pinned; });
      var restOpen = open.filter(function (n) { return !n.pinned; });
      var groupTitle = function (label, count) { return '<div class="nk-group-title">' + label + ' <span>' + count + '</span></div>'; };
      list.innerHTML =
        (others ? '<div class="nk-shared-hint"><span class="ri-links-line" aria-hidden="true"></span>' +
          others + ' nota' + (others > 1 ? 's' : '') + ' registrada' + (others > 1 ? 's' : '') + ' desde otra línea del sistema.</div>' : '') +
        (pinnedOpen.length ? groupTitle('Importantes', pinnedOpen.length) + pinnedOpen.map(card).join('') : '') +
        (restOpen.length ? (pinnedOpen.length ? groupTitle('Pendientes', restOpen.length) : '') + restOpen.map(card).join('') : '') +
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
        onGotoMessage: function (id) { goToMessage(id); },
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
        '<div class="contact-head">' + avatarHtml(name, 'avatar-xl', convoPhoto(c)) +
          ((c.person && c.person.programas || []).length
            ? '<div class="contact-progs">' + c.person.programas.map(function (p) { return '<span class="pf-prog">' + escapeHtml(p) + '</span>'; }).join('') + '</div>'
            : '') +
          nameBlockHtml(c) +
          (!c.team && c.person && c.person.full_name && ct.name && ct.name !== c.person.full_name ? '<div class="contact-waname">WhatsApp: ' + escapeHtml(ct.name) + '</div>' : '') +
          '<div class="contact-phone">' + escapeHtml(fmtPhone(ct.phone) || '') + '</div>' +
          (ct.email ? '<div class="contact-email">' + escapeHtml(ct.email) + '</div>' : '') +
        '</div>' +
        '<div class="person-fill" id="person-fill"></div>' +
        membersHtml +
        '<div class="panel-section person-lines" id="person-lines" hidden></div>' +
        notesSectionHtml() +
        '<div class="panel-section contact-meta"><h6>Conversación</h6><dl>' +
          '<dt>Inicio</dt><dd>' + (c.created_at ? new Date(c.created_at).toLocaleDateString() : '—') + '</dd>' +
          '<dt>Último mensaje</dt><dd>' + timeAgo(c.last_message_at) + '</dd>' +
        '</dl></div>';

      bindNameEditor(c);

      // Notas internas: compositor (con borrador) y lista.
      renderNoteComposer();
      renderNotesList();
      renderPerson();

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

    // Nombre de la persona en la ficha. Si cronogramas no mandó datos, se puede
    // registrar a mano; queda por número y lo ven todas las líneas.
    function nameBlockHtml(c) {
      var ct = c.contact || {};
      var p = c.person || {};
      var isGroup = /@g\.us$/.test(c.chat_id);
      var shown = p.full_name || ct.name || '';
      if (isGroup) return '<div class="contact-name">' + escapeHtml(shown || 'Sin nombre') + '</div>';
      // Compañero del sistema: nombre y área vienen de su usuario (no se editan aquí).
      if (c.team) {
        return '<div class="contact-team"><span class="ri-team-line" aria-hidden="true"></span> Usuario del sistema · ' + escapeHtml(c.team.area) + '</div>' +
          '<div class="contact-name">' + escapeHtml(c.team.name) + '</div>' +
          (ct.name && ct.name !== c.team.name ? '<div class="contact-waname">WhatsApp: ' + escapeHtml(ct.name) + '</div>' : '');
      }
      var src = p.name_source === 'manual'
        ? '<div class="contact-namesrc">Registrado' + (p.name_by ? ' por ' + escapeHtml(p.name_by) : '') + ' en el panel</div>'
        : '';
      if (!p.full_name) {
        return '<div class="contact-name">' + escapeHtml(shown || 'Sin nombre') + '</div>' +
          '<button type="button" class="btn btn-sm btn-soft-primary contact-name-add" data-name-edit>' +
            '<span class="ri-user-add-line" aria-hidden="true"></span> Registrar nombre</button>' +
          '<div class="contact-name-form" hidden></div>';
      }
      return '<div class="contact-name">' + escapeHtml(shown) +
          ' <button type="button" class="contact-name-edit" data-name-edit title="Editar nombre" aria-label="Editar nombre">' +
          '<span class="ri-pencil-line" aria-hidden="true"></span></button></div>' + src +
        '<div class="contact-name-form" hidden></div>';
    }

    function bindNameEditor(c) {
      var trigger = els.contact.querySelector('[data-name-edit]');
      var form = els.contact.querySelector('.contact-name-form');
      if (!trigger || !form) return;
      var sessionId = c.session_id, chatId = c.chat_id;
      trigger.addEventListener('click', function () {
        var current = (c.person && c.person.full_name) || '';
        form.innerHTML =
          '<input type="text" class="form-control form-control-sm" maxlength="120" placeholder="Apellidos, Nombres" />' +
          '<div class="contact-name-actions">' +
            '<button type="button" class="btn btn-sm btn-primary" data-save>Guardar</button>' +
            '<button type="button" class="btn btn-sm btn-light" data-cancel>Cancelar</button>' +
            (current ? '<button type="button" class="btn btn-sm btn-link text-danger" data-clear title="Quitar el nombre registrado">Quitar</button>' : '') +
          '</div>' +
          '<small class="text-muted">Lo verán todos los que atiendan este número, desde cualquier línea.</small>';
        form.hidden = false;
        trigger.hidden = true;
        var input = form.querySelector('input');
        input.value = current;
        input.focus();
        input.select();
        var close = function () { form.hidden = true; form.innerHTML = ''; trigger.hidden = false; };
        var save = function (value) {
          var btns = form.querySelectorAll('button');
          Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
          jsonApi('/inbox/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(chatId) + '/name', 'PUT', { name: value })
            .then(function (d) {
              var person = (d && d.person) || { full_name: null, programas: [] };
              // Misma persona en otras líneas de la lista: se actualiza ya.
              var key = String(chatId).replace(/@.*$/, '').replace(/\D+/g, '').slice(-8);
              state.conversations.forEach(function (x) {
                if (x.session_id === sessionId && x.chat_id === chatId) x.person = person;
                else if (key && !/@g\.us$/.test(x.chat_id) && String(x.chat_id).replace(/@.*$/, '').replace(/\D+/g, '').slice(-8) === key) x.person = person;
              });
              toast(value ? 'Nombre registrado' : 'Nombre quitado');
              var opened = selectedConversation();
              var headName = els.pane.querySelector('.chat-header .chat-id .name');
              if (opened && headName && opened.session_id === sessionId && opened.chat_id === chatId) headName.textContent = convoName(opened);
              renderList();
              renderContact();
              loadPerson();
            })
            .catch(function (err) {
              Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
              toast((err && err.message) || 'No se pudo guardar el nombre.', true);
            });
        };
        form.querySelector('[data-save]').addEventListener('click', function () {
          var v = input.value.trim();
          if (!v) { input.focus(); return; }
          save(v);
        });
        form.querySelector('[data-cancel]').addEventListener('click', close);
        var clr = form.querySelector('[data-clear]');
        if (clr) clr.addEventListener('click', function () { save(''); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); form.querySelector('[data-save]').click(); }
          if (e.key === 'Escape') close();
        });
      });
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
          if (t && t !== state.tab) { state.tab = t; renderTabs(); renderList(); if (t === 'team') loadTeam(); }
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
    // «Te asignaron una tarea»: solo al responsable y si no se la asignó él mismo.
    function notifyAssignment(d) {
      if (!d || d.action !== 'assigned' || !d.assignedTo) return;
      NoteKit.loadAssignees().then(function (a) {
        if (!a.me || d.assignedTo !== a.me || d.actorId === a.me) return;
        toast('Te asignaron una tarea nueva', false, { label: 'Ver', run: function () { location.href = '/notes#asignadas'; } });
      });
    }

    function initLive() {
      var es = liveSource();
      if (es) {
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
        // Notas de la persona cambiadas por otro compañero (en cualquier línea).
        var noteTimer = null;
        es.addEventListener('note', function (e) {
          var d; try { d = JSON.parse(e.data); } catch (_) { return; }
          var chats = (d && d.chats) || [];
          var open = chats.some(function (c) { return c.sessionId === state.selectedSession && c.chatId === state.selectedChat; });
          clearTimeout(noteTimer);
          noteTimer = setTimeout(function () {
            if (open) loadNotes();
            loadConversations();
          }, 300);
          notifyAssignment(d);
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
    loadTeam();
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

    // Chat de un enlace (p. ej. desde Notas y tareas): primero en la lista
    // cargada (tolerando otro formato del número); si no, se busca en todas las
    // conversaciones del usuario; si tampoco existe, se abre uno nuevo en su
    // línea para escribirle.
    var initialChat = root.getAttribute('data-active');
    if (initialChat) {
      loadConversations().then(function () {
        var found = findConversation(initialChat);
        if (found) { openChat(found.session_id, found.chat_id, false); return; }
        return api('/inbox/find?chat=' + encodeURIComponent(initialChat)).then(function (d) {
          var c = d && d.conversation;
          if (c) {
            if (!state.conversations.some(function (x) { return x.session_id === c.session_id && x.chat_id === c.chat_id; })) state.conversations.unshift(c);
            openChat(c.session_id, c.chat_id, false);
            return;
          }
          var digits = String(initialChat).replace(/@.*$/, '').replace(/\D+/g, '');
          var own = root.getAttribute('data-session') || state.selectedSession;
          if (digits && own && !/@g\.us$/.test(initialChat)) {
            openChat(own, digits + '@c.us', false, {
              id: 0, session_id: own, chat_id: digits + '@c.us', status: 'open', unread_count: 0,
              last_message_text: null, last_message_at: null, last_direction: null, created_at: null,
              contact: { id: null, avatar: false, name: null, phone: digits, email: null, company: null, avatar_path: null },
              person: { full_name: null, programas: [] }, notes: { open: 0, pinned: 0, overdue: 0 },
            });
          } else {
            toast('No se encontró esa conversación en tus líneas.', true);
          }
        });
      }).catch(function () {});
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
      { key: 'pinned', label: 'Importantes', icon: 'ri-pushpin-2-line', tone: 'pin' },
      { key: 'pending', label: 'Pendientes', icon: 'ri-time-line', tone: 'brand' },
      { key: 'derived', label: 'Derivaciones', icon: 'ri-share-forward-line', tone: 'info' },
      { key: 'done', label: 'Resueltas', icon: 'ri-check-double-line', tone: 'ok' },
      { key: 'all', label: 'Todas', icon: 'ri-stack-line', tone: 'mute' },
    ];
    var GROUP_LABELS = {
      pinned: 'Importantes', overdue: 'Vencidas', today: 'Para hoy', soon: 'Próximos 7 días',
      later: 'Más adelante', none: 'Sin fecha de seguimiento', done: 'Resueltas',
      trash: 'En la papelera',
      d_unseen: 'Sin ver por el responsable', d_nocontact: 'Vistas, sin confirmar contacto', d_contacted: 'Con contacto confirmado',
    };
    var GROUP_ORDER = ['d_unseen', 'd_nocontact', 'd_contacted', 'pinned', 'overdue', 'today', 'soon', 'later', 'none', 'done', 'trash'];
    // Nota abierta desde una notificación (?nota=ID).
    var focusId = Number(new URLSearchParams(location.search).get('nota')) || 0;

    var els = {
      stats: root.querySelector('#np-stats'),
      search: root.querySelector('#notes-search'),
      order: root.querySelector('#notes-order'),
      mine: root.querySelector('#notes-mine'),
      assigned: root.querySelector('#notes-assigned'),
      active: root.querySelector('#np-active'),
      list: root.querySelector('#notes-list'),
      tags: root.querySelector('#np-tags'),
      manage: root.querySelector('#np-manage'),
      tagForm: root.querySelector('#np-tag-form'),
      tagName: root.querySelector('#tag-name'),
      tagColors: root.querySelector('#tag-colors'),
      tagSave: root.querySelector('#tag-save'),
    };
    var st = { status: 'pending', tag: null, tags: [], colors: ['#045474'], color: '#045474', notes: [], stats: null, managing: false, view: 'list' };
    try { if (localStorage.getItem('notes-view') === 'board') st.view = 'board'; } catch (_) {}
    els.board = root.querySelector('#np-board');

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
      // El pipeline muestra todas las etapas a la vez (sin papelera).
      var status = st.view === 'board' ? 'all' : st.status;
      var p = ['status=' + status, 'order=' + (els.order.value || 'due')];
      if (focusId) p.push('ids=' + focusId);
      if (els.search.value.trim()) p.push('q=' + encodeURIComponent(els.search.value.trim()));
      if (st.tag) p.push('tag=' + st.tag);
      if (els.mine.checked) p.push('mine=1');
      if (els.assigned && els.assigned.checked) p.push('assigned=1');
      els.list.classList.add('loading');
      return api('/notes/all?' + p.join('&')).then(function (d) {
        st.notes = (d && d.notes) || [];
        st.stats = d && d.stats;
        renderStats();
        if (st.view === 'board') renderBoard(); else renderNotes();
        markSeen();
      }).catch(function (e) { toast(e.message, true); })
        .then(function () { els.list.classList.remove('loading'); });
    }

    function refresh() { return loadNotes().then(loadTags); }

    // Lo que tengo derivado y estoy viendo en la lista queda «visto»; la nota de
    // una notificación, además, deja sus avisos leídos.
    function markSeen() {
      st.notes.forEach(function (n) {
        if ((n.assigned_to_me && !n.seen_at && !n.contacted_at) || n.id === focusId) {
          jsonApi('/inbox/notes/' + n.id + '/seen', 'POST')
            .then(function (r) { n.seen_at = r.seen_at; if (window.__setNotifBadge) window.__setNotifBadge(r.unread); })
            .catch(function () {});
        }
      });
    }

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
      var trashBtn = root.querySelector('#notes-trash');
      if (trashBtn) {
        var on = st.status === 'trash';
        trashBtn.classList.toggle('on', on);
        trashBtn.setAttribute('aria-pressed', String(on));
        var cnt = trashBtn.querySelector('.np-trash-count');
        if (cnt) cnt.textContent = s.trash ? String(s.trash) : '';
      }
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
      if (n.deleted_at) return 'trash';
      if ((els.order.value || 'due') === 'created') {
        var days = Math.floor((Date.now() - new Date(n.created_at).getTime()) / 86400000);
        return days < 1 ? 'Registradas hoy' : days < 2 ? 'Ayer' : days < 7 ? 'Esta semana' : days < 31 ? 'Este mes' : 'Anteriores';
      }
      if (st.status === 'derived') return n.contacted_at ? 'd_contacted' : n.seen_at ? 'd_nocontact' : 'd_unseen';
      return NoteKit.isPinned(n) ? 'pinned' : NoteKit.dueState(n);
    }

    function renderNotes() {
      var notes = st.notes;
      if (!notes.length) {
        var msg = {
          overdue: '¡Al día! No hay seguimientos vencidos.',
          today: 'No hay seguimientos para hoy.',
          week: 'No hay seguimientos en los próximos 7 días.',
          pinned: 'No hay notas marcadas como importantes.',
          trash: 'La papelera está vacía.',
          derived: 'No hay derivaciones abiertas.',
          pending: 'No hay notas pendientes de seguimiento.',
          done: 'Todavía no se marcó ninguna nota como resuelta.',
          all: 'Todavía no hay notas.',
        }[st.status];
        var filtered = els.search.value.trim() || st.tag || els.mine.checked || (els.assigned && els.assigned.checked);
        els.list.innerHTML = '<div class="np-empty"><span class="' + (st.status === 'overdue' ? 'ri-checkbox-circle-line' : 'ri-sticky-note-line') + '" aria-hidden="true"></span>' +
          '<p>' + (filtered ? 'No hay notas para los filtros elegidos.' : msg) + '</p>' +
          '<span class="np-empty-sub">Las notas se registran desde la ficha del contacto, dentro de cada conversación.</span></div>';
        return;
      }
      var byDue = (els.order.value || 'due') === 'due' || st.status === 'trash' || st.status === 'derived';
      var groups = {};
      var order = [];
      notes.forEach(function (n) {
        var k = groupKey(n);
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(n);
      });
      if (byDue) order.sort(function (a, b) { return GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b); });
      var s = st.stats || {};
      var head = focusId
        ? '<div class="np-focus"><span class="ri-notification-3-line" aria-hidden="true"></span>Mostrando la nota del aviso.<button type="button" class="np-clear" id="np-focus-clear">Ver todas</button></div>'
        : st.status === 'derived'
          ? '<div class="np-deriv-sum">' +
              '<span class="is-wait"><b>' + (s.derived_unseen || 0) + '</b>sin ver</span>' +
              '<span class="is-warn"><b>' + (s.derived_no_contact || 0) + '</b>vistas sin contacto</span>' +
              '<span class="is-ok"><b>' + (s.derived_contacted || 0) + '</b>con contacto confirmado</span>' +
            '</div>'
          : '';
      els.list.innerHTML = head + order.map(function (k) {
        var label = byDue ? GROUP_LABELS[k] : k;
        return '<section class="np-group np-group-' + (byDue ? k : 'time') + '">' +
          '<h6 class="np-group-title">' + escapeHtml(label) + ' <span>' + groups[k].length + '</span></h6>' +
          '<div class="np-cards">' + groups[k].map(function (n) { return NoteKit.cardHtml(n, { showContact: true }); }).join('') + '</div>' +
        '</section>';
      }).join('');
      var clearFocus = els.list.querySelector('#np-focus-clear');
      if (clearFocus) clearFocus.addEventListener('click', function () {
        focusId = 0;
        history.replaceState(null, '', '/notes');
        loadNotes();
      });
      NoteKit.bindCards(els.list, {
        find: function (id) { return st.notes.filter(function (n) { return n.id === id; })[0]; },
        tags: function () { return st.tags; },
        onChanged: function () { refresh(); },
      });
    }

    /* ── Pipeline de seguimiento (tablero por etapas) ── */
    var STAGES = [
      { key: 'todo', label: 'Por hacer', icon: 'ri-inbox-line', hint: 'Registradas o derivadas que todavía nadie tomó.' },
      { key: 'doing', label: 'En gestión', icon: 'ri-loader-2-line', hint: 'Alguien ya la está atendiendo.' },
      { key: 'contacted', label: 'Contactado', icon: 'ri-phone-line', hint: 'Hubo comunicación con la persona; falta cerrar.' },
      { key: 'done', label: 'Resuelta', icon: 'ri-check-double-line', hint: 'Cerradas en los últimos 14 días.' },
    ];
    var STAGE_KEYS = STAGES.map(function (s) { return s.key; });

    function stageOf(n) {
      if (n.done_at) return 'done';
      if (n.contacted_at) return 'contacted';
      if (n.pipeline_stage === 'doing' || (n.assigned_to && n.seen_at)) return 'doing';
      return 'todo';
    }

    function canMove(n) { return !!(n.can_edit || n.assigned_to_me); }

    function boardCard(n) {
      var due = n.due_at ? NoteKit.dueState(n) : null;
      var contact = n.contact_name || (n.contact_phone ? '+' + n.contact_phone : String(n.chat_id || '').split('@')[0]);
      var text = (n.note_text || (n.audio_path ? 'Nota de voz' : '')).replace(/\s+/g, ' ');
      var tags = (n.tags || []).map(function (t) { return '<span class="pl-tag" style="--tag:' + t.color + '" title="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</span>'; }).join('');
      var movable = canMove(n);
      var idx = STAGE_KEYS.indexOf(stageOf(n));
      return '<article class="pl-card' + (due === 'overdue' && !n.done_at ? ' is-overdue' : '') + (NoteKit.isPinned(n) && !n.done_at ? ' is-pinned' : '') + '"' +
          ' data-id="' + n.id + '"' + (movable ? ' draggable="true"' : '') + ' tabindex="0">' +
        '<div class="pl-top">' +
          '<a class="pl-contact" href="/conversations/' + encodeURIComponent(n.chat_id) + '" title="Abrir la conversación">' +
            '<span class="ri-whatsapp-line" aria-hidden="true"></span>' + escapeHtml(contact) + '</a>' +
          (NoteKit.isPinned(n) && !n.done_at ? '<span class="pl-pin ri-pushpin-2-fill" title="Importante"></span>' : '') +
        '</div>' +
        (text ? '<div class="pl-text">' + escapeHtml(text.slice(0, 220)) + '</div>' : '') +
        (n.contact_result && n.contacted_at ? '<div class="pl-result"><span class="ri-chat-check-line"></span> ' + escapeHtml(n.contact_result.slice(0, 140)) + '</div>' : '') +
        (tags ? '<div class="pl-tags">' + tags + '</div>' : '') +
        '<div class="pl-foot">' +
          (n.due_at ? '<span class="pl-due pl-due-' + (n.done_at ? 'done' : due) + '"><span class="ri-calendar-event-line"></span> ' + escapeHtml(NoteKit.dueLabel(n)) + '</span>' : '') +
          (n.assigned_name ? '<span class="pl-who" title="Responsable"><span class="ri-user-received-2-line"></span> ' + escapeHtml(n.assigned_name) + '</span>'
            : '<span class="pl-who" title="Registró"><span class="ri-user-line"></span> ' + escapeHtml(n.author_name || 'Equipo') + '</span>') +
        '</div>' +
        (movable
          ? '<div class="pl-move">' +
              (idx > 0 ? '<button type="button" class="pl-mv" data-to="' + STAGE_KEYS[idx - 1] + '" title="Mover a «' + STAGES[idx - 1].label + '»"><span class="ri-arrow-left-s-line"></span></button>' : '<span></span>') +
              (idx < STAGES.length - 1 ? '<button type="button" class="pl-mv pl-mv-next" data-to="' + STAGE_KEYS[idx + 1] + '">' + STAGES[idx + 1].label + ' <span class="ri-arrow-right-s-line"></span></button>' : '') +
            '</div>'
          : '') +
      '</article>';
    }

    function renderBoard() {
      var cutoff = Date.now() - 14 * 86400000;
      var cols = {};
      STAGE_KEYS.forEach(function (k) { cols[k] = []; });
      st.notes.forEach(function (n) {
        if (n.deleted_at) return;
        var k = stageOf(n);
        if (k === 'done' && new Date(n.done_at).getTime() < cutoff) return;
        cols[k].push(n);
      });
      // Dentro de cada columna: importantes y vencidas arriba, luego por fecha.
      var rank = function (n) { return (NoteKit.isPinned(n) ? 0 : 2) + (n.due_at && NoteKit.dueState(n) === 'overdue' ? 0 : 1); };
      STAGE_KEYS.forEach(function (k) {
        cols[k].sort(function (a, b) {
          if (k === 'done') return String(b.done_at).localeCompare(String(a.done_at));
          return rank(a) - rank(b) || String(a.due_at || '9999').localeCompare(String(b.due_at || '9999'));
        });
      });
      els.board.innerHTML = STAGES.map(function (s) {
        var list = cols[s.key];
        return '<section class="pl-col pl-col-' + s.key + '" data-stage="' + s.key + '">' +
          '<header class="pl-col-head"><span class="pl-col-ic ' + s.icon + '" aria-hidden="true"></span>' +
            '<span class="pl-col-title">' + s.label + '</span><span class="pl-col-count">' + list.length + '</span></header>' +
          '<p class="pl-col-hint">' + s.hint + '</p>' +
          '<div class="pl-col-body">' + (list.length ? list.map(boardCard).join('') : '<div class="pl-empty">Arrastrá una nota aquí</div>') + '</div>' +
        '</section>';
      }).join('');
      bindBoard();
    }

    function moveNote(id, to) {
      var n = st.notes.filter(function (x) { return x.id === id; })[0];
      if (!n || stageOf(n) === to) return;
      var send = function (result) {
        jsonApi('/inbox/notes/' + id + '/stage', 'POST', { stage: to, result: result || '' })
          .then(function () {
            toast('Nota movida a «' + STAGES[STAGE_KEYS.indexOf(to)].label + '»');
            loadNotes();
          })
          .catch(function (e) { toast(e.message, true); renderBoard(); });
      };
      if (to === 'contacted') askResult(n, send); else send();
    }

    // «Contactado» pide el resultado de la comunicación (queda en el historial).
    function askResult(n, done) {
      var wrap = document.createElement('div');
      wrap.className = 'pl-dialog-backdrop';
      wrap.innerHTML = '<div class="pl-dialog" role="dialog" aria-modal="true" aria-labelledby="pl-dlg-title">' +
        '<h6 id="pl-dlg-title"><span class="ri-phone-line"></span> ¿Cómo fue la comunicación?</h6>' +
        '<p class="pl-dialog-sub">' + escapeHtml(n.contact_name || n.contact_phone || '') + '</p>' +
        '<textarea class="form-control" rows="3" maxlength="1000" placeholder="Ej.: Se le explicó el pago, queda en depositar el viernes."></textarea>' +
        '<div class="pl-dialog-actions"><button type="button" class="btn btn-light btn-sm" data-act="cancel">Cancelar</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="ok">Guardar</button></div></div>';
      document.body.appendChild(wrap);
      var ta = wrap.querySelector('textarea');
      ta.focus();
      var close = function () { wrap.remove(); renderBoard(); };
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
      wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
      wrap.querySelector('[data-act="ok"]').addEventListener('click', function () {
        var v = ta.value.trim();
        if (v.length < 3) { ta.focus(); toast('Contá brevemente cómo fue la comunicación.', true); return; }
        wrap.remove();
        done(v);
      });
      ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    }

    function bindBoard() {
      var dragId = null;
      Array.prototype.forEach.call(els.board.querySelectorAll('.pl-card[draggable="true"]'), function (c) {
        c.addEventListener('dragstart', function (e) {
          dragId = Number(c.getAttribute('data-id'));
          c.classList.add('dragging');
          try { e.dataTransfer.setData('text/plain', String(dragId)); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
        });
        c.addEventListener('dragend', function () { c.classList.remove('dragging'); });
      });
      Array.prototype.forEach.call(els.board.querySelectorAll('.pl-col'), function (col) {
        col.addEventListener('dragover', function (e) { if (dragId) { e.preventDefault(); col.classList.add('over'); } });
        col.addEventListener('dragleave', function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
        col.addEventListener('drop', function (e) {
          e.preventDefault();
          col.classList.remove('over');
          if (dragId) moveNote(dragId, col.getAttribute('data-stage'));
          dragId = null;
        });
      });
      Array.prototype.forEach.call(els.board.querySelectorAll('.pl-mv'), function (b) {
        b.addEventListener('click', function () {
          var id = Number(b.closest('.pl-card').getAttribute('data-id'));
          moveNote(id, b.getAttribute('data-to'));
        });
      });
    }

    function applyView() {
      Array.prototype.forEach.call(root.querySelectorAll('.np-view-btn'), function (b) {
        var on = b.getAttribute('data-view') === st.view;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      var board = st.view === 'board';
      els.list.hidden = board;
      els.board.hidden = !board;
      els.stats.hidden = board;
      els.order.hidden = board;
      var trash = root.querySelector('#notes-trash');
      if (trash) trash.hidden = board;
    }

    Array.prototype.forEach.call(root.querySelectorAll('.np-view-btn'), function (b) {
      b.addEventListener('click', function () {
        st.view = b.getAttribute('data-view');
        if (st.view === 'board' && st.status === 'trash') st.status = 'pending';
        try { localStorage.setItem('notes-view', st.view); } catch (_) {}
        applyView();
        loadNotes();
      });
    });
    applyView();

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
    var trashToggle = root.querySelector('#notes-trash');
    if (trashToggle) trashToggle.addEventListener('click', function () {
      st.status = st.status === 'trash' ? 'pending' : 'trash';
      loadNotes();
    });
    // En vivo: lo que el equipo registra o completa aparece sin recargar.
    if (liveSource()) {
      var liveTimer = null;
      liveSource().addEventListener('note', function () {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(refresh, 600);
      });
    }
    els.search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(loadNotes, 250); });
    els.order.addEventListener('change', loadNotes);
    els.mine.addEventListener('change', loadNotes);
    if (els.assigned) {
      if (location.hash === '#asignadas') els.assigned.checked = true;
      els.assigned.addEventListener('change', loadNotes);
    }

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

  /* ── Seguimiento y reportes: gráficos + actualización automática ──
     Paleta categórica validada (referencia del skill de visualización): azul,
     naranja y aguamarina en orden fijo; los colores de estado no se usan para series. */
  function initFollowupCharts() {
    var dataEl = document.getElementById('fu-data');
    var page = document.querySelector('.fu-page');
    if (!page) return;

    // Actualización automática (Seguimiento): solo con la pestaña visible y sin
    // un campo con foco, para no interrumpir a quien está filtrando.
    var every = Number(page.getAttribute('data-autorefresh') || 0);
    var stamp = document.getElementById('fu-updated');
    if (stamp) {
      stamp.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
    }
    if (every > 0) {
      setInterval(function () {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (document.visibilityState === 'visible' && !/INPUT|SELECT|TEXTAREA/.test(tag)) location.reload();
      }, every * 1000);
    }

    if (!dataEl || !window.ApexCharts) return;
    var data;
    try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }

    var dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    var C = dark
      ? { s1: '#3987e5', s2: '#d95926', s3: '#199e70', ink: '#c3cedd', mute: '#8b9cb3', grid: '#223148' }
      : { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', ink: '#475467', mute: '#98a2b3', grid: '#e6ebf1' };
    var font = getComputedStyle(document.body).fontFamily || 'inherit';

    function base(type, extra) {
      return Object.assign({
        chart: { type: type, height: 300, fontFamily: font, toolbar: { show: false }, foreColor: C.ink, animations: { enabled: false }, background: 'transparent' },
        theme: { mode: dark ? 'dark' : 'light' },
        dataLabels: { enabled: false },
        grid: { borderColor: C.grid, strokeDashArray: 3, padding: { left: 8, right: 8 } },
        legend: { position: 'top', horizontalAlign: 'left', fontSize: '12px', markers: { size: 6 } },
        tooltip: { theme: dark ? 'dark' : 'light' },
        stroke: { width: 2 }
      }, extra || {});
    }
    function render(id, opts) {
      var el = document.getElementById(id);
      if (!el) return;
      new ApexCharts(el, opts).render();
    }
    function empty(id, text) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="fu-chart-empty"><span class="ri-bar-chart-2-line"></span>' + text + '</div>';
    }
    function shortDay(d) {
      var p = String(d).split('-');
      return p.length === 3 ? p[2] + '/' + p[1] : d;
    }
    var barEnds = { bar: { borderRadius: 4, borderRadiusApplication: 'end', columnWidth: '60%' } };

    if (data.kind === 'monitoring') {
      var hours = data.hours || [];
      var used = hours.filter(function (h) { return h.received || h.sent; });
      if (!used.length) { empty('fuHours', 'Todavía no hay mensajes en el período.'); return; }
      // Rango útil del día (sin las horas vacías de la madrugada/noche).
      var first = Math.max(0, Math.min(7, used[0].hour)), last = Math.min(23, Math.max(20, used[used.length - 1].hour));
      var slice = hours.filter(function (h) { return h.hour >= first && h.hour <= last; });
      render('fuHours', base('bar', {
        series: [
          { name: 'Recibidos', data: slice.map(function (h) { return h.received; }) },
          { name: 'Enviados', data: slice.map(function (h) { return h.sent; }) }
        ],
        colors: [C.s1, C.s2],
        plotOptions: barEnds,
        stroke: { width: 2, colors: ['transparent'] },
        xaxis: { categories: slice.map(function (h) { return String(h.hour).padStart(2, '0') + 'h'; }), axisBorder: { color: C.grid }, axisTicks: { show: false } },
        yaxis: { labels: { formatter: function (v) { return Math.round(v); } } },
        tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light' }
      }));
      return;
    }

    if (data.kind === 'reports') {
      var daily = data.daily || [];
      if (daily.some(function (d) { return d.received || d.sent; })) {
        render('fuDaily', base('line', {
          series: [
            { name: 'Recibidos', data: daily.map(function (d) { return d.received; }) },
            { name: 'Enviados', data: daily.map(function (d) { return d.sent; }) }
          ],
          colors: [C.s1, C.s2],
          markers: { size: daily.length > 20 ? 0 : 4, strokeWidth: 2, strokeColors: dark ? '#111b2a' : '#fff', hover: { size: 6 } },
          xaxis: { categories: daily.map(function (d) { return shortDay(d.day); }), tickAmount: Math.min(daily.length, 10), axisBorder: { color: C.grid }, axisTicks: { show: false }, labels: { rotate: 0, hideOverlappingLabels: true } },
          yaxis: { labels: { formatter: function (v) { return Math.round(v); } } },
          tooltip: { shared: true, intersect: false, theme: dark ? 'dark' : 'light' }
        }));
      } else empty('fuDaily', 'Sin mensajes en el período.');

      var resp = daily.filter(function (d) { return d.medianMin != null; });
      if (resp.length) {
        render('fuResponse', base('bar', {
          series: [{ name: 'Mediana (min)', data: daily.map(function (d) { return d.medianMin; }) }],
          colors: [C.s1],
          plotOptions: barEnds,
          legend: { show: false },
          xaxis: { categories: daily.map(function (d) { return shortDay(d.day); }), tickAmount: Math.min(daily.length, 10), axisBorder: { color: C.grid }, axisTicks: { show: false }, labels: { rotate: 0, hideOverlappingLabels: true } },
          yaxis: { labels: { formatter: function (v) { return Math.round(v) + ' min'; } } },
          tooltip: { theme: dark ? 'dark' : 'light', y: { formatter: function (v) { return v == null ? 'sin respuestas' : Math.round(v) + ' min'; } } }
        }));
      } else empty('fuResponse', 'Sin respuestas en el período.');

      function hbar(id, items, color, emptyText) {
        if (!items.length) { empty(id, emptyText); return; }
        render(id, base('bar', {
          chart: { type: 'bar', height: Math.max(180, items.length * 34 + 60), fontFamily: font, toolbar: { show: false }, foreColor: C.ink, animations: { enabled: false }, background: 'transparent' },
          series: [{ name: 'Envíos', data: items.map(function (t) { return t.total; }) }],
          colors: [color],
          legend: { show: false },
          plotOptions: { bar: { horizontal: true, borderRadius: 4, borderRadiusApplication: 'end', barHeight: '62%' } },
          dataLabels: { enabled: true, style: { colors: [C.ink], fontWeight: 600 }, offsetX: 18, textAnchor: 'start' },
          xaxis: { categories: items.map(function (t) { return t.label; }), axisBorder: { show: false }, axisTicks: { show: false } },
          grid: { borderColor: C.grid, strokeDashArray: 3, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } }
        }));
      }
      hbar('fuTipo', data.tipos || [], C.s1, 'Sin envíos de lotes o cronogramas en el período.');
      hbar('fuPrograma', data.programas || [], C.s1, 'Sin envíos por programa en el período.');
    }
  }

  // Formularios de acción única (desvincular, reconectar): evita el doble envío.
  function initOnceForms() {
    Array.prototype.forEach.call(document.querySelectorAll('form.js-once'), function (form) {
      form.addEventListener('submit', function () {
        var btn = form.querySelector('[type="submit"]');
        if (!btn) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Procesando…';
      });
    });
  }

  // Confirmación antes de acciones delicadas: `data-confirm` en el formulario o
  // en el botón que lo envía (p. ej. «Aplicar valores del perfil»).
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    var btn = ev.submitter;
    var msg = (btn && btn.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) ev.preventDefault();
  }, true);

  // Editor de plantillas: vista previa con formato de WhatsApp mientras se escribe
  // (mismo formato que `waPreview` en src/panel/admin-views.ts).
  (function initTemplateEditor() {
    var form = document.querySelector('[data-tpl-editor]');
    if (!form) return;
    var ta = form.querySelector('textarea[name="body"]');
    var preview = form.querySelector('[data-tpl-preview]');
    var vars = form.querySelector('[data-tpl-vars]');
    var count = form.querySelector('[data-tpl-count]');
    var hint = form.querySelector('[data-tpl-spinhint]');
    var SPIN = /\{[^{}]*\|[^{}]*\}/;
    function wa(body) {
      return escapeHtml(body)
        .replace(/\{\{\s*([\w.]+)\s*\}\}/g, '<span class="tpl-var">$1</span>')
        .replace(/\{([^{}]*\|[^{}]*)\}/g, function (_m, g) { return '<span class="tpl-spin" title="Se elige una al azar">' + g.split('|').join('<i>|</i>') + '</span>'; })
        .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
        .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
        .replace(/~([^~\n]+)~/g, '<s>$1</s>')
        .replace(/\n/g, '<br>');
    }
    function update() {
      var body = ta.value;
      preview.innerHTML = body.trim() ? wa(body) : '<span class="text-muted">Escribí el texto para ver cómo llega.</span>';
      var found = {};
      body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_m, n) { found[n] = true; return _m; });
      vars.innerHTML = Object.keys(found).map(function (n) { return '<span class="tpl-var">' + escapeHtml(n) + '</span>'; }).join('');
      count.textContent = body.length + ' caracteres';
      hint.hidden = !body.trim() || SPIN.test(body);
    }
    ta.addEventListener('input', update);
    update();
  })();

  initInbox();
  initNotes();
  initReminders();
  initNotifications();
  initTemplatesManager();
  initActivity();
  initOnceForms();
  initFollowupCharts();
})();
