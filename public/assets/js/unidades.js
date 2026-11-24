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

  // --- Editar usuario (página Usuarios) ------------------------------------
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ub-edit-user]');
    if (!button) return;
    event.preventDefault();
    const dialog = document.getElementById('ub-user-edit');
    if (!dialog) return;
    const form = dialog.querySelector('form');
    const data = button.dataset;
    form.action = '/users/' + data.id;
    const setValue = (name, value) => {
      const field = form.querySelector('[name="' + name + '"]');
      if (field) field.value = value || '';
    };
    setValue('name', data.name);
    setValue('ci', data.ci);
    setValue('username', data.username);
    setValue('email', data.email);
    setValue('numero', data.numero);
    setValue('password', '');
    const autorizado = form.querySelector('[name="autorizado"]');
    if (autorizado) autorizado.checked = data.autorizado === '1';

    const isLocal = data.local === '1';
    const isSuper = data.super === '1';
    const basicEditable = isLocal || isSuper;
    const rolesEditable = isLocal && !isSuper;
    const ciEditable = isLocal && !isSuper;

    for (const name of ['name', 'username', 'email', 'numero', 'password']) {
      const field = form.querySelector('[name="' + name + '"]');
      if (field) {
        field.disabled = !basicEditable;
        field.readOnly = !basicEditable;
      }
    }
    const ciField = form.querySelector('[name="ci"]');
    if (ciField) ciField.disabled = !ciEditable;
    const areaSelect = form.querySelector('[name="area"]');
    const cargoSelect = form.querySelector('[name="cargo"]');
    if (areaSelect) areaSelect.disabled = !rolesEditable;
    if (cargoSelect) cargoSelect.disabled = !rolesEditable;

    const rolesPill = form.querySelector('[data-roles]');
    const rolesHelp = form.querySelector('[data-roles-help]');
    const rolesNote = form.querySelector('[data-roles-note]');
    if (rolesPill) rolesPill.textContent = data.roles || 'Sin cargo';
    if (rolesNote) rolesNote.textContent = isLocal ? 'Cuenta local' : isSuper ? 'Super Admin' : 'Cuenta de cronogramas';
    if (rolesHelp) {
      rolesHelp.textContent = rolesEditable
        ? 'Elegí el área y el cargo de esta persona.'
        : isSuper
          ? 'La cuenta principal mantiene acceso total al panel.'
          : 'El área y el cargo se actualizan al iniciar sesión desde cronogramas.';
    }

    // Unidad de negocio → sede
    const units = JSON.parse(form.dataset.units || '[]');
    const sedes = JSON.parse(form.dataset.sedes || '[]');
    const unitSelect = form.querySelector('#eu-unit');
    const sedeSelect = form.querySelector('#eu-sede');
    if (unitSelect && sedeSelect) {
      unitSelect.innerHTML = '';
      unitSelect.add(new Option('Sin unidad de negocio', ''));
      units.forEach((unit) => unitSelect.add(new Option(unit.name, String(unit.id))));
      unitSelect.value = data.unit ? String(data.unit) : '';
      const fillSedes = (unitId, selected) => {
        sedeSelect.innerHTML = '';
        sedeSelect.add(new Option(unitId ? 'Sin sede' : 'Primero elegí la unidad', ''));
        sedes
          .filter((sede) => !unitId || String(sede.unitId) === String(unitId))
          .forEach((sede) => sedeSelect.add(new Option(sede.name, String(sede.id))));
        sedeSelect.disabled = !unitId;
        if (selected && [...sedeSelect.options].some((option) => option.value === String(selected))) {
          sedeSelect.value = String(selected);
        }
      };
      fillSedes(data.unit || '', data.sede || '');
      unitSelect.onchange = () => fillSedes(unitSelect.value, '');
    }

    // Área → cargo
    if (areaSelect) {
      areaSelect.value = data.area || '';
      areaSelect.dispatchEvent(new Event('change'));
      if (cargoSelect && data.cargo && [...cargoSelect.options].some((option) => option.value === data.cargo)) {
        cargoSelect.value = data.cargo;
      }
    }
    // El render de cargos vuelve a habilitar el select; si el cargo no se
    // edita (cronogramas / Super Admin), se vuelve a bloquear después.
    if (!rolesEditable) {
      if (areaSelect) areaSelect.disabled = true;
      if (cargoSelect) cargoSelect.disabled = true;
    }

    dialog.showModal();
    form.querySelectorAll('[data-v]').forEach((field) => field.dispatchEvent(new Event('input')));
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
        const box = field.closest('.ab-field');
        const error = box ? box.querySelector('[data-error]') : null;
        if (field.disabled) {
          if (error) error.textContent = '';
          field.classList.remove('is-invalid');
          continue;
        }
        const message = errorFor(field);
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
