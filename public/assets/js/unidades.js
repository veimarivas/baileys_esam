/**
 * Unidades de negocio → sedes → usuarios.
 *
 * - Abre y cierra los modales nativos (`<dialog>`), incluida la confirmación de
 *   borrado y el formulario de edición (que se completa con los `data-*`).
 * - Valida en vivo: requeridos, largos, CI, WhatsApp, correo y duplicados
 *   (contra las listas que renderiza el servidor).
 * - Área → cargo: el select de cargos se arma según el área elegida.
 * - La contraseña se completa sola con el CI hasta que la persona la cambia.
 */
(function () {
  'use strict';

  const norm = (value) => String(value == null ? '' : value).trim();
  const digits = (value) => String(value == null ? '' : value).replace(/\D+/g, '');

  const openModal = (selector) => {
    const dialog = document.querySelector(selector);
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  };

  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-ub-open]');
    if (opener) {
      event.preventDefault();
      openModal(opener.getAttribute('data-ub-open'));
      return;
    }
    const closer = event.target.closest('[data-ub-close]');
    if (closer) {
      event.preventDefault();
      const dialog = closer.closest('dialog');
      if (dialog) dialog.close();
    }
  });

  document.querySelectorAll('dialog.ub-modal').forEach((dialog) => {
    // Cerrar al hacer clic en el fondo (fuera del formulario).
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  // --- Editar unidad (un solo modal, se completa con la tarjeta) -------------
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ub-edit-unit]');
    if (!button) return;
    event.preventDefault();
    const dialog = document.getElementById('ub-unit-edit');
    if (!dialog) return;
    const form = dialog.querySelector('form');
    form.action = button.dataset.action || '';
    const name = form.querySelector('[name="name"]');
    const code = form.querySelector('[name="code"]');
    name.value = button.dataset.name || '';
    code.value = button.dataset.code || '';
    name.dataset.self = button.dataset.self || button.dataset.name || '';
    form.querySelectorAll('[data-v]').forEach((el) => el.dispatchEvent(new Event('input')));
    dialog.showModal();
    name.focus();
  });

  // --- Editar sede (unidad o ficha de la sede) ------------------------------
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ub-edit-sede]');
    if (!button) return;
    event.preventDefault();
    const dialog = document.getElementById('ub-sede-edit');
    if (!dialog) return;
    const form = dialog.querySelector('form');
    form.action = button.dataset.action || '';
    const name = form.querySelector('[name="name"]');
    name.value = button.dataset.name || '';
    name.dataset.self = button.dataset.self || button.dataset.name || '';
    const volver = form.querySelector('[name="volver"]');
    if (volver) volver.value = button.dataset.volver || '';
    form.querySelectorAll('[data-v]').forEach((el) => el.dispatchEvent(new Event('input')));
    dialog.showModal();
    name.focus();
  });

  // --- Confirmar borrado (unidad o sede) ------------------------------------
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ub-delete]');
    if (!button || button.disabled) return;
    event.preventDefault();
    const dialog = document.querySelector(button.dataset.target || '#ub-unit-del');
    if (!dialog) return;
    const form = dialog.querySelector('form');
    form.action = button.dataset.action || '';
    const nameEl = dialog.querySelector('[data-name]');
    if (nameEl) nameEl.textContent = button.dataset.name || 'este registro';
    dialog.showModal();
  });

  // --- Validación en vivo ---------------------------------------------------
  const errorFor = (field) => {
    const value = norm(field.value);
    const rules = (field.dataset.v || '').split('|').filter(Boolean);
    for (const rule of rules) {
      const [name, arg] = rule.split(':');
      if (name === 'required' && !value) return 'Completá este campo.';
      if (!value) continue;
      if (name === 'min' && value.length < Number(arg)) return 'Mínimo ' + arg + ' caracteres.';
      if (name === 'max' && value.length > Number(arg)) return 'Máximo ' + arg + ' caracteres.';
      if (name === 'code' && !/^[A-Za-z0-9]{2,8}$/.test(value)) return 'Solo letras y números, entre 2 y 8.';
      if (name === 'ci' && !/^\d{6,10}(-[A-Za-z0-9]{1,3})?$/i.test(value)) return 'CI no válido (ej.: 1234567 o 1234567-1A).';
      if (name === 'phone' && !/^\d{8,15}$/.test(digits(value))) return 'El WhatsApp debe tener entre 8 y 15 dígitos.';
      if (name === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return 'Correo no válido.';
      if (name === 'unique') {
        const list = JSON.parse(field.form.dataset[field.dataset.uniqueList] || '[]');
        const self = norm(field.dataset.self).toLowerCase();
        if (list.some((item) => String(item).toLowerCase() === value.toLowerCase()) && value.toLowerCase() !== self) {
          return field.dataset.msgUnique || 'Ya está registrado.';
        }
      }
      if (name === 'unique-phone') {
        const list = JSON.parse(field.form.dataset[field.dataset.uniqueList] || '[]');
        const phone = digits(value);
        if (list.some((item) => digits(item) === phone)) return field.dataset.msgUnique || 'Ese número ya está registrado.';
      }
    }
    return '';
  };

  const setupForm = (form) => {
    const fields = Array.from(form.querySelectorAll('[data-v]'));
    const submit = form.querySelector('button[type="submit"]');
    const validate = () => {
      let ok = true;
      for (const field of fields) {
        const message = errorFor(field);
        const box = field.closest('.ab-field');
        const error = box ? box.querySelector('[data-error]') : null;
        if (error) error.textContent = message;
        field.classList.toggle('is-invalid', !!message);
        if (message) ok = false;
      }
      if (submit) submit.disabled = !ok;
      return ok;
    };
    for (const field of fields) {
      field.addEventListener('input', validate);
      field.addEventListener('change', validate);
      field.addEventListener('blur', validate);
    }
    form.addEventListener('submit', (event) => {
      if (!validate()) {
        event.preventDefault();
        const bad = form.querySelector('.is-invalid');
        if (bad) bad.focus();
      }
    });
    form.ubValidate = validate;
    validate();
  };

  document.querySelectorAll('form[data-ub-validate]').forEach(setupForm);

  // --- Área → cargo ---------------------------------------------------------
  document.querySelectorAll('[data-cargos-target]').forEach((areaSelect) => {
    const target = document.getElementById(areaSelect.dataset.cargosTarget);
    if (!target) return;
    const map = JSON.parse(areaSelect.dataset.cargos || '{}');
    const render = () => {
      const previous = target.value || target.dataset.value || '';
      const cargos = map[areaSelect.value] || [];
      target.innerHTML = '<option value="">' + (areaSelect.value ? 'Elegí el cargo' : 'Primero elegí el área') + '</option>'
        + cargos.map((cargo) => '<option value="' + cargo.replace(/"/g, '&quot;') + '">' + cargo + '</option>').join('');
      target.disabled = cargos.length === 0;
      if (previous && cargos.indexOf(previous) !== -1) target.value = previous;
      target.dispatchEvent(new Event('input'));
    };
    areaSelect.addEventListener('change', render);
    render();
  });

  // --- Contraseña por defecto = CI -----------------------------------------
  document.querySelectorAll('[data-from]').forEach((password) => {
    const source = document.getElementById(password.dataset.from);
    if (!source) return;
    let touched = false;
    password.addEventListener('input', () => {
      touched = true;
    });
    source.addEventListener('input', () => {
      if (touched) return;
      password.value = norm(source.value);
      if (password.form && password.form.ubValidate) password.form.ubValidate();
    });
    if (!password.value) password.value = norm(source.value);
  });

  // --- Modal indicado por la URL (después de un error del servidor) --------
  const automatic = document.querySelector('dialog[data-auto-open]');
  if (automatic) setTimeout(() => automatic.showModal(), 80);
})();
