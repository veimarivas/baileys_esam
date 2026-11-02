import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { all, get, run } from '../src/db/index.js';
import { createTemplate, seedDefaultTemplates } from '../src/core/templates.js';

describe('plantillas por defecto', () => {
  it('crea Cobranza y Académico con una estructura amigable e iconos', () => {
    run('DELETE FROM templates');
    seedDefaultTemplates();

    const rows = all<{ category: string; body: string }>('SELECT category, body FROM templates ORDER BY category');
    assert.equal(rows.length, 2);

    const cobranza = rows.find((r) => r.category === 'cobranza');
    assert.ok(cobranza);
    assert.match(cobranza.body, /👋/);
    assert.match(cobranza.body, /📋 \*Detalle de cuotas\*/);
    assert.match(cobranza.body, /\{\{ detalle_cuotas \}\}/);
    assert.match(cobranza.body, /💰 \*Total adeudado/);
    assert.match(cobranza.body, /🙏 \{\{ cierre \}\}/);

    const academico = rows.find((r) => r.category === 'academico');
    assert.ok(academico);
    assert.match(academico.body, /🎓/);
    assert.match(academico.body, /📊 \*Nota final: \{\{ nota \}\}\*/);
    assert.match(academico.body, /📌 \*Estado: \{\{ estado \}\}\*/);
    assert.match(academico.body, /\{\{ nivelacion \}\}/);
  });

  it('no pisa una plantilla que el equipo editó', () => {
    run('DELETE FROM templates');
    const id = createTemplate('Cobranza', 'cobranza', 'Texto personalizado del equipo');
    seedDefaultTemplates();
    assert.equal(get<{ body: string }>('SELECT body FROM templates WHERE id = ?', id)?.body, 'Texto personalizado del equipo');
  });
});
