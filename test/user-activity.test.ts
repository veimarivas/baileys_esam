import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attentionData, resolvePeriod, userPerformance, userReportDetail } from '../src/core/followup.js';
import { renderReportUser } from '../src/panel/followup-views.js';
import { lastUseByUser } from '../src/core/user-activity.js';
import { upsertUser } from '../src/auth/users.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * La columna «Última actividad» de Usuarios y la ficha del equipo deben usar
 * el último trabajo real (mensaje, lote o nota), no la última vez que se abrió
 * el panel. Estos casos fijan esa atribución.
 */

function usuario(sourceUid: string, username: string) {
  return upsertUser({
    sourceUid,
    name: `Persona ${sourceUid}`,
    username,
    email: `${username}@test.local`,
    source: 'cronogramas',
    autorizado: true,
    area: 'academico',
  });
}

function mensaje(uid: number, at: string): void {
  run(
    `INSERT INTO messages (session_id, chat_id, direction, content_type, origin, sender_uid, occurred_at, created_at)
     VALUES ('s-act', '59170000009@c.us', 'out', 'text', 'panel', ?, ?, ?)`,
    uid,
    at,
    at,
  );
}

function nota(uid: number, at: string): void {
  const now = nowIso();
  const contact = run(
    `INSERT INTO contacts (session_id, chat_id, phone, phone_key, created_at, updated_at)
     VALUES ('s-act', '59170000009@c.us', '59170000009', '59170000009', ?, ?)`,
    now,
    now,
  );
  run(
    `INSERT INTO contact_notes (contact_id, user_id, note_text, created_at) VALUES (?, ?, 'Llamar', ?)`,
    contact.lastInsertRowid,
    uid,
    at,
  );
}

function lote(sourceUid: string, at: string): void {
  const now = nowIso();
  const batch = run(
    `INSERT INTO batches (session_id, name, total, status, meta, started_at, created_at, updated_at)
     VALUES ('s-act', 'Lote de prueba', 1, 'done', ?, ?, ?, ?)`,
    JSON.stringify({ account: sourceUid }),
    at,
    now,
    at,
  );
  run(
    `INSERT INTO batch_items (batch_id, chat_id, status, updated_at, created_at)
     VALUES (?, '59170000009@c.us', 'sent', ?, ?)`,
    batch.lastInsertRowid,
    at,
    now,
  );
}

describe('última actividad por usuario', () => {
  it('toma el trabajo más reciente entre mensaje, nota y lote', () => {
    const user = usuario('act-1', 'ana-actividad');
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-act', 'Línea de prueba', 'act-1', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );
    mensaje(user.id, '2026-10-10T10:00:00.000Z');
    nota(user.id, '2026-10-10T11:00:00.000Z');
    lote('act-1', '2026-10-10T12:00:00.000Z');

    let use = lastUseByUser([user]).get(user.id);
    assert.equal(use?.kind, 'batch');
    assert.equal(use?.at, '2026-10-10T12:00:00.000Z');

    mensaje(user.id, '2026-10-10T13:00:00.000Z');
    use = lastUseByUser([user]).get(user.id);
    assert.equal(use?.kind, 'message');
    assert.equal(use?.at, '2026-10-10T13:00:00.000Z');
  });

  it('atribuye el lote por el dueño de la línea cuando no trae cuenta', () => {
    const user = usuario('act-2', 'bruno-actividad');
    run(
      `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
       VALUES ('s-owner', 'Línea de Bruno', 'act-2', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );
    run(
      `INSERT INTO batches (session_id, name, total, status, meta, started_at, created_at, updated_at)
       VALUES ('s-owner', 'Lote heredado', 1, 'done', '{}', '2026-10-11T08:00:00.000Z', ?, '2026-10-11T08:00:00.000Z')`,
      nowIso(),
    );
    const use = lastUseByUser([user]).get(user.id);
    assert.equal(use?.kind, 'batch');
    assert.equal(use?.label, 'Envío por lote');
  });

  it('no inventa actividad para cuentas sin mensajes, lotes ni notas', () => {
    const user = usuario('act-3', 'carla-actividad');
    assert.equal(lastUseByUser([user]).size, 0);
  });

  it('arma la ficha individual con respuestas, envíos, notas y tareas', () => {
    const user = usuario('act-4', 'diego-actividad');
    run(
      `INSERT INTO sessions (id, name, owner_uid, expected_phone, status, created_at, updated_at)
       VALUES ('s-ficha', 'Línea de Diego', 'act-4', '59171111111', 'ready', ?, ?)`,
      nowIso(),
      nowIso(),
    );
    const contact = run(
      `INSERT INTO contacts (session_id, chat_id, phone, phone_key, name, created_at, updated_at)
       VALUES ('s-ficha', '59171111111@c.us', '59171111111', '59171111111', 'Cliente Ficha', ?, ?)`,
      nowIso(),
      nowIso(),
    );

    const period = resolvePeriod({ period: 'custom', from: '2026-10-10', to: '2026-10-10' }, '30d');
    const start = Date.parse(period.fromIso) + 6 * 3_600_000;
    const incoming = new Date(start).toISOString();
    const reply = new Date(start + 10 * 60_000).toISOString();
    const noteAt = new Date(start + 30 * 60_000).toISOString();

    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, occurred_at, created_at)
       VALUES ('s-ficha', '59171111111@c.us', 'in', 'text', ?, ?)`,
      incoming,
      incoming,
    );
    run(
      `INSERT INTO messages (session_id, chat_id, direction, content_type, origin, sender_uid, body, occurred_at, created_at)
       VALUES ('s-ficha', '59171111111@c.us', 'out', 'text', 'panel', ?, 'Hola', ?, ?)`,
      user.id,
      reply,
      reply,
    );
    run(
      `INSERT INTO contact_notes (contact_id, user_id, assigned_to, note_text, created_at, due_at)
       VALUES (?, ?, ?, 'Llamar por la tarde', ?, '2000-01-01')`,
      contact.lastInsertRowid,
      user.id,
      user.id,
      noteAt,
    );

    const scope = { sessionIds: null };
    const attention = attentionData(scope, period);
    const performance = userPerformance(scope, period, attention).find((u) => u.id === user.id);
    const detail = userReportDetail(
      scope,
      period,
      { id: user.id, name: user.name, username: user.username, source_uid: user.source_uid },
      attention,
      performance,
    );

    assert.equal(detail.performance.responses, 1);
    assert.equal(detail.within15, 1);
    assert.equal(detail.sends.panel, 1);
    assert.equal(detail.byDay.find((d) => d.day === period.from)?.responses, 1);
    assert.equal(detail.byDay.find((d) => d.day === period.from)?.sent, 1);
    assert.equal(detail.topChats[0]?.name, 'Cliente Ficha');
    assert.equal(detail.assigned.counts.overdue, 1);
    assert.ok(detail.recent.some((a) => a.kind === 'message'));
    assert.ok(detail.recent.some((a) => a.kind === 'note'));

    const html = renderReportUser({
      user,
      detail,
      period,
      sessions: [],
      selectedSession: '',
      lastUse: lastUseByUser([user]).get(user.id) ?? null,
      filters: { programa: '', account: '', area: '', tipo: '' },
    });
    assert.match(html, /Ficha del equipo/);
    assert.match(html, /Cliente Ficha/);
    assert.match(html, /id="urDaily"/);
    assert.match(html, /"kind":"user"/);
  });
});
