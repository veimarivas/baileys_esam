import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listModuleFollowups,
  markModuleFollowupDone,
  pendingModuleFollowups,
  upsertModuleFollowup,
} from '../src/core/module-followups.js';
import { upsertUser, type UserRow } from '../src/auth/users.js';
import { get } from '../src/db/index.js';

/**
 * Seguimiento de desarrollo de módulos: cronogramas envía sesiones pasadas
 * marcadas como Desarrolladas sin asistencia y /notes las muestra a su
 * responsable. Son idempotentes por referencia y solo las ve su responsable
 * (o el Super Admin).
 */

const RESP = 'mf-resp';
const ADMIN = 'mf-admin';
upsertUser({
  sourceUid: RESP,
  name: 'Responsable Módulos',
  username: RESP,
  email: 'mf-resp@t.local',
  source: 'cronogramas',
  autorizado: true,
  roles: ['Responsable Académico'],
});
upsertUser({
  sourceUid: ADMIN,
  name: 'Super Admin Módulos',
  username: ADMIN,
  email: 'mf-admin@t.local',
  source: 'cronogramas',
  autorizado: true,
  roles: ['Super Admin'],
});

const user = (uid: string) => get<UserRow>('SELECT * FROM users WHERE source_uid = ?', uid)!;

describe('seguimiento de desarrollo de módulos', () => {
  it('crea el seguimiento para el responsable y es idempotente por referencia', () => {
    const first = upsertModuleFollowup({
      ref: 'modulo-10-1',
      account: RESP,
      title: 'Asistencia pendiente · Álgebra',
      program: 'Programa Demo',
      programId: 7,
      module: 'Álgebra',
      moduleId: 10,
      horarioId: 55,
      sessionAt: '2026-10-30T19:00:00',
      sessionLabel: '30/10/2026 · 19:00 - 21:00',
      link: 'http://cronogramas/admin/programas/modulo/10/detalle',
    });
    assert.equal(first.created, true);

    const second = upsertModuleFollowup({
      ref: 'modulo-10-1',
      account: RESP,
      title: 'Asistencia pendiente · Álgebra',
      program: 'Programa Demo',
      module: 'Álgebra',
      sessionLabel: '30/10/2026 · 19:00 - 21:00',
    });
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(pendingModuleFollowups(user(RESP)), 1);
  });

  it('el responsable ve lo suyo y el Super Admin ve todo', () => {
    assert.equal(listModuleFollowups(user(RESP), { status: 'pending' }).length, 1);
    assert.equal(listModuleFollowups(user(ADMIN), { status: 'pending' }).length, 1);
  });

  it('marca como atendido y deja de estar pendiente', () => {
    const item = listModuleFollowups(user(RESP), { status: 'pending' })[0];
    const done = markModuleFollowupDone(item.id, user(RESP));
    assert.equal(done.status, 'done');
    assert.ok(done.done_at);
    assert.equal(pendingModuleFollowups(user(RESP)), 0);
  });

  it('guarda las sesiones que agrupa la nota diaria', () => {
    const result = upsertModuleFollowup({
      ref: 'modulo-dia-2026-10-30',
      account: RESP,
      title: 'Asistencia pendiente · 30/10/2026',
      sessionLabel: '30/10/2026',
      sessions: [
        { horarioId: 101, program: 'Programa Demo', module: 'Álgebra', time: '19:00 - 21:00', state: 'Confirmado', link: 'http://cronogramas/modulo/10' },
        { horarioId: 102, program: 'Programa Demo', module: 'Física', time: '21:00 - 23:00', state: 'Desarrollado', link: 'http://cronogramas/modulo/11' },
      ],
    });
    const item = listModuleFollowups(user(RESP), { status: 'pending' }).find((x) => x.id === result.id)!;
    assert.equal(item.sessions.length, 2);
    assert.equal(item.sessions[0].module, 'Álgebra');
    assert.equal(item.sessions[0].state, 'Confirmado');
    assert.equal(item.sessions[1].time, '21:00 - 23:00');
  });

  it('crea el usuario espejo si el responsable todavía no ingresó', () => {
    const result = upsertModuleFollowup({
      ref: 'modulo-10-2',
      account: 'mf-nuevo',
      responsibleName: 'Nuevo Responsable',
      module: 'Álgebra',
    });
    const created = get<UserRow>('SELECT * FROM users WHERE source_uid = ?', 'mf-nuevo')!;
    assert.equal(result.assignedTo, created.id);
    assert.equal(created.name, 'Nuevo Responsable');
    assert.equal(created.esam_autorizado, 0);
  });
});
