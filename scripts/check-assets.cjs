/**
 * npm run check:assets — verifica que estén los archivos de la plantilla Velzon
 * que usa el panel. Velzon tiene licencia comercial y no se incluye en el
 * repositorio: hay que copiar su carpeta `assets` a `public/assets`
 * (ver IMPLEMENTACION.md §3).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'public', 'assets');

const REQUIRED = [
  // Velzon (licencia comercial)
  'css/bootstrap.min.css',
  'css/icons.min.css',
  'css/app.min.css',
  'css/custom.min.css',
  'js/layout.js',
  'js/plugins.js',
  'js/app.js',
  'libs/bootstrap/js/bootstrap.bundle.min.js',
  'libs/simplebar/simplebar.min.js',
  'libs/node-waves/waves.min.js',
  'libs/feather-icons/feather.min.js',
  'libs/apexcharts/apexcharts.min.js',
  'images/favicon.ico',
  // Incluidos en el repositorio
  'fonts/inter-latin-wght-normal.woff2',
  'fonts/inter-latin-ext-wght-normal.woff2',
  'libs/opus-recorder/recorder.min.js',
  'libs/opus-recorder/encoderWorker.min.js',
];

// Fuentes de iconos que referencia icons.min.css (Remix, Boxicons, Line Awesome, MDI).
const ICON_FONTS = [/^remixicon.*\.woff2$/, /^boxicons.*\.woff2$/, /^la-solid-900.*\.woff2$/, /^materialdesignicons.*\.woff2$/];

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(root, f)));
let fonts = [];
try {
  fonts = fs.readdirSync(path.join(root, 'fonts'));
} catch {
  fonts = [];
}
const missingFonts = ICON_FONTS.filter((re) => !fonts.some((f) => re.test(f))).map((re) => `fonts/${re.source}`);

if (!missing.length && !missingFonts.length) {
  console.log('[check:assets] OK: están todos los recursos del panel.');
  process.exit(0);
}
console.error('[check:assets] Faltan recursos en public/assets:');
for (const f of [...missing, ...missingFonts]) console.error('  - ' + f);
console.error('Copiá la carpeta "assets" de la versión HTML de Velzon en public/assets (ver IMPLEMENTACION.md §3).');
process.exit(1);
