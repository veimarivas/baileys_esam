import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { registerAdminRoutes } from '../src/panel/admin-views.js';
import { upsertUser } from '../src/auth/users.js';
import { createTemplate, getTemplate } from '../src/core/templates.js';

const noGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => next();

function appFor(user: ReturnType<typeof upsertUser>) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    (req as express.Request & { user: typeof user }).user = user;
    next();
  });
  registerAdminRoutes(app, { requireUser: noGuard, requireSection: () => noGuard, sessions: () => [] });
  return app;
}

describe('edición de plantillas', () => {
  const user = upsertUser({ sourceUid: 'tpl-editor', name: 'Editor', email: 'editor@test.local', autorizado: true });

  it('abre el editor y guarda el nuevo texto', async () => {
    const id = createTemplate('Prueba editable', 'cobranza', 'Hola {{ nombre_completo }}, texto original.');
    const server = appFor(user).listen(0);
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      const page = await (await fetch(`${base}/templates/${id}`)).text();
      assert.match(page, /data-tpl-editor/);
      assert.match(page, /texto original/);
      assert.match(page, new RegExp(`action="/templates/${id}"`));

      const body = new URLSearchParams({
        name: 'Prueba editable',
        category: 'cobranza',
        body: 'Hola {{ nombre_completo }}, texto actualizado con 🎓.',
      });
      const saved = await fetch(`${base}/templates/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      assert.equal(saved.status, 302);
      assert.equal(saved.headers.get('location'), `/templates/${id}`);
      assert.equal(getTemplate(id)?.body, 'Hola {{ nombre_completo }}, texto actualizado con 🎓.');
      assert.deepEqual(JSON.parse(getTemplate(id)?.variables ?? '[]'), ['nombre_completo']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
