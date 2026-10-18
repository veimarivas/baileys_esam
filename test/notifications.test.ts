import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alertSessionDown, notify, unreadCount } from '../src/core/notifications.js';
import { upsertUser } from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/**
 * Avisos de la campana. Acá vive lo nuevo de la etapa de seguridad: cuando una
 * línea se cae, el dueño y el Super Admin tienen que enterarse, pero sin que una
 * conexión que va y viene llene la campana de avisos repetidos.
 */

function crearSesion(id: string, ownerUid: string | null): void {
  run(
    `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at)
     VALUES (?, ?, ?, 'disconnected', ?, ?)`,
    id,
    `Línea ${id}`,
    ownerUid,
    nowIso(),
    nowIso(),
  );
}

function avisosDe(sessionId: string): number {
  return (
    get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM notifications WHERE kind = 'session_down' AND session_id = ?",
      sessionId,
    )?.c ?? 0
  );
}

describe('alertSessionDown', () => {
  const dueno = upsertUser({
    sourceUid: 'owner-1',
    name: 'Dueño Uno',
    email: 'dueno1@esam.local',
    autorizado: true,
    roles: ['admin'],
  });

  it('avisa al dueño de la línea con el motivo y el enlace a Conexión', () => {
    crearSesion('ses-a', 'owner-1');
    assert.equal(alertSessionDown('ses-a', 'Línea ses-a', 'Se cerró la sesión desde el teléfono.'), true);

    const aviso = get<{ title: string; body: string; link: string; user_id: number }>(
      "SELECT title, body, link, user_id FROM notifications WHERE kind = 'session_down' AND session_id = 'ses-a' LIMIT 1",
    );
    assert.ok(aviso);
    assert.equal(aviso.user_id, dueno.id);
    assert.match(aviso.title, /Se desconectó WhatsApp: Línea ses-a/);
    assert.match(aviso.body ?? '', /Se cerró la sesión desde el teléfono/);
    assert.equal(aviso.link, '/settings');
  });

  it('no repite el aviso mientras el anterior siga sin leer', () => {
    assert.equal(avisosDe('ses-a'), 1);
    assert.equal(alertSessionDown('ses-a', 'Línea ses-a', 'Otra caída.'), false);
    assert.equal(avisosDe('ses-a'), 1);
  });

  it('vuelve a avisar si el anterior ya se leyó', () => {
    run("UPDATE notifications SET read_at = ? WHERE kind = 'session_down' AND session_id = 'ses-a'", nowIso());
    assert.equal(alertSessionDown('ses-a', 'Línea ses-a', 'Se cayó de nuevo.'), true);
    assert.equal(avisosDe('ses-a'), 2);
  });

  it('el control es por línea: dos números caídos generan dos avisos', () => {
    crearSesion('ses-b', 'owner-1');
    assert.equal(alertSessionDown('ses-b', 'Línea ses-b', 'Sin conexión.'), true);
    assert.equal(avisosDe('ses-a'), 2);
    assert.equal(avisosDe('ses-b'), 1);
  });

  it('no falla si la línea no tiene dueño registrado', () => {
    crearSesion('ses-c', null);
    // Sin dueño, el aviso va igual a los supervisores (o a nadie si no hay).
    alertSessionDown('ses-c', '', 'Caída sin dueño.');
    assert.ok(avisosDe('ses-c') <= 1);
  });
});

describe('notify', () => {
  const user = upsertUser({
    sourceUid: 'owner-2',
    name: 'Dueño Dos',
    email: 'dueno2@esam.local',
    autorizado: true,
  });

  it('no avisa a nadie cuando la lista viene vacía', () => {
    const antes = unreadCount(user.id);
    notify([], { kind: 'note_created', title: 'Nadie' });
    assert.equal(unreadCount(user.id), antes);
  });

  it('no se avisa a sí mismo', () => {
    const antes = unreadCount(user.id);
    notify([user.id], { kind: 'note_created', actorId: user.id, title: 'Yo mismo' });
    assert.equal(unreadCount(user.id), antes);
  });

  it('suma un aviso sin leer y recorta los textos largos', () => {
    const antes = unreadCount(user.id);
    notify([user.id], { kind: 'note_created', title: 'T'.repeat(500), body: 'B'.repeat(900) });
    assert.equal(unreadCount(user.id), antes + 1);

    const ultimo = get<{ title: string; body: string }>(
      'SELECT title, body FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      user.id,
    );
    assert.equal(ultimo?.title.length, 200);
    assert.equal(ultimo?.body.length, 500);
  });
});
