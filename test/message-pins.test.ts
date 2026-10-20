import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listPinned,
  MAX_PINNED_MESSAGES,
  setMessagePinned,
} from '../src/core/conversations.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * El fijado es interno del panel: hasta tres avisos por conversación, sin tocar
 * el estado del mensaje en WhatsApp. Estas pruebas fijan el límite y el alcance
 * por chat/línea.
 */

function insertMessage(chatId: string, body: string, sessionId = 'ses-pin'): number {
  const now = nowIso();
  return run(
    `INSERT INTO messages (session_id, chat_id, direction, content_type, body, occurred_at, created_at)
     VALUES (?, ?, 'in', 'text', ?, ?, ?)`,
    sessionId,
    chatId,
    body,
    now,
    now,
  ).lastInsertRowid;
}

describe('mensajes fijados', () => {
  it('permite hasta tres por conversación y desfija', () => {
    const chat = '59170000001@c.us';
    const ids = [1, 2, 3, 4].map((n) => insertMessage(chat, `Mensaje ${n}`));

    for (const id of ids.slice(0, MAX_PINNED_MESSAGES)) {
      assert.deepEqual(setMessagePinned('ses-pin', chat, id, true, 1), { ok: true });
    }
    const fourth = setMessagePinned('ses-pin', chat, ids[3], true, 1);
    assert.equal(fourth.ok, false);
    assert.match(fourth.ok ? '' : fourth.error, /3 mensajes/);

    const pinned = listPinned('ses-pin', chat);
    assert.equal(pinned.length, MAX_PINNED_MESSAGES);
    assert.deepEqual(new Set(pinned.map((message) => message.id)), new Set(ids.slice(0, 3)));

    assert.deepEqual(setMessagePinned('ses-pin', chat, ids[1], false, 1), { ok: true });
    assert.equal(listPinned('ses-pin', chat).length, 2);
    assert.deepEqual(setMessagePinned('ses-pin', chat, ids[3], true, 1), { ok: true });
    assert.equal(listPinned('ses-pin', chat).length, 3);
  });

  it('no fija mensajes de otro chat ni de otra línea', () => {
    const chat = '59170000002@c.us';
    const otherChat = '59170000003@c.us';
    const id = insertMessage(chat, 'Solo en este chat');

    assert.equal(setMessagePinned('ses-pin', otherChat, id, true, 1).ok, false);
    assert.equal(setMessagePinned('otra-sesion', chat, id, true, 1).ok, false);
    assert.deepEqual(setMessagePinned('ses-pin', chat, id, true, 1), { ok: true });
  });

  it('desfijar un mensaje inexistente no rompe el panel', () => {
    const result = setMessagePinned('ses-pin', '59170000004@c.us', 999999, false, 1);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /no encontrado/i);
  });
});
