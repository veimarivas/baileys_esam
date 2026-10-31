import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { batchEngagement, classifyReply, summarizeEngagement } from '../src/core/batch-engagement.js';
import { createReplyFollowups } from '../src/core/reply-followup.js';
import { massActivity } from '../src/core/mass-activity.js';
import { upsertUser } from '../src/auth/users.js';
import { all, get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Respuestas y acuses de los envíos masivos: quién recibió, leyó y respondió,
 * y las tareas para Contabilidad cuando contestan una cobranza.
 */
const T0 = Date.now() - 6 * 3600_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

run(
  `INSERT INTO sessions (id, name, owner_uid, owner_name, status, created_at, updated_at) VALUES ('be-line', 'Contable', NULL, NULL, 'ready', ?, ?)`,
  nowIso(), nowIso(),
);
upsertUser({ sourceUid: 'be-77', name: 'Carla Contable', username: 'be-carla', email: 'be-carla@t.local', source: 'cronogramas', autorizado: true, roles: [] });
const carla = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'be-77'")!.id;

function batch(tipo: string, created: string): number {
  return Number(run(
    `INSERT INTO batches (session_id, name, total, sent, failed, skipped, status, meta, created_at, updated_at) VALUES ('be-line', ?, 0, 0, 0, 0, 'done', ?, ?, ?)`,
    `Cuotas ${tipo}`, JSON.stringify({ tipo, solicitado_por_id: 'be-77', solicitado_por: 'Carla Contable', programa: 'Diplomado X' }), created, created,
  ).lastInsertRowid);
}
function item(batchId: number, phone: string, sentMin: number | null, ack = 'sent'): number {
  const chat = `${phone}@c.us`;
  const wa = sentMin === null ? null : `BE-${batchId}-${phone}`;
  const id = Number(run(
    `INSERT INTO batch_items (batch_id, chat_id, contact_name, body, status, message_id, created_at, updated_at) VALUES (?, ?, ?, 'Su cuota vence', ?, ?, ?, ?)`,
    batchId, chat, `Persona ${phone}`, sentMin === null ? 'failed' : 'sent', wa, at(0), sentMin === null ? at(0) : at(sentMin),
  ).lastInsertRowid);
  if (wa) {
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, body, wa_message_id, status, origin, occurred_at, created_at)
       VALUES ('be-line', ?, 'out', 'text', 'Su cuota vence', ?, ?, 'batch', ?, ?)`,
      chat, wa, ack, at(sentMin!), at(sentMin!),
    );
    run('UPDATE batches SET total = total + 1, sent = sent + 1 WHERE id = ?', batchId);
  } else {
    run('UPDATE batches SET total = total + 1, failed = failed + 1 WHERE id = ?', batchId);
  }
  return id;
}
function inbound(phone: string, min: number, body: string | null, type = 'text'): void {
  run(
    `INSERT INTO messages (session_id, chat_id, direction, content_type, body, status, occurred_at, created_at) VALUES ('be-line', ?, 'in', ?, ?, 'received', ?, ?)`,
    `${phone}@c.us`, type, body, at(min), at(min),
  );
}

describe('clasificación de respuestas a cobranzas', () => {
  it('reconoce pago, comprobante, plazo, consulta y baja', () => {
    assert.equal(classifyReply('Ya pagué ayer licenciada'), 'pagado');
    assert.equal(classifyReply('Buenas, realicé el pago por QR'), 'pagado');
    assert.equal(classifyReply(null, 'image'), 'comprobante');
    assert.equal(classifyReply('No puedo pagar este mes, pago a fin de mes'), 'no_puede');
    assert.equal(classifyReply('¿A qué cuenta deposito?'), 'consulta');
    assert.equal(classifyReply('Por favor no me escriban más'), 'baja');
    assert.equal(classifyReply('Gracias'), 'otro');
  });
});

describe('acuses y respuestas de un lote', () => {
  const b1 = batch('cuotas', at(0));
  const ana = item(b1, '59170000001', 1, 'read');
  const beto = item(b1, '59170000002', 2, 'delivered');
  const ciro = item(b1, '59170000003', 3, 'sent');
  const dani = item(b1, '59170000004', 4, 'read');
  const falla = item(b1, '59170000005', null);
  inbound('59170000001', 11, 'Ya pagué, gracias');
  inbound('59170000001', 20, 'Les mando el comprobante luego'); // segunda respuesta: no cuenta
  inbound('59170000002', 40, null, 'image');
  inbound('59170000003', 3 * 60, 'No puedo pagar hasta la próxima semana');
  // Otra cobranza a Dani antes de que responda: la respuesta es del segundo lote.
  const b2 = batch('cuotas', at(60));
  const dani2 = item(b2, '59170000004', 61, 'read');
  inbound('59170000004', 90, 'Ya deposité');

  it('acuse, primera respuesta y clasificación por destinatario', () => {
    const e = batchEngagement(b1);
    assert.equal(e.get(ana)!.ack, 'read');
    assert.equal(e.get(ana)!.reply!.kind, 'pagado');
    assert.equal(e.get(ana)!.reply!.minutes, 10);
    assert.equal(e.get(beto)!.reply!.kind, 'comprobante');
    assert.equal(e.get(ciro)!.reply!.kind, 'no_puede');
    assert.equal(e.get(dani)!.reply, null, 'la respuesta llegó después del siguiente envío');
    assert.equal(e.get(falla)!.ack, 'failed');
    assert.equal(batchEngagement(b2).get(dani2)!.reply!.kind, 'pagado');
  });

  it('resumen: quien responde cuenta como leído aunque falte el acuse', () => {
    const s = summarizeEngagement(batchEngagement(b1).values());
    assert.equal(s.sent, 4);
    assert.equal(s.replied, 3);
    assert.equal(s.read, 4); // Ana y Dani leídos + Beto y Ciro respondieron
    assert.equal(s.delivered, 4);
    assert.equal(s.replyRate, 75);
    assert.deepEqual([s.kinds.pagado, s.kinds.comprobante, s.kinds.no_puede], [1, 1, 1]);
  });

  it('sin mensaje guardado: «sin acuse», fuera del porcentaje de lectura', () => {
    const b4 = batch('notas', at(-3000));
    const conAcuse = item(b4, '59170000011', -3000, 'read');
    const sinAcuse = item(b4, '59170000012', -3000);
    run("DELETE FROM messages WHERE wa_message_id = ?", `BE-${b4}-59170000012`);
    const e = batchEngagement(b4);
    assert.equal(e.get(sinAcuse)!.ack, 'unknown');
    const s = summarizeEngagement(e.values());
    assert.equal(s.sent, 2);
    assert.equal(s.tracked, 1);
    assert.equal(s.readRate, 100);
    assert.equal(e.get(conAcuse)!.ack, 'read');
  });

  it('una respuesta fuera de las 48 h no cuenta', () => {
    const b3 = batch('notas', at(-4000));
    const x = item(b3, '59170000009', -4000, 'read');
    inbound('59170000009', -4000 + 49 * 60, 'Hola');
    assert.equal(batchEngagement(b3).get(x)!.reply, null);
  });

  it('tareas para quien pidió la cobranza, una por respuesta', () => {
    const created = createReplyFollowups();
    assert.equal(created, 4); // Ana (pagó), Beto (comprobante), Ciro (no puede), Dani en el lote 2
    const notes = all<{ note_text: string; assigned_to: number; due_at: string | null }>(
      `SELECT note_text, assigned_to, due_at FROM contact_notes WHERE source_message_id IS NOT NULL ORDER BY id`,
    );
    assert.equal(notes.length, 4);
    assert.ok(notes.every((n) => n.assigned_to === carla && n.due_at));
    assert.match(notes[0].note_text, /Dice que ya pagó/);
    assert.match(notes[0].note_text, /Lote #\d+ · Cuotas cuotas · Diplomado X/);
    const avisos = get<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications WHERE kind = 'batch_reply' AND user_id = ?`, carla)!.c;
    assert.equal(avisos, 4);
    assert.equal(createReplyFollowups(), 0, 'no se duplican');
  });

  it('Reportes › Envíos masivos suma lectura y respuestas por persona y por tipo', () => {
    const a = massActivity(['be-line'], { fromIso: at(-10), toIso: new Date(Date.now() + 3600_000).toISOString() });
    const carlaRow = a.requesters.find((r) => r.key === 'u:be-77')!;
    assert.equal(carlaRow.replied, 4);
    const cuotas = a.byTipo.find((t) => t.tipo === 'cuotas')!;
    assert.equal(cuotas.sent, 5);
    assert.equal(cuotas.replied, 4);
    assert.equal(a.totals.replied, 4);
  });
});
