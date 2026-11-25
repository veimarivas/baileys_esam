/**
 * /programas: formulario de alta y edición en ventana, con el cálculo de cada
 * cuota y del total a crédito mientras se escribe.
 */
(function () {
  'use strict';

  const page = document.getElementById('pg-page');
  const modal = document.getElementById('pg-modal');
  const form = document.getElementById('pg-form');
  if (!page || !modal || !form) return;

  const $ = (name) => form.querySelector('[name="' + name + '"]');
  const titulo = document.getElementById('pg-title');

  /** «1.500», «1500,50» → número; vacío → null. */
  function monto(texto) {
    let t = String(texto || '').trim().replace(/^bs\.?\s*/i, '').replace(/\s+/g, '');
    if (!t) return null;
    const ultimo = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
    if (ultimo >= 0 && t.length - ultimo - 1 <= 2) t = t.slice(0, ultimo).replace(/[.,]/g, '') + '.' + t.slice(ultimo + 1);
    else t = t.replace(/[.,]/g, '');
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function bs(n) {
    return 'Bs ' + n.toLocaleString('es-BO', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function recalcular() {
    let total = 0;
    let hay = false;
    ['matricula', 'colegiatura', 'certificacion'].forEach((k) => {
      const v = monto($(k).value);
      const cuotas = Math.max(1, parseInt($(k + '_cuotas').value, 10) || 1);
      const ayuda = form.querySelector('[data-pg-cuota="' + k + '_cuotas"]');
      if (v === null) {
        ayuda.textContent = '';
        return;
      }
      hay = true;
      total += v;
      ayuda.textContent = cuotas > 1 ? cuotas + ' × ' + bs(Math.round((v / cuotas) * 100) / 100) : '1 pago';
    });
    document.getElementById('pg-total').textContent = hay ? '· Total ' + bs(total) : '';
  }
  form.addEventListener('input', recalcular);

  function abrir(datos) {
    form.reset();
    let id = form.querySelector('[name="id"]');
    if (datos && datos.id) {
      if (!id) {
        id = document.createElement('input');
        id.type = 'hidden';
        id.name = 'id';
        form.appendChild(id);
      }
      id.value = datos.id;
      titulo.textContent = 'Editar programa';
      ['tipo', 'nombre', 'contado', 'matricula', 'colegiatura', 'certificacion'].forEach((k) => { $(k).value = datos[k] ?? ''; });
      $('matricula_cuotas').value = datos.matriculaCuotas || 1;
      $('colegiatura_cuotas').value = datos.colegiaturaCuotas || 1;
      $('certificacion_cuotas').value = datos.certificacionCuotas || 1;
    } else {
      if (id) id.remove();
      titulo.textContent = 'Nuevo programa';
      if (datos && datos.tipo) $('tipo').value = datos.tipo;
    }
    recalcular();
    modal.showModal();
    setTimeout(() => $('nombre').focus(), 50);
  }

  page.addEventListener('click', (event) => {
    const editar = event.target.closest('[data-pg-edit]');
    if (editar) {
      try {
        abrir(JSON.parse(editar.getAttribute('data-pg-edit')));
      } catch (e) { /* datos inválidos: no se abre */ }
      return;
    }
    const nuevo = event.target.closest('[data-pg-new]');
    if (nuevo) {
      abrir({ tipo: nuevo.getAttribute('data-pg-new') });
      return;
    }
    if (event.target.closest('[data-pg-close]')) modal.close();
  });
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });

  page.querySelectorAll('[data-pg-confirm]').forEach((f) => {
    f.addEventListener('submit', (event) => {
      if (!window.confirm(f.getAttribute('data-pg-confirm'))) event.preventDefault();
    });
  });
})();
