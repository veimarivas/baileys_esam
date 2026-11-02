import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alertSessionDown,
  listNotificationHistory,
  listNotifications,
  markRead,
  notificationCategory,
  notificationCounts,
  notify,
  unreadCount,
  unreadCounts,
} from '../src/core/notifications.js';
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

describe('divisiones de la campana', () => {
  const user = upsertUser({
    sourceUid: 'owner-cats',
    name: 'Usuario Categorías',
    email: 'categorias@esam.local',
    autorizado: true,
  });

  it('clasifica cada tipo en una sola división', () => {
    assert.equal(notificationCategory('note_created'), 'notes');
    assert.equal(notificationCategory('resolved'), 'notes');
    assert.equal(notificationCategory('session_down'), 'whatsapp');
    assert.equal(notificationCategory('line_issue'), 'whatsapp');
    assert.equal(notificationCategory('batch_paused'), 'batches');
    assert.equal(notificationCategory('chat_assigned'), 'chats');
    assert.equal(notificationCategory('daily_digest'), 'system');
  });

  it('cuenta las no leídas por división y filtra la lista', () => {
    notify([user.id], { kind: 'note_created', title: 'Nota nueva' });
    notify([user.id], { kind: 'resolved', title: 'Tarea resuelta' });
    notify([user.id], { kind: 'session_down', title: 'Línea caída' });
    notify([user.id], { kind: 'batch_paused', title: 'Lote pausado' });
    notify([user.id], { kind: 'chat_assigned', title: 'Chat asignado' });
    notify([user.id], { kind: 'daily_digest', title: 'Resumen diario' });

    assert.deepEqual(unreadCounts(user.id), { all: 6, notes: 2, whatsapp: 1, batches: 1, chats: 1, system: 1 });

    const notas = listNotifications(user.id, 50, 'notes');
    assert.equal(notas.length, 2);
    assert.ok(notas.every((n) => n.category === 'notes'));
    assert.equal(listNotifications(user.id, 50, 'whatsapp').length, 1);
    assert.equal(listNotifications(user.id, 50, 'all').length, 6);
  });

  it('marcar una como leída baja el total y el contador de su división', () => {
    const notas = listNotifications(user.id, 10, 'notes');
    assert.equal(markRead(user.id, [notas[0].id]), 1);

    assert.deepEqual(unreadCounts(user.id), { all: 5, notes: 1, whatsapp: 1, batches: 1, chats: 1, system: 1 });
    assert.equal(unreadCount(user.id), 5);
  });

  it('la campana lista solo las pendientes', () => {
    assert.equal(listNotifications(user.id, 50, 'all', true).length, 5);
    assert.ok(listNotifications(user.id, 50, 'all', true).every((n) => !n.read_at));
    assert.equal(listNotifications(user.id, 50, 'notes', true).length, 1);
  });

  it('el historial incluye leídas y pagina los resultados', () => {
    const page1 = listNotificationHistory(user.id, { page: 1, pageSize: 4 });
    assert.equal(page1.total, 6);
    assert.equal(page1.items.length, 4);
    assert.equal(page1.pages, 2);

    const page2 = listNotificationHistory(user.id, { page: 2, pageSize: 4 });
    assert.equal(page2.items.length, 2);

    const leidas = listNotificationHistory(user.id, { state: 'read' });
    assert.equal(leidas.total, 1);
    assert.equal(leidas.items[0].category, 'notes');

    const notasPendientes = listNotificationHistory(user.id, { category: 'notes', state: 'unread' });
    assert.equal(notasPendientes.total, 1);
  });

  it('cuenta todos, leídos y no leídos por división', () => {
    assert.deepEqual(notificationCounts(user.id, 'all'), { all: 6, notes: 2, whatsapp: 1, batches: 1, chats: 1, system: 1 });
    assert.deepEqual(notificationCounts(user.id, 'read'), { all: 1, notes: 1, whatsapp: 0, batches: 0, chats: 0, system: 0 });
    assert.deepEqual(notificationCounts(user.id, 'unread'), unreadCounts(user.id));
  });
});
