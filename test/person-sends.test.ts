import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySend, personSends } from '../src/core/person-sends.js';
import { upsertUser } from '../src/auth/users.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Ficha del contacto › Envíos: cobranzas, notas, asistencias y avisos del
 * programa que le llegaron a una persona, con quién los pidió y el acuse.
 */
run(
  `INSERT INTO sessions (id, name, owner_uid, owner_name, phone, status, created_at, updated_at) VALUES ('ps-1', 'Línea contable', 'ps-c', 'Carla', '59170001111', 'ready', ?, ?)`,
  nowIso(), nowIso(),
);
upsertUser({ sourceUid: 'ps-r', name: 'Rosa Responsable', username: 'ps-r', email: 'ps-r@test.local', source: 'cronogramas', autorizado: true, roles: [] });

let seq = 0;
function send(meta: Record<string, unknown>, status: string, opts: { chat?: string; at?: string; wa?: string; error?: string } = {}) {
  seq++;
  const at = opts.at ?? new Date(Date.now() - seq * 60_000).toISOString();
  const b = run(
    `INSERT INTO batches (session_id, name, total, sent, failed, skipped, status, meta, created_at, updated_at) VALUES ('ps-1', ?, 1, 0, 0, 0, 'done', ?, ?, ?)`,
    `Lote ${seq}`, JSON.stringify(meta), at, at,
  );
  run(
    `INSERT INTO batch_items (batch_id, chat_id, contact_name, body, content_type, status, error, message_id, created_at, updated_at)
     VALUES (?, ?, 'Pedro', ?, 'text', ?, ?, ?, ?, ?)`,
    b.lastInsertRowid, opts.chat ?? '59171230000@c.us', `Mensaje ${seq}`, status, opts.error ?? null, opts.wa ?? null, at, at,
  );
}

send({ tipo: 'cobranza', modo: 'vencidas', programa: 'Diplomado X', solicitado_por: 'Carla Contable' }, 'sent', { wa: 'WA-1' });
send({ tipo: 'notas', programa: 'Diplomado X', modulo: 'Módulo 2', account: 'ps-r' }, 'sent');
send({ tipo: 'asistencia', programa: 'Diplomado X', modulo: 'Módulo 2', sesion: '20/10/2026 · 19:00 - 22:00', solicitado_por: 'Rosa Responsable' }, 'failed', { error: 'No tiene WhatsApp' });
send({ tipo: 'cobranza', origen: 'recordatorio_automatico' }, 'sent');
send({ tipo: 'participantes', area: 'academico', programa: 'Diplomado X' }, 'pending');
send({ tipo: 'notas' }, 'sent', { chat: '59179999999@c.us' }); // otra persona
// Acuse de lectura del primer envío.
run(
  `INSERT INTO messages (session_id, chat_id, direction, content_type, body, wa_message_id, status, occurred_at, created_at)
   VALUES ('ps-1', '59171230000@c.us', 'out', 'text', 'Mensaje 1', 'WA-1', 'read', ?, ?)`,
  nowIso(), nowIso(),
);

describe('envíos del sistema a una persona', () => {
  const r = personSends('59171230000');

  it('trae solo los envíos de esa persona, del más nuevo al más viejo', () => {
    assert.equal(r.items.length, 5);
    assert.equal(r.items[0].title, 'Cuotas vencidas');
  });

  it('clasifica por categoría y área', () => {
    assert.deepEqual(r.byCategory, { cobranza: 2, notas: 1, asistencia: 1, programa: 1, marketing: 0, otros: 0 });
    const conta = r.areas.find((a) => a.area === 'contabilidad')!;
    const acad = r.areas.find((a) => a.area === 'academico')!;
    assert.equal(conta.total, 2);
    assert.equal(acad.total, 3);
    assert.equal(acad.failed, 1);
    assert.equal(conta.lastSender, 'Carla Contable');
  });

  it('identifica quién envió y el acuse de WhatsApp', () => {
    const cobro = r.items.find((i) => i.title === 'Cuotas vencidas')!;
    assert.equal(cobro.ack, 'read');
    assert.equal(cobro.linePhone, '59170001111');
    const notas = r.items.find((i) => i.category === 'notas')!;
    assert.equal(notas.sender, 'Rosa Responsable'); // por la cuenta (account)
    assert.equal(notas.modulo, 'Módulo 2');
    const auto = r.items.find((i) => i.automatic)!;
    assert.equal(auto.sender, 'Envío automático');
    assert.equal(auto.title, 'Recordatorio automático de cuotas');
    const asist = r.items.find((i) => i.category === 'asistencia')!;
    assert.equal(asist.status, 'failed');
    assert.equal(asist.error, 'No tiene WhatsApp');
    assert.match(asist.detail ?? '', /Sesión 20\/10\/2026/);
  });

  it('sin número no busca nada', () => {
    assert.equal(personSends(null).items.length, 0);
  });

  it('clasifica los tipos de cronogramas', () => {
    assert.equal(classifySend({ tipo: 'cobranza', modo: 'proximas' }).title, 'Cuotas próximas a vencer');
    assert.equal(classifySend({ tipo: 'prospectos' }).area, 'marketing');
    assert.equal(classifySend({ tipo: 'participantes', area: 'contabilidad' }).area, 'contabilidad');
    assert.equal(classifySend({}).category, 'otros');
  });
});
