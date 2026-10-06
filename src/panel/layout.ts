import fs from 'node:fs';
import path from 'node:path';
import type { UserRow } from '../auth/users.js';
import { esamAreaLabel, esamEsAdmin, esamPuede } from '../auth/users.js';
import { runtimeInfo } from '../core/runtime.js';
import { lastBackup } from '../core/backup.js';

/** Versión de assets (mtime de app.css/app.js) para evitar caché del navegador. */
const ASSET_VERSION = (() => {
  let v = 0;
  for (const file of ['app.css', 'app.js']) {
    try {
      v = Math.max(v, fs.statSync(path.resolve('public', file)).mtimeMs);
    } catch {
      // ignora archivos ausentes
    }
  }
  return v ? String(Math.floor(v)) : '1';
})();

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Versión y estado del proceso en el pie. A los administradores se les avisa
 * si hay una compilación nueva sin aplicar o si el último respaldo es viejo.
 */
function footerStatus(user: UserRow): string {
  const info = runtimeInfo();
  const backup = lastBackup();
  const title = `PID ${info.pid} · modo ${info.mode} · compilado ${shortDate(info.buildAt)} · último respaldo ${backup ? shortDate(backup.at) : 'ninguno'}`;
  let warn = '';
  if (esamEsAdmin(user)) {
    if (info.pendingRestart) {
      warn = '<span class="badge bg-warning-subtle text-warning ms-2" title="Hay código compilado más nuevo que el que está corriendo. Ejecutá npm run restart."><i class="ri-refresh-line me-1"></i>Reinicio pendiente</span>';
    } else if (!backup || Date.now() - Date.parse(backup.at) > 36 * 3_600_000) {
      warn = '<span class="badge bg-danger-subtle text-danger ms-2" title="No hay un respaldo de las últimas 36 h."><i class="ri-database-2-line me-1"></i>Sin respaldo reciente</span>';
    }
  }
  return `<span class="footer-version" title="${esc(title)}">v${esc(info.version)} · activo desde ${esc(shortDate(info.startedAt))}</span>${warn}`;
}

/** Escapa HTML. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface NavItem {
  section: string;
  href: string;
  label: string;
  icon: string;
}

/** Menú lateral (iconos Remix Icon de Velzon). */
const NAV: NavItem[] = [
  { section: 'conversations', href: '/conversations', label: 'Conversaciones', icon: 'ri-chat-3-line' },
  { section: 'conversations', href: '/notes', label: 'Notas', icon: 'ri-sticky-note-line' },
  { section: 'batches', href: '/batches', label: 'Lotes', icon: 'ri-send-plane-line' },
  { section: 'batches', href: '/import', label: 'Importar CSV', icon: 'ri-upload-2-line' },
  { section: 'templates', href: '/templates', label: 'Plantillas', icon: 'ri-file-text-line' },
  { section: 'templates', href: '/quick-replies', label: 'Plantillas rápidas', icon: 'ri-flashlight-line' },
  { section: 'autoreplies', href: '/autoreplies', label: 'Auto-respuestas', icon: 'ri-robot-2-line' },
  { section: 'stickers', href: '/stickers', label: 'Stickers', icon: 'ri-emotion-happy-line' },
  { section: 'monitoring', href: '/monitoring', label: 'Monitoreo', icon: 'ri-radar-line' },
  { section: 'reports', href: '/reports', label: 'Reportes', icon: 'ri-bar-chart-box-line' },
  { section: 'optouts', href: '/optouts', label: 'No enviar', icon: 'ri-forbid-2-line' },
  { section: 'policies', href: '/anti-ban', label: 'Anti-Baneo', icon: 'ri-shield-star-line' },
  { section: 'audit', href: '/audit', label: 'Auditoría', icon: 'ri-history-line' },
  { section: 'users', href: '/users', label: 'Usuarios', icon: 'ri-team-line' },
  { section: 'settings', href: '/settings', label: 'Conexión', icon: 'ri-plug-line' },
];

