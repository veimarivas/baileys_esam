import fs from 'node:fs';
import path from 'node:path';

/** Escapa HTML para los mensajes del servidor. */
function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Versión de los assets del login (mtime) para invalidar caché. */
const LOGIN_VERSION = (() => {
  let v = 0;
  for (const file of ['assets/css/login-esam.css', 'assets/js/login-esam.js']) {
    try {
      v = Math.max(v, fs.statSync(path.resolve('public', file)).mtimeMs);
    } catch {
      // ignora archivos ausentes
    }
  }
  return v ? String(Math.floor(v)) : '1';
})();

/**
 * Logo ESAM (radar + doble check). `esam-logo` es el lockup completo del login;
 * `esam-mark` es la marca compacta para el sidebar y la cabecera del panel.
 */
export function esamLogoSymbol(): string {
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="esam-logo" viewBox="0 0 120 152">
    <path d="M98 50 A38 38 0 1 1 60 12" fill="none" stroke="#F6C445" stroke-width="7.5" stroke-linecap="round"/>
    <circle cx="98" cy="50" r="4.6" fill="#F6C445"/>
    <path d="M78 50 A18 18 0 1 1 60 32" fill="none" stroke-width="4.5" stroke-linecap="round" style="stroke:var(--logo-accent,#0E7C8C)" opacity=".55"/>
    <g fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--logo-accent,#0E7C8C)">
      <path d="M40 50 l7 8 l13 -15"/>
      <path d="M55 50 l7 8 l13 -15"/>
    </g>
    <text x="60" y="115" text-anchor="middle" font-family="Sora,Arial" font-weight="800" font-size="20" style="fill:var(--logo-ink,#0A2A4A)">ESAM</text>
    <text x="60" y="136" text-anchor="middle" font-family="Sora,Arial" font-weight="800" font-size="13.6" letter-spacing=".4" style="fill:var(--logo-accent,#0E7C8C)">SEGUIMIENTO</text>
    <text x="60" y="149" text-anchor="middle" font-family="Inter,Arial" font-weight="600" font-size="6.2" letter-spacing="2.2" fill="#F6C445">WHATSAPP · BAILEYS</text>
  </symbol>
  <symbol id="esam-mark" viewBox="0 0 120 100">
    <path d="M98 50 A38 38 0 1 1 60 12" fill="none" stroke="#F6C445" stroke-width="7.5" stroke-linecap="round"/>
    <circle cx="98" cy="50" r="4.6" fill="#F6C445"/>
    <path d="M78 50 A18 18 0 1 1 60 32" fill="none" stroke-width="4.5" stroke-linecap="round" style="stroke:var(--logo-accent,#2FD4DE)" opacity=".6"/>
    <g fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--logo-accent,#2FD4DE)">
      <path d="M40 50 l7 8 l13 -15"/>
      <path d="M55 50 l7 8 l13 -15"/>
    </g>
  </symbol>
</svg>`;
}

/** Pantalla de login con el diseño ESAM Seguimiento. */
export function renderLogin(error?: string): string {
  const year = new Date().getFullYear();
  const errorBlock = error
    ? `<div class="server-error" role="alert"><b>No pudimos iniciar sesión</b><span>${escHtml(error)}</span></div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0A2540">
<title>ESAM Seguimiento · Iniciar sesión</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath d='M88 50 A38 38 0 1 1 50 12' fill='none' stroke='%23F6C445' stroke-width='9' stroke-linecap='round'/%3E%3Cpath d='M30 50 l8 9 l15 -17 M46 50 l8 9 l15 -17' fill='none' stroke='%230E7C8C' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/login-esam.css?v=${LOGIN_VERSION}">
</head>
<body>
${esamLogoSymbol()}

<div id="loader" aria-hidden="true">
  <div class="loader-in">
    <svg class="logo"><use href="#esam-logo"/></svg>
    <div class="load-track"><div id="loadBar"></div></div>
    <div class="load-meta"><span>Cargando ESAM Seguimiento…</span><span id="loadPct">0%</span></div>
  </div>
</div>

<canvas id="scene"></canvas>
<div id="curGlow"></div>
<div class="grain"></div>
<div class="vignette"></div>
<div id="flash"></div>
<div id="cur"><div id="curRing"></div><div id="curDot"></div></div>

<div class="page">
  <main class="content">
    <section class="copy">
      <span class="kicker rv-left">ESAM SEGUIMIENTO · WHATSAPP CON BAILEYS</span>
      <h1 class="rv-left">Cada conversación,<br>con <span class="grad">seguimiento</span> real.</h1>
      <p class="lede rv-left">Sesión multidispositivo con Baileys: vinculá por QR, monitoreá mensajes en tiempo real, programá recordatorios y retomá cada lead donde quedó — sin costo por contacto.</p>

      <div class="chips rv-left" aria-label="Módulos de seguimiento">
        <button class="chip" data-node="baileys" style="--c:var(--bay)"><i></i><span class="full">Baileys · WebSocket</span><span class="short">BAY</span></button>
        <button class="chip" data-node="session" style="--c:var(--qr)"><i></i><span class="full">Sesión QR</span><span class="short">QR</span></button>
        <button class="chip" data-node="tracking" style="--c:var(--seg)"><i></i><span class="full">Seguimiento de chats</span><span class="short">SEG</span></button>
        <button class="chip" data-node="messages" style="--c:var(--msg)"><i></i><span class="full">Mensajes ✓✓</span><span class="short">✓✓</span></button>
        <button class="chip" data-node="reminders" style="--c:var(--rec)"><i></i><span class="full">Recordatorios</span><span class="short">REC</span></button>
        <button class="chip" data-node="alerts" style="--c:var(--alt)"><i></i><span class="full">Reconexión &amp; alertas</span><span class="short">ALT</span></button>
      </div>

      <div class="ticker rv-left" aria-hidden="true">
        <b>Actividad en vivo · Baileys</b>
        <span class="tick-line"><i id="tickerDot"></i><span id="tickerText">Baileys: conexión directa por WebSocket</span></span>
      </div>
      <p class="drag-hint rv-left">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 11.5V5.5a1.5 1.5 0 0 1 3 0v5m0-2a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v4c0 3.5-2.5 6-6 6s-5-1.5-6.5-4L4 12.5a1.4 1.4 0 0 1 2.4-1.4L9 14"/></svg>
        Arrastrá para orbitar · clic en un módulo = giro 360° del formulario
      </p>
    </section>

    <section class="card" id="card">
      <div class="face front" id="faceFront">
        <span class="status-pill" id="pill"><i id="pillDot"></i><span id="pillTxt">Acceso seguro</span></span>

        <div id="formPanel">
          <svg class="logo card-in"><use href="#esam-logo"/></svg>
          <h2 class="card-in">Bienvenido a ESAM SEGUIMIENTO</h2>

          <div class="ctx card-in" id="ctx">
            <div class="ctx-default" id="ctxDefault">
              <p class="sub">Panel de seguimiento · Iniciá sesión para continuar</p>
              <span class="bay-badge">
                <svg viewBox="0 0 24 24" fill="#00E5A0"><path d="M13.6 2 5 13.4h5.2L9.4 22 19 10.2h-5.4z"/></svg>
                Baileys · Multidispositivo · sin costo por contacto
              </span>
              <span class="ctx-hint"><b>✦</b><span id="hintTxt">Pasá el cursor o hacé clic en un módulo</span></span>
            </div>
            <div class="ctx-module" id="ctxModule">
              <div class="ctx-top">
                <img id="ctxIco" alt="">
                <div><b id="ctxName"></b><span class="ctx-desc" id="ctxDesc"></span></div>
              </div>
              <div class="ctx-stats"><span id="ctxS1"></span><span id="ctxS2"></span></div>
            </div>
          </div>

          <form id="loginForm" method="post" action="/login" novalidate>
            ${errorBlock}
            <div class="field card-in" id="emailField">
              <div class="lab-row"><label for="email">Usuario o correo <b>*</b></label></div>
              <div class="inp">
                <svg class="lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
                <input type="text" id="email" name="login" placeholder="Ingresá tu usuario o correo" autocomplete="username" required autofocus />
              </div>
              <p class="err">Ingresá tu usuario o correo.</p>
            </div>

            <div class="field card-in" id="passField">
              <div class="lab-row">
                <label for="pass">Contraseña <b>*</b></label>
              </div>
              <div class="inp">
                <svg class="lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                <input type="password" id="pass" name="password" placeholder="Tu contraseña" autocomplete="current-password" required />
                <button type="button" class="eye" id="eyeBtn" aria-label="Mostrar contraseña" aria-pressed="false">
                  <svg id="eyeOn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg id="eyeOff" class="hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.5 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3 3.9M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>
                </button>
              </div>
              <p id="capsHint">⇪ Bloq Mayús activado</p>
              <p class="err">Ingresá tu contraseña.</p>
            </div>

            <button type="submit" class="btn card-in" id="submitBtn">
              <span class="spin"></span><span id="btnLabel">Iniciar sesión</span>
            </button>

            <p class="secure card-in">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5.5v5.6c0 5 3.4 8.6 8 10.9 4.6-2.3 8-5.9 8-10.9V5.5Z"/><path d="m9 11.5 2.2 2.2L15.5 9"/></svg>
              <span><b>ESAM</b> Centralizando toda la información.</span>
            </p>
            <p class="alt card-in">¿Problemas para ingresar? <a href="mailto:soporte@esam.edu.bo">Contactá a soporte</a></p>
          </form>
        </div>
      </div>

      <div class="face back" id="faceBack" aria-hidden="true">
        <div class="back-in">
          <img class="back-ico" id="backIco" alt="">
          <b id="backName">Módulo</b>
          <span id="backDesc"></span>
          <span class="back-tag">Sesión multidispositivo · Baileys</span>
        </div>
      </div>
    </section>
  </main>

  <footer class="rv-foot">© ${year} ESAM SEGUIMIENTO · Derechos reservados</footer>
</div>

<div id="tip" role="tooltip"><span class="t"><i id="tipDot"></i><span id="tipTitle"></span></span><span class="d" id="tipDesc"></span></div>
<div id="toast" role="status"></div>

<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
}}
</script>
<script type="module" src="/assets/js/login-esam.js?v=${LOGIN_VERSION}"></script>
</body>
</html>`;
}
