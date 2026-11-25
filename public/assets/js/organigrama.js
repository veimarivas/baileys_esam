/**
 * Organigrama de personas (PLAN_ORGANIGRAMA.md, L1).
 *
 * Al elegir «Depende de» se guarda solo (sin JS, queda el botón «Guardar»).
 * Mientras se guarda, el selector se bloquea para no mandar dos cambios.
 */
(function () {
  'use strict';

  document.querySelectorAll('[data-op-form]').forEach((form) => {
    const select = form.querySelector('[data-op-auto]');
    const button = form.querySelector('[data-op-submit]');
    if (!select) return;
    if (button) button.hidden = true;

    select.addEventListener('change', () => {
      select.disabled = false;
      form.classList.add('is-saving');
      form.submit();
      select.disabled = true;
    });
  });

  // Volver a la sección después de guardar (el servidor redirige con #organigrama).
  if (location.hash === '#organigrama') {
    const target = document.getElementById('organigrama');
    if (target) target.scrollIntoView({ block: 'start' });
  }
})();
