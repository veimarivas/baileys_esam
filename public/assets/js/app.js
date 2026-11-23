/* Respaldo local de los comportamientos mínimos de Velzon que usa el shell:
   hamburguesa del menú, cambio de tema y cierre del overlay móvil. */
(function () {
  'use strict';

  function setTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    try {
      localStorage.setItem('baileys-theme', theme);
      sessionStorage.setItem('data-bs-theme', theme);
    } catch (e) {
      /* almacenamiento no disponible */
    }
  }

  function isDesktop() {
    return window.matchMedia('(min-width: 992px)').matches;
  }

  function syncSidebarButton() {
    var btn = document.getElementById('esam-sidebar-toggle');
    if (!btn) return;
    var open = isDesktop()
      ? document.documentElement.getAttribute('data-sidebar-size') !== 'sm'
      : document.body.classList.contains('sidebar-enable');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggleSidebar() {
    if (isDesktop()) {
      var sm = document.documentElement.getAttribute('data-sidebar-size') === 'sm';
      document.documentElement.setAttribute('data-sidebar-size', sm ? 'lg' : 'sm');
      try {
        localStorage.setItem('baileys-sidebar', sm ? 'lg' : 'sm');
      } catch (e) {
        /* almacenamiento no disponible */
      }
    } else {
      document.body.classList.toggle('sidebar-enable');
    }
    syncSidebarButton();
  }

  document.addEventListener('click', function (event) {
    var target = event.target;

    if (target.closest('#esam-sidebar-toggle, #topnav-hamburger-icon, #vertical-hover')) {
      toggleSidebar();
      return;
    }

    if (target.closest('.vertical-overlay')) {
      document.body.classList.remove('sidebar-enable');
      syncSidebarButton();
      return;
    }

    if (target.closest('.light-dark-mode')) {
      var current = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      setTheme(current);
    }
  });

  // Mantiene sincronizado el ícono de luna/sol del botón de tema.
  function syncThemeIcon() {
    var dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    document.querySelectorAll('.light-dark-mode i').forEach(function (icon) {
      icon.className = dark ? 'ri-sun-line fs-22' : 'ri-moon-line fs-22';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    syncThemeIcon();
    syncSidebarButton();
  });
  new MutationObserver(syncThemeIcon).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bs-theme'],
  });
  new MutationObserver(syncSidebarButton).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-sidebar-size'],
  });
  window.addEventListener('resize', function () {
    if (isDesktop()) document.body.classList.remove('sidebar-enable');
    syncSidebarButton();
  });
})();
