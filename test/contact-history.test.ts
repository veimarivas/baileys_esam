import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addNote, contactHistory, upsertContact } from '../src/core/contacts.js';
import { createBoard, listBoards, moveNote } from '../src/core/agenda.js';
import { setPersonCi } from '../src/core/person.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Historial del contacto: notas de todas las líneas + agenda, por usuario. */

function seedUser(name: string, username: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO users (name, username, password, source, esam_autorizado, created_at, updated_at)
     VALUES (?, ?, 'x', 'local', 1, ?, ?)`,
    name,
    username,
    now,
    now,
  ).lastInsertRowid;
}

function seedContact(session: string, phone: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO contacts (session_id, chat_id, phone, name, created_at, updated_at)
     VALUES (?, ?, ?, 'Persona historial', ?, ?)`,
    session,
    `${phone}@c.us`,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('historial consolidado del contacto', () => {
  const user1 = seedUser('Agente Uno', 'agente.uno');
  const user2 = seedUser('Agente Dos', 'agente.dos');
  const phone = '59170000444';
  const contactA = seedContact('s-hist-a', phone);
  const contactB = seedContact('s-hist-b', phone);
  const board = createBoard(user1, 'Trámites', ['Solicitado', 'En revisión', 'Entregado']);
  const stages = listBoards(user1).find((b) => b.id === board)!.stages;

  const team1 = addNote(contactA, user1, 'Nota de equipo desde la línea A.', null, null, [], false);
  addNote(contactB, user2, 'Nota de equipo desde la línea B.', null, null, [], false);
  const personal1 = addNote(contactA, user1, 'Nota privada del agente uno.', null, null, [], false, {
    personal: true,
    agendaBoardId: board,
    agendaStageId: stages[0].id,
  });
  addNote(contactA, user2, 'Nota privada del agente dos.', null, null, [], false, { personal: true });

  moveNote(user1, personal1.id, board, stages[1].id, 'Se recibió la documentación.');
  setPersonCi(phone, '44444444 HIST', user1);

  it('incluye notas de todas las líneas y la agenda del usuario', () => {
    const h = contactHistory(contactA, user1)!;
    const texts = h.entries.map((e) => e.note_text || '');
    assert.ok(texts.some((t) => t.includes('línea A')));
    assert.ok(texts.some((t) => t.includes('línea B')));
    assert.ok(texts.some((t) => t.includes('agente uno')));
    assert.ok(!texts.some((t) => t.includes('agente dos')));
    assert.equal(h.contact.ci, '44444444 HIST');
    assert.equal(h.contact.phone, phone);
  });

  it('muestra la columna inicial y los movimientos de agenda con su detalle', () => {
    const h = contactHistory(contactA, user1)!;
    const created = h.entries.find((e) => e.action === 'created' && e.note_id === personal1.id);
    assert.equal(created?.stage?.to, 'Solicitado');
    const move = h.entries.find((e) => e.action === 'stage' && e.stage);
    assert.equal(move?.stage?.from, 'Solicitado');
    assert.equal(move?.stage?.to, 'En revisión');
    assert.equal(move?.stage?.comment, 'Se recibió la documentación.');
  });

  it('agrupa los registros por usuario', () => {
    const h = contactHistory(contactA, user1)!;
    const uno = h.users.find((u) => u.id === user1);
    const dos = h.users.find((u) => u.id === user2);
    assert.ok(uno && uno.count > 0);
    assert.ok(dos && dos.count > 0);
    assert.ok(uno!.count > dos!.count);
  });

  it('cada usuario ve su propia agenda y las notas de equipo, no la ajena', () => {
    const h = contactHistory(contactA, user2)!;
    const texts = h.entries.map((e) => e.note_text || '');
    assert.ok(texts.some((t) => t.includes('agente dos')));
    assert.ok(!texts.some((t) => t.includes('agente uno')));
  });

  it('incluye la nota de equipo sin historial de agenda', () => {
    const h = contactHistory(contactA, user1)!;
    const created = h.entries.find((e) => e.action === 'created' && e.note_id === team1.id);
    assert.ok(created);
    assert.equal(created?.stage, null);
  });

  it('incluye email y empresa del contacto para completar la ficha', () => {
    upsertContact('s-hist-a', `${phone}@c.us`, { email: 'persona@example.com', company: 'ESAM' });
    const h = contactHistory(contactA, user1)!;
    assert.equal(h.contact.email, 'persona@example.com');
    assert.equal(h.contact.company, 'ESAM');
  });
});