/** Cabecera compartida (head + CSS de Velzon). */
function head(title: string): string {
  return `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#045474" />
  <meta name="description" content="Panel de mensajería institucional Seguimiento ESAM: conversaciones, envíos por lotes, plantillas y monitoreo." />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(title)} · Seguimiento ESAM</title>
  <script>
    // Aplica el tema guardado antes de pintar (mantiene claro/oscuro al navegar).
    (function () {
      try {
        // localStorage es la fuente de verdad: Velzon solo actualiza el atributo al
        // pulsar el botón, así que sincronizamos sessionStorage para que su init
        // (que lee sessionStorage) no vuelva a claro al cambiar de página.
        var t = localStorage.getItem('baileys-theme') || sessionStorage.getItem('data-bs-theme') || 'light';
        document.documentElement.setAttribute('data-bs-theme', t);
        sessionStorage.setItem('data-bs-theme', t);
        document.documentElement.setAttribute('data-theme', sessionStorage.getItem('data-theme') || 'default');
      } catch (e) {}
    })();
  </script>
  <link rel="icon" href="/assets/images/favicon.ico" />
  <link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/assets/fonts/inter-latin-ext-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <script src="/assets/js/layout.js"></script>
  <link href="/assets/css/bootstrap.min.css" rel="stylesheet" />
  <link href="/assets/css/icons.min.css" rel="stylesheet" />
  <link href="/assets/css/app.min.css" rel="stylesheet" />
  <link href="/assets/css/custom.min.css" rel="stylesheet" />
  <link href="/app.css?v=${ASSET_VERSION}" rel="stylesheet" />`;
}

/** Scripts base de Velzon + los propios del panel. */
function scripts(): string {
  return `<script src="/assets/libs/bootstrap/js/bootstrap.bundle.min.js"></script>
  <script src="/assets/libs/simplebar/simplebar.min.js"></script>
  <script src="/assets/libs/node-waves/waves.min.js"></script>
  <script src="/assets/libs/feather-icons/feather.min.js"></script>
  <script src="/assets/js/plugins.js"></script>
  <script src="/assets/js/app.js"></script>
  <script src="/app.js?v=${ASSET_VERSION}"></script>`;
}

function navList(user: UserRow, active: string, restrictToSettings = false, badges: Record<string, number> = {}, activeHref = ''): string {
  return NAV.filter((n) => esamPuede(user, n.section) && (!restrictToSettings || n.section === 'settings'))
    .map((n) => {
      const count = badges[n.href] ?? 0;
      const badge = count > 0 ? ` <span class="badge rounded-pill bg-danger ms-auto">${count}</span>` : '';
      const isActive = n.href === activeHref || (!activeHref && n.section === active);
      return `<li class="nav-item">
          <a class="nav-link menu-link${isActive ? ' active' : ''}" href="${n.href}"${isActive ? ' aria-current="page"' : ''}>
            <i class="${n.icon}"></i> <span data-key="t-${n.href}">${esc(n.label)}</span>${badge}
          </a>
        </li>`;
    })
    .join('');
}

