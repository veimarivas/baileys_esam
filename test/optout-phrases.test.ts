import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isOptoutRequest } from '../src/core/optout.js';

/**
 * El detector de bajas contra la tabla de verdad que comparte con el CRM.
 *
 * El CRM porta esta misma lógica a PHP y corre el MISMO archivo de casos. Si
 * alguien ajusta una expresión acá y no allá, el CRM seguiría mandando
 * publicidad a quien el gateway ya considera dado de baja — o al revés.
 */
describe('detector de bajas: contrato compartido con el CRM', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures', 'optout-phrases.json'), 'utf8')) as {
    cases: Array<{ text: string; optout: boolean }>;
  };

  for (const caso of fixture.cases) {
    it(`«${caso.text}» → ${caso.optout ? 'baja' : 'no es baja'}`, () => {
      assert.equal(isOptoutRequest(caso.text), caso.optout);
    });
  }
});
