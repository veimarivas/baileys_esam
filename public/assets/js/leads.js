/**
 * /leads (PLAN_ORGANIGRAMA.md, L3).
 *
 * - Filtros: los selectores aplican al elegir (sin JS queda el botón «Filtrar»).
 * - Ficha en panel lateral: la tarjeta abre /leads/:id/panel sin salir del
 *   tablero (sin JS, el enlace lleva a /leads/:id).
 * - Arrastrar: solo las tarjetas propias (`draggable`); el servidor vuelve a
 *   validar que el lead sea de quien lo mueve.
 */
(function () {
  'use strict';

  const page = document.getElementById('ld-page');
  if (!page) return;

  // ── Filtros ───────────────────────────────────────────────────────────────
  page.querySelectorAll('[data-ld-auto]').forEach((select) => {
    select.addEventListener('change', () => select.form && select.form.submit());
  });
  const submit = page.querySelector('[data-ld-submit]');
  if (submit) submit.hidden = true;

  // ── Mover de etapa ────────────────────────────────────────────────────────
  const board = document.getElementById('ld-board');

  function recount() {
    if (!board) return;
    board.querySelectorAll('.ld-col').forEach((col) => {
      const body = col.querySelector('.ld-col-body');
      const n = body.querySelectorAll('.ld-card').length;
      col.querySelector('.ld-col-count').textContent = String(n);
      let empty = body.querySelector('.ld-col-empty');
      if (!n && !empty) {
        empty = document.createElement('p');
        empty.className = 'ld-col-empty';
        empty.textContent = 'Sin leads';
        body.appendChild(empty);
      } else if (n && empty) {
        empty.remove();
      }
    });
  }

  function placeCard(card, etapa) {
    if (!board || !card) return;
    const body = board.querySelector('[data-drop="' + etapa + '"]');
    if (!body) return;
    card.dataset.etapa = etapa;
    body.prepend(card);
    recount();
  }

  async function mover(id, etapa) {
    const res = await fetch('/leads/' + id + '/etapa', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ etapa: etapa }),
    });
    if (res.redirected && /\/login/.test(res.url)) {
      location.href = res.url;
      throw new Error('Tu sesión venció.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo mover el lead.');
    return data;
  }

  if (board) {
    let dragging = null;
    board.addEventListener('dragstart', (event) => {
      const card = event.target.closest('.ld-card[draggable="true"]');
      if (!card) return;
      dragging = card;
      card.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.dataset.lead);
    });
    board.addEventListener('dragend', () => {
      if (dragging) dragging.classList.remove('is-dragging');
      dragging = null;
      board.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
    });
    board.querySelectorAll('[data-drop]').forEach((zone) => {
      zone.addEventListener('dragover', (event) => {
        if (!dragging) return;
        event.preventDefault();
        zone.classList.add('is-over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
      zone.addEventListener('drop', async (event) => {
        event.preventDefault();
        zone.classList.remove('is-over');
        const card = dragging;
        if (!card) return;
        const destino = zone.dataset.drop;
        const origen = card.dataset.etapa;
        if (destino === origen) return;
        placeCard(card, destino);
        try {
          await mover(card.dataset.lead, destino);
        } catch (err) {
          placeCard(card, origen);
          window.alert(err.message);
        }
      });
    });
  }

  // ── Ficha en panel lateral ────────────────────────────────────────────────
  const drawer = document.getElementById('ld-drawer');
  const drawerBody = document.getElementById('ld-drawer-body');
  const backdrop = document.getElementById('ld-backdrop');
  let lastFocus = null;

  function close() {
    if (!drawer) return;
    drawer.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('ld-drawer-open');
    if (lastFocus) lastFocus.focus();
  }

  async function open(id, trigger) {
    if (!drawer) return;
    lastFocus = trigger || null;
    drawerBody.innerHTML = '<div class="ld-drawer-loading"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Abriendo…</div>';
    drawer.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('ld-drawer-open');
    try {
      const res = await fetch('/leads/' + id + '/panel', { credentials: 'same-origin' });
      if (res.redirected && /\/login/.test(res.url)) {
        location.href = res.url;
        return;
      }
      drawerBody.innerHTML = await res.text();
      const closeBtn = drawerBody.querySelector('[data-ld-close]');
      if (closeBtn) closeBtn.focus();
      const thread = drawerBody.querySelector('.ld-thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    } catch (err) {
      drawerBody.innerHTML = '<p class="ld-muted p-3">No se pudo abrir el lead. Probá de nuevo.</p>';
    }
  }

  page.addEventListener('click', (event) => {
    const link = event.target.closest('[data-ld-open]');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      open(link.dataset.ldOpen, link);
      return;
    }
    if (event.target.closest('[data-ld-close]')) close();
  });
  if (backdrop) backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer && !drawer.hidden) close();
  });

  // Comentar desde la ficha (le llega un aviso al asesor o a los jefes).
  page.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-ld-comment]');
    if (!form || !drawer || drawer.hidden) return;
    event.preventDefault();
    const id = form.action.match(/\/leads\/(\d+)\/comentar/);
    const textarea = form.querySelector('textarea[name="texto"]');
    const button = form.querySelector('button[type="submit"]');
    if (!id || !textarea.value.trim()) return;
    if (button) button.disabled = true;
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ texto: textarea.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo enviar el comentario.');
      await open(id[1], lastFocus);
    } catch (err) {
      window.alert(err.message);
      if (button) button.disabled = false;
    }
  });

  // Mover desde la ficha (sin recargar la página).
  page.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-ld-stage]');
    if (!form) return;
    event.preventDefault();
    const id = form.action.match(/\/leads\/(\d+)\/etapa/);
    const etapa = form.querySelector('select[name="etapa"]').value;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      await mover(id[1], etapa);
      placeCard(board && board.querySelector('.ld-card[data-lead="' + id[1] + '"]'), etapa);
      await open(id[1], lastFocus);
    } catch (err) {
      window.alert(err.message);
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