/** Layout principal con la plantilla Velzon. */
export function renderLayout(
  title: string,
  user: UserRow,
  active: string,
  body: string,
  opts: { flash?: string; error?: string; subtitle?: string; restrictToSettings?: boolean; badges?: Record<string, number>; activeHref?: string; actions?: string } = {},
): string {
  const role = esamEsAdmin(user) ? 'Administrador' : esamAreaLabel(user);
  const initials = (user.name ?? user.username ?? 'U')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const flash = opts.flash
    ? `<div class="alert alert-success alert-dismissible fade show" role="alert" data-auto-hide>
         <i class="ri-check-line align-middle me-1"></i>${esc(opts.flash)}
         <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
       </div>`
    : '';
  const error = opts.error
    ? `<div class="alert alert-danger alert-dismissible fade show" role="alert" data-auto-hide>
         <i class="ri-error-warning-line align-middle me-1"></i>${esc(opts.error)}
         <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
       </div>`
    : '';

  return `<!doctype html>
<html lang="es" data-layout="vertical" data-topbar="light" data-sidebar="dark" data-sidebar-size="lg"
      data-sidebar-image="none" data-preloader="disable" data-bs-theme="light" data-theme="default">
<head>${head(title)}</head>
<body>
<div id="layout-wrapper">
  <header id="page-topbar">
    <div class="layout-width">
      <div class="navbar-header">
        <div class="d-flex">
          <div class="navbar-brand-box horizontal-logo">
            <a href="/" class="logo logo-dark"><span class="logo-lg"><b>baileys_esam</b></span></a>
            <a href="/" class="logo logo-light"><span class="logo-lg"><b>baileys_esam</b></span></a>
          </div>
          <button type="button" class="btn btn-sm px-3 fs-16 header-item vertical-menu-btn topnav-hamburger material-shadow-none" id="topnav-hamburger-icon">
            <span class="hamburger-icon"><span></span><span></span><span></span></span>
          </button>
          <div class="app-meta-chip d-none d-md-inline-flex ms-2" title="Sesión activa">
            <span class="status-dot"></span> ${esc(user.name ?? user.username ?? 'Usuario')} · ${esc(role)}
          </div>
        </div>
        <div class="d-flex align-items-center">
          <div class="ms-1 header-item d-none d-sm-flex">
            <button type="button" class="btn btn-icon btn-topbar material-shadow-none btn-ghost-secondary rounded-circle light-dark-mode">
              <i class="ri-moon-line fs-22"></i>
            </button>
          </div>
          <div class="dropdown ms-sm-3 header-item topbar-user">
            <button type="button" class="btn material-shadow-none" id="page-header-user-dropdown" data-bs-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
              <span class="d-flex align-items-center">
                <span class="avatar-xs rounded-circle bg-soft-primary text-primary d-flex align-items-center justify-content-center fw-semibold">${esc(initials)}</span>
                <span class="text-start ms-xl-2">
                  <span class="d-none d-xl-inline-block ms-1 fw-medium user-name-text">${esc(user.name ?? user.username ?? 'Usuario')}</span>
                  <span class="d-none d-xl-block ms-1 fs-12 text-muted user-name-sub-text">${esc(role)}</span>
                </span>
              </span>
            </button>
            <div class="dropdown-menu dropdown-menu-end">
              <h6 class="dropdown-header">Hola, ${esc((user.name ?? user.username ?? '').split(' ')[0])}!</h6>
              <span class="dropdown-item-text text-muted fs-12">${esc(user.email ?? '')}</span>
              <div class="dropdown-divider"></div>
              <form method="post" action="/logout">
                <button type="submit" class="dropdown-item"><i class="ri-logout-box-r-line text-muted fs-16 align-middle me-1"></i> Cerrar sesión</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  </header>

  <div class="app-menu navbar-menu">
    <div class="navbar-brand-box">
      <a href="/" class="logo logo-dark"><span class="logo-sm"><i class="ri-whatsapp-line fs-22 text-success"></i></span><span class="logo-lg"><b>Seguimiento ESAM</b></span></a>
      <a href="/" class="logo logo-light"><span class="logo-sm"><i class="ri-whatsapp-line fs-22 text-success"></i></span><span class="logo-lg"><b>Seguimiento ESAM</b></span></a>
      <button type="button" class="btn btn-sm p-0 fs-20 header-item float-end btn-vertical-sm-hover" id="vertical-hover"><i class="ri-record-circle-line"></i></button>
    </div>
    <div id="scrollbar">
      <div class="container-fluid">
        <div id="two-column-menu"></div>
        <ul class="navbar-nav" id="navbar-nav">
          <li class="menu-title"><span data-key="t-menu">Menú</span></li>
          ${navList(user, active, opts.restrictToSettings, opts.badges, opts.activeHref)}
        </ul>
      </div>
    </div>
    <div class="sidebar-background"></div>
  </div>

  <div class="vertical-overlay"></div>

  <div class="main-content">
    <div class="page-content">
      <div class="container-fluid">
        <div class="row"><div class="col-12">
          <div class="page-title-box d-sm-flex align-items-center justify-content-between">
            <div>
              <h4 class="mb-0">${esc(title)}</h4>
              ${opts.subtitle ? `<p class="page-subtitle">${esc(opts.subtitle)}</p>` : ''}
            </div>
            <div class="page-title-right">
              ${opts.actions ? `<div class="page-title-actions">${opts.actions}</div>` : ''}
              <ol class="breadcrumb m-0 d-none d-lg-flex justify-content-end">
                <li class="breadcrumb-item"><a href="/">Inicio</a></li>
                <li class="breadcrumb-item active">${esc(title)}</li>
              </ol>
            </div>
          </div>
        </div></div>
        ${flash}${error}
        ${body}
      </div>
    </div>
    <footer class="footer">
      <div class="container-fluid">
        <div class="footer-inner">
          <div class="footer-brand">
            <span class="footer-mark"><i class="ri-whatsapp-line"></i></span>
            <span class="footer-name">Seguimiento ESAM</span>
            <span class="footer-sep" aria-hidden="true"></span>
            <span class="footer-note">Gateway Baileys · sin Chromium</span>
          </div>
          <div class="footer-meta">
            <span class="footer-copy">© ${new Date().getFullYear()} Seguimiento ESAM</span>
            <span class="footer-sep d-none d-sm-inline-block" aria-hidden="true"></span>
            ${footerStatus(user)}
          </div>
        </div>
      </div>
    </footer>
  </div>
</div>
<button onclick="topFunction()" class="btn btn-danger btn-icon" id="back-to-top"><i class="ri-arrow-up-line"></i></button>
${scripts()}
</body>
</html>`;
}

