import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDigest, digestText, sendDailyDigests } from '../src/core/daily-digest.js';
import { listUsers, upsertUser } from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Resumen diario: lo de ayer y lo que espera hoy, para el admin y para cada línea. */
const y = new Date();
y.setDate(y.getDate() - 1);
y.setHours(10, 0, 0, 0);
const ayer = y.toISOString();

upsertUser({ sourceUid: 'dg-sa', name: 'Super', username: 'dg-sa', email: 'dg-sa@t.local', source: 'cronogramas', autorizado: true, roles: ['Super Admin'] });
upsertUser({ sourceUid: 'dg-ana', name: 'Ana', username: 'dg-ana', email: 'dg-ana@t.local', source: 'cronogramas', autorizado: true, roles: [], numero: '59170004444' });
const sa = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'dg-sa'")!.id;
const ana = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'dg-ana'")!.id;
run("INSERT INTO sessions (id, name, expected_phone, status, created_at, updated_at) VALUES ('dg-line', 'Línea Ana', '59170004444', 'ready', ?, ?)", nowIso(), nowIso());
const b = Number(run(
  "INSERT INTO batches (session_id, name, total, sent, failed, skipped, status, meta, created_at, updated_at) VALUES ('dg-line', 'Cuotas', 2, 2, 0, 0, 'done', ?, ?, ?)",
  JSON.stringify({ tipo: 'cuotas' }), ayer, ayer,
).lastInsertRowid);
for (const [i, phone] of ['59171110001', '59171110002'].entries()) {
  run("INSERT INTO batch_items (batch_id, chat_id, body, status, message_id, created_at, updated_at) VALUES (?, ?, 'Su cuota', 'sent', ?, ?, ?)", b, `${phone}@c.us`, `DG-${i}`, ayer, ayer);
  run("INSERT INTO messages (session_id, chat_id, direction, content_type, body, wa_message_id, status, origin, occurred_at, created_at) VALUES ('dg-line', ?, 'out', 'text', 'Su cuota', ?, 'read', 'batch', ?, ?)", `${phone}@c.us`, `DG-${i}`, ayer, ayer);
}
const later = new Date(y.getTime() + 20 * 60_000).toISOString();
run("INSERT INTO messages (session_id, chat_id, direction, content_type, body, status, occurred_at, created_at) VALUES ('dg-line', '59171110001@c.us', 'in', 'text', 'Ya pagué', 'received', ?, ?)", later, later);
run("INSERT INTO conversations (session_id, chat_id, last_direction, last_message_at, created_at, updated_at) VALUES ('dg-line', '59171110001@c.us', 'in', ?, ?, ?)", later, later, later);

describe('resumen diario', () => {
  it('junta envíos, lectura, respuestas a cobranzas y chats sin responder', () => {
    const d = buildDigest(['dg-line'], ana);
    assert.equal(d.batches, 1);
    assert.equal(d.sent, 2);
    assert.equal(d.readRate, 100);
    assert.equal(d.replied, 1);
    assert.equal(d.cobranza.pagado, 1);
    assert.equal(d.unanswered, 1);
    const text = digestText(d)!;
    assert.match(text, /Envíos de ayer: 1 lote/);
    assert.match(text, /1 dicen que pagaron/);
    assert.match(text, /1 chat\(s\) esperan respuesta/);
  });

  it('sin novedades no hay texto', () => {
    assert.equal(digestText({ day: '', batches: 0, sent: 0, readRate: null, replied: 0, cobranza: { pagado: 0, comprobante: 0, no_puede: 0 }, overdueNotes: 0, unanswered: 0, lines: [] }), null);
  });

  it('avisa al admin (todas las líneas) y a la usuaria de la línea', () => {
    sendDailyDigests(listUsers());
    const titles = (id: number) => get<{ title: string } | undefined>("SELECT title FROM notifications WHERE kind = 'daily_digest' AND user_id = ?", id)?.title;
    assert.equal(titles(sa), 'Resumen de ayer · todas las líneas');
    assert.equal(titles(ana), 'Resumen de ayer');
  });
});
