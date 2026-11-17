import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listMessages } from '../src/core/conversations.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Los mensajes borrados en WhatsApp se conservan, pero marcados. */
describe('mensajes eliminados en WhatsApp', () => {
  it('conserva el contenido y devuelve la marca de revocado', () => {
    const now = nowIso();
    run(
      `INSERT INTO messages
        (session_id, chat_id, direction, content_type, body, status, occurred_at, created_at, wa_message_id, revoked_at, revoked_scope)
       VALUES (?, ?, 'in', 'text', ?, 'delivered', ?, ?, ?, ?, 'revoke')`,
      's-revoked',
      '120363000000000001@g.us',
      'mensaje que se borró en WhatsApp',
      now,
      now,
      'wamid-revoked-test',
      now,
    );

    const page = listMessages('s-revoked', '120363000000000001@g.us', { limit: 10 });
    const msg = page.messages.find((m) => m.wa_message_id === 'wamid-revoked-test');
    assert.ok(msg);
    assert.equal(msg?.body, 'mensaje que se borró en WhatsApp');
    assert.equal(msg?.revoked_at, now);
    assert.equal(msg?.revoked_scope, 'revoke');
  });
});