/** Pantalla de login: panel de marca + formulario. */
export function renderLogin(error?: string): string {
  return `<!doctype html>
<html lang="es" data-bs-theme="light">
<head>${head('Ingresar')}</head>
<body>
<main class="auth-page">
  <section class="auth-brand">
    <div class="auth-logo"><i class="ri-whatsapp-line"></i><span>Seguimiento ESAM</span></div>
    <h1>Mensajería institucional, en un solo lugar</h1>
    <p>Gateway de WhatsApp sobre Baileys: envíos por lotes, plantillas, auto-respuestas y monitoreo en tiempo real, sin Chromium.</p>
    <ul class="auth-points">
      <li><i class="ri-shield-check-line"></i> Ritmo anti-baneo con ventanas de envío</li>
      <li><i class="ri-flashlight-line"></i> Liviano y estable, sin navegador headless</li>
      <li><i class="ri-line-chart-line"></i> Reportes, auditoría y control de opt-out</li>
    </ul>
    <svg class="auth-pattern" viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="rgba(120,190,220,.35)" stroke-width="1">
        <line x1="40" y1="240" x2="130" y2="150" />
        <line x1="130" y1="150" x2="230" y2="190" />
        <line x1="130" y1="150" x2="180" y2="60" />
        <line x1="230" y1="190" x2="280" y2="110" />
      </g>
      <g fill="#e6dd5e">
        <circle cx="40" cy="240" r="4" />
        <circle cx="130" cy="150" r="6" fill="#2e90b5" />
        <circle cx="180" cy="60" r="4" />
        <circle cx="230" cy="190" r="4" />
        <circle cx="280" cy="110" r="3" />
      </g>
    </svg>
  </section>
  <section class="auth-form">
    <div class="auth-card">
      <div class="auth-mobile-logo"><i class="ri-whatsapp-line"></i><span>Seguimiento ESAM</span></div>
      <h2>Ingresá a tu panel</h2>
      <p class="auth-lead">Accedé con tu cuenta institucional para continuar.</p>
      ${error ? `<div class="alert alert-danger mb-3"><i class="ri-error-warning-line align-middle me-1"></i>${esc(error)}</div>` : ''}
      <form method="post" action="/login">
        <div class="mb-3">
          <label class="form-label" for="login">Usuario o correo</label>
          <input type="text" class="form-control" id="login" name="login" placeholder="Ingresá tu usuario" required autofocus />
        </div>
        <div class="mb-3">
          <label class="form-label" for="password">Contraseña</label>
          <input type="password" class="form-control" id="password" name="password" placeholder="Tu contraseña" required />
        </div>
        <div class="mt-4">
          <button class="btn btn-primary w-100" type="submit">Ingresar <i class="ri-arrow-right-line ms-1"></i></button>
        </div>
      </form>
      <p class="auth-hint">© ${new Date().getFullYear()} Seguimiento ESAM · Gateway Baileys</p>
    </div>
  </section>
</main>
${scripts()}
</body>
</html>`;
}

/** Página de error simple. */
export function renderPlain(title: string, message: string): string {
  return `<!doctype html><html lang="es" data-bs-theme="light"><head>${head(title)}</head>
<body>
<main class="error-page">
  <div class="card error-card">
    <span class="empty-ico"><i class="ri-error-warning-line"></i></span>
    <h3 class="mb-2">${esc(title)}</h3>
    <p class="text-muted mb-4">${esc(message)}</p>
    <a class="btn btn-primary" href="/">Volver al inicio</a>
  </div>
</main>
${scripts()}</body></html>`;
}
