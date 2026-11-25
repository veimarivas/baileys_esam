import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSede, deleteSede, listSedes, renameSede } from '../src/core/sedes.js';
import {
  createLocalUser,
  esamEsAdmin,
  esamEsAsesorMarketing,
  esamEsGerenteSede,
  esamEsMarketingManager,
  esamPuede,
  esamRoles,
  esamSupervisaArea,
  findById,
  sessionScopeFor,
  updateManagedUser,
  upsertUser,
} from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Sedes y usuarios locales: el Super Admin crea la sede y la cuenta con un
 * cargo. El alcance de cada cargo se limita a su sede/área, mientras que las
 * cuentas de cronogramas conservan su comportamiento anterior.
 */

function seedSession(id: string, opts: { sedeId?: number | null; area?: string | null; ownerUid?: string; phone?: string } = {}): void {
  const now = nowIso();
  run(
    `INSERT INTO sessions (id, name, owner_uid, area, sede_id, status, expected_phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    id,
    id,
    opts.ownerUid ?? id,
    opts.area ?? null,
    opts.sedeId ?? null,
    opts.phone ?? null,
    now,
    now,
  );
}

// El CI es obligatorio y único en las cuentas locales.
let ciSeq = 0;
const nextCi = (): string => String(6100000 + ++ciSeq);

function localUser(opts: {
  username: string;
  cargo: string;
  sedeId: number;
  numero: string;
  name?: string;
}) {
  return createLocalUser({
    ci: nextCi(),
    name: opts.name ?? opts.username,
    username: opts.username,
    email: `${opts.username}@test.local`,
    password: 'secreto123',
    numero: opts.numero,
    sedeId: opts.sedeId,
    roles: [opts.cargo],
  });
}

describe('sedes', () => {
  it('crea, renombra y elimina sedes sin usuarios', () => {
    const id = createSede('Sede Central');
    assert.equal(listSedes().find((s) => s.id === id)?.name, 'Sede Central');
    assert.throws(() => createSede('sede central'), /Ya existe/);
    renameSede(id, 'Sede Norte');
    assert.equal(listSedes().find((s) => s.id === id)?.name, 'Sede Norte');
    const vacia = createSede('Sede Vacía');
    deleteSede(vacia);
    assert.equal(listSedes().some((s) => s.id === vacia), false);
  });

  it('no elimina una sede con usuarios asignados', () => {
    const sede = createSede('Sede Con Usuarios');
    localUser({ username: 'sede.ocupada', cargo: 'Gerente General', sedeId: sede, numero: '59170000901' });
    assert.throws(() => deleteSede(sede), /usuarios asignados/);
  });
});

describe('usuarios locales y alcance por cargo', () => {
  it('crea la cuenta, la vincula a su sede y le crea su línea', () => {
    const sede = createSede('Sede Oriente');
    const user = localUser({ username: 'gerente.oriente', cargo: 'Gerente General', sedeId: sede, numero: '59170000902' });
    assert.equal(user.source, 'local');
    assert.equal(user.sede_id, sede);
    assert.deepEqual(esamRoles(user), ['Gerente General']);
    assert.equal(user.esam_autorizado, 1);
    assert.equal(esamEsAdmin(user), false);
    assert.equal(esamEsGerenteSede(user), true);
    assert.equal(esamPuede(user, 'users'), false, 'solo el Super Admin administra usuarios');
    assert.equal(esamPuede(user, 'reports'), true);

    const line = get<{ c: number }>('SELECT COUNT(*) AS c FROM sessions WHERE sede_id = ? AND expected_phone = ?', sede, '59170000902');
    assert.equal(line?.c, 1);
  });

  it('el Gerente General ve todas las líneas de su sede y ninguna de otra', () => {
    const sede = createSede('Sede Gerencia');
    const otra = createSede('Sede Ajena');
    const user = localUser({ username: 'gerente.sede', cargo: 'Gerente General', sedeId: sede, numero: '59170000903' });
    seedSession('g-marketing', { sedeId: sede, area: 'marketing' });
    seedSession('g-academico', { sedeId: sede, area: 'academico' });
    seedSession('g-otra', { sedeId: otra, area: 'marketing' });

    const scope = sessionScopeFor(user);
    assert.ok(scope);
    assert.ok(scope.includes('g-marketing'));
    assert.ok(scope.includes('g-academico'));
    assert.equal(scope.includes('g-otra'), false);
  });

  it('el Gerente/Supervisor de Marketing ve solo marketing de su sede', () => {
    const sede = createSede('Sede Marketing');
    const otra = createSede('Sede Marketing Ajena');
    const user = localUser({ username: 'gerente.marketing', cargo: 'Gerente de Marketing', sedeId: sede, numero: '59170000904' });
    seedSession('m-propia', { sedeId: sede, area: 'marketing' });
    seedSession('m-companera', { sedeId: sede, area: 'marketing', ownerUid: 'm-otra-persona' });
    seedSession('m-academico', { sedeId: sede, area: 'academico' });
    seedSession('m-otra-sede', { sedeId: otra, area: 'marketing' });

    assert.equal(user.esam_area, 'marketing');
    assert.equal(esamEsMarketingManager(user), true);
    assert.equal(esamSupervisaArea(user), 'marketing');
    const scope = sessionScopeFor(user);
    assert.ok(scope);
    assert.ok(scope.includes('m-propia'));
    assert.ok(scope.includes('m-companera'));
    assert.equal(scope.includes('m-academico'), false);
    assert.equal(scope.includes('m-otra-sede'), false);
  });

  it('el Asesor de Marketing queda limitado a su propia línea', () => {
    const sede = createSede('Sede Asesores');
    seedSession('a-propia', { sedeId: sede, area: 'marketing', phone: '59170000905' });
    const user = localUser({ username: 'asesor.marketing', cargo: 'Asesor de Marketing', sedeId: sede, numero: '59170000905' });
    seedSession('a-companera', { sedeId: sede, area: 'marketing', ownerUid: 'a-otra-persona' });

    assert.equal(esamEsAsesorMarketing(user), true);
    assert.equal(esamEsMarketingManager(user), false);
    assert.equal(esamPuede(user, 'reports'), false);
    const scope = sessionScopeFor(user);
    assert.deepEqual(scope, ['a-propia']);
  });

  it('rechaza cargos fuera de la lista y contraseñas cortas', () => {
    const sede = createSede('Sede Validaciones');
    assert.throws(
      () => createLocalUser({
        ci: nextCi(),
        name: 'Cargo Inválido',
        username: 'cargo.invalido',
        email: null,
        password: 'secreto123',
        numero: '59170000906',
        sedeId: sede,
        roles: ['Super Admin'],
      }),
      /cargo/,
    );
    assert.throws(
      () => createLocalUser({
        ci: nextCi(),
        name: 'Clave Corta',
        username: 'clave.corta',
        email: null,
        password: '123',
        numero: '59170000907',
        sedeId: sede,
        roles: ['Asesor de Marketing'],
      }),
      /contraseña/,
    );
  });

  it('editar mantiene el cargo de cronogramas pero actualiza la sede de su línea', () => {
    const sedeOrigen = createSede('Sede Origen');
    const sedeDestino = createSede('Sede Destino');
    const user = localUser({ username: 'marketing.movida', cargo: 'Gerente de Marketing', sedeId: sedeOrigen, numero: '59170000908' });
    updateManagedUser(user.id, { sedeId: sedeDestino, autorizado: true, preserveRoles: true });
    const updated = findById(user.id)!;
    assert.deepEqual(esamRoles(updated), ['Gerente de Marketing']);
    assert.equal(updated.sede_id, sedeDestino);
    const line = get<{ sede_id: number; area: string }>(
      "SELECT sede_id, area FROM sessions WHERE expected_phone = '59170000908'",
    );
    assert.equal(line?.sede_id, sedeDestino);
    assert.equal(line?.area, 'marketing');
  });

  it('la cuenta local principal conserva el acceso total', () => {    const user = upsertUser({
      sourceUid: 'local-super',
      name: 'Cuenta principal',
      username: 'principal.local',
      email: 'principal@test.local',
      source: 'local',
      autorizado: true,
      roles: ['Super Admin'],
    });
    assert.equal(esamEsAdmin(user), true);
    assert.equal(esamPuede(user, 'users'), true);
    assert.equal(sessionScopeFor(user), null);
  });

  it('al Super Admin se le puede asignar un área sin perder el cargo ni el acceso', () => {
    const user = upsertUser({
      sourceUid: 'super-con-area',
      name: 'Super Admin con área',
      username: 'super.area',
      email: 'super.area@test.local',
      source: 'cronogramas',
      autorizado: true,
      roles: ['Super Admin'],
    });
    updateManagedUser(user.id, { area: 'marketing', preserveRoles: true });
    const updated = findById(user.id)!;
    assert.equal(updated.esam_area, 'marketing');
    assert.deepEqual(esamRoles(updated), ['Super Admin']);
    assert.equal(esamEsAdmin(updated), true);
    assert.equal(esamPuede(updated, 'users'), true);
  });

  it('las cuentas de cronogramas con cargo de Marketing mantienen su alcance personal', () => {
    const user = upsertUser({
      sourceUid: 'crono-supervisor',
      name: 'Supervisor de cronogramas',
      username: 'crono.supervisor',
      email: 'crono.supervisor@test.local',
      source: 'cronogramas',
      autorizado: true,
      roles: ['Supervisor de Marketing'],
    });
    seedSession('crono-linea', { ownerUid: 'crono-supervisor' });
    assert.equal(esamEsAdmin(user), false);
    assert.equal(esamEsMarketingManager(user), true);
    assert.deepEqual(sessionScopeFor(user), ['crono-linea']);
  });
});
