import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conversationPreview, MAX_PREVIEW_MESSAGES } from '../src/core/conversations.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Vista previa de la lista: con mensajes sin leer devuelve los últimos de la
 * persona (los que cuentan en `unread_count`); si ya está leída, el último
 * mensaje del chat.
 */

const SESSION = 'pv-line';
const CHAT = '59170008880@c.us';

function addConversation(unread: number): void {
  const now = nowIso();
  run(
    `INSERT INTO conversations (session_id, chat_id, contact_name, unread_count, created_at, updated_at)
     VALUES (?, ?, 'Vista previa', ?, ?, ?)`,
    SESSION,
    CHAT,
    unread,
    now,
    now,
  );
}

function addMessage(direction: 'in' | 'out', body: string, minute: number): number {
  const at = `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return run(
    `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at)
     VALUES (?, ?, ?, 'text', ?, ?, ?)`,
    SESSION,
    CHAT,
    direction,
    body,
    at,
    at,
  ).lastInsertRowid;
}

describe('vista previa de la conversación', () => {
  it('con mensajes sin leer devuelve solo esos mensajes, del más viejo al más nuevo', () => {
    addConversation(2);
    addMessage('in', 'Mensaje leído', 1);
    addMessage('out', 'Respuesta del equipo', 2);
    addMessage('in', 'Pendiente 1', 3);
    addMessage('in', 'Pendiente 2', 4);

    const preview = conversationPreview(SESSION, CHAT);
    assert.equal(preview.mode, 'unread');
    assert.equal(preview.unread_count, 2);
    assert.equal(preview.has_more, false);
    assert.deepEqual(preview.messages.map((m) => m.body), ['Pendiente 1', 'Pendiente 2']);
    assert.ok(preview.messages.every((m) => m.direction === 'in'));
  });

  it('sin mensajes sin leer devuelve el último mensaje del chat', () => {
    const chat = '59170008881@c.us';
    const now = nowIso();
    run(
      `INSERT INTO conversations (session_id, chat_id, contact_name, unread_count, created_at, updated_at)
       VALUES (?, ?, 'Al día', 0, ?, ?)`,
      SESSION,
      chat,
      now,
      now,
    );
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at)
       VALUES (?, ?, 'out', 'text', 'Último enviado', ?, ?)`,
      SESSION,
      chat,
      '2026-01-01T11:00:00.000Z',
      '2026-01-01T11:00:00.000Z',
    );

    const preview = conversationPreview(SESSION, chat);
    assert.equal(preview.mode, 'last');
    assert.equal(preview.unread_count, 0);
    assert.deepEqual(preview.messages.map((m) => m.body), ['Último enviado']);
  });

  it('recorta la lista y avisa cuando hay más sin leer', () => {
    const chat = '59170008882@c.us';
    const now = nowIso();
    const total = MAX_PREVIEW_MESSAGES + 3;
    run(
      `INSERT INTO conversations (session_id, chat_id, contact_name, unread_count, created_at, updated_at)
       VALUES (?, ?, 'Muchos', ?, ?, ?)`,
      SESSION,
      chat,
      total,
      now,
      now,
    );
    for (let i = 0; i < total; i += 1) {
      run(
        `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at)
         VALUES (?, ?, 'in', 'text', ?, ?, ?)`,
        SESSION,
        chat,
        `Pendiente ${i}`,
        `2026-01-01T12:${String(i).padStart(2, '0')}:00.000Z`,
        `2026-01-01T12:${String(i).padStart(2, '0')}:00.000Z`,
      );
    }

    const preview = conversationPreview(SESSION, chat);
    assert.equal(preview.mode, 'unread');
    assert.equal(preview.messages.length, MAX_PREVIEW_MESSAGES);
    assert.equal(preview.has_more, true);
    assert.equal(preview.messages[preview.messages.length - 1].body, `Pendiente ${total - 1}`);
  });
});
