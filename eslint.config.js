import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint del proyecto.
 *
 * - `src/` y `test/`: TypeScript con las reglas recomendadas de typescript-eslint.
 * - `public/`: scripts clásicos del panel (no son módulos) que corren en el navegador.
 * - `scripts/`: utilidades de operación en CommonJS.
 *
 * No se aplica formato (Prettier) a propósito: `public/app.js` y `app.css` son
 * archivos grandes y reformatearlos generaría un diff imposible de revisar.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/assets/**', // plantilla Velzon / librerías de terceros
      'public/vendor/**',
      'data/**',
      'storage/**',
      'coverage/**',
    ],
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Librerías cargadas por <script> en layout.ts (no son módulos).
        bootstrap: 'readonly',
        Chart: 'readonly',
        ApexCharts: 'readonly',
        FilePond: 'readonly',
        Swal: 'readonly',
        Shepherd: 'readonly',
        Swiper: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // En este código hay muchos `try { ... } catch (_) {}` y callbacks que no
      // usan el evento a propósito: no son errores, es el estilo del archivo.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.cjs', 'ecosystem.config.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // El proyecto es ESM (`"type": "module"`), este archivo incluido.
    files: ['eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // El código ya usa `any` en bordes con Baileys/SQLite; tsc es el que cuida los tipos.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' },
      ],
    },
  },
);
