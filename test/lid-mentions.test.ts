import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMentions } from '../src/core/conversations.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * WhatsApp manda las menciones de grupo como LID (`@196...`). El panel debe
 * mostrar el teléfono real cuando `lid_map` ya conoce la relación.
 */
describe('menciones de grupo con LID', () => {
  it('resuelve el LID al teléfono corporativo', () => {
    run(
      'INSERT OR REPLACE INTO lid_map (lid, pn, updated_at) VALUES (?, ?, ?)',
      '196289048395913@lid',
      '59171865104@s.whatsapp.net',
      nowIso(),
    );
    assert.equal(
      formatMentions('@196289048395913 ING BUENAS TARDES'),
      '@59171865104 ING BUENAS TARDES',
    );
  });

  it('deja intacto el texto sin menciones y los LID sin mapeo', () => {
    assert.equal(formatMentions('mensaje normal'), 'mensaje normal');
    assert.equal(formatMentions('@999999999999999 hola'), '@999999999999999 hola');
    assert.equal(formatMentions(null), null);
  });
});
