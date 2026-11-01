import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reopenOnInbound, setConversationState } from '../src/core/conversation-state.js';
import { upsertUser } from '../src/auth/users.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Estado de la atención (Por atender / En atención / Resuelto) y responsable del chat. */
upsertUser({ sourceUid: 'cs-ana', name: 'Ana', username: 'cs-ana', email: 'cs-ana@t.local', source: 'cronogramas', autorizado: true, roles: [] });
upsertUser({ sourceUid: 'cs-beto', name: 'Beto', username: 'cs-beto', email: 'cs-beto@t.local', source: 'cronogramas', autorizado: true, roles: [] });
const ana = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'cs-ana'")!.id;
const beto = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'cs-beto'")!.id;
run("INSERT INTO sessions (id, name, status, created_at, updated_at) VALUES ('cs-line', 'cs-line', 'ready', ?, ?)", nowIso(), nowIso());
run("INSERT INTO conversations (session_id, chat_id, contact_name, created_at, updated_at) VALUES ('cs-line', '59170009999@c.us', 'Carla', ?, ?)", nowIso(), nowIso());
const row = () => get<{ status: string; assigned_agent_id: number | null; closed_at: string | null }>(
  "SELECT status, assigned_agent_id, closed_at FROM conversations WHERE chat_id = '59170009999@c.us'",
)!;

describe('estado y responsable de la conversación', () => {
  it('cambia el estado y registra cuándo se resolvió', () => {
    const s = setConversationState('cs-line', '59170009999@c.us', { status: 'pending' }, { id: ana, name: 'Ana' })!;
    assert.equal(s.status, 'pending');
    setConversationState('cs-line', '59170009999@c.us', { status: 'closed' }, { id: ana, name: 'Ana' });
    assert.equal(row().status, 'closed');
    assert.ok(row().closed_at);
    assert.throws(() => setConversationState('cs-line', '59170009999@c.us', { status: 'raro' as never }, { id: ana, name: 'Ana' }));
  });

  it('un mensaje entrante reabre el chat resuelto', () => {
    assert.equal(reopenOnInbound('cs-line', '59170009999@c.us'), true);
    assert.equal(row().status, 'open');
    assert.equal(row().closed_at, null);
    assert.equal(reopenOnInbound('cs-line', '59170009999@c.us'), false, 'si no estaba resuelto, no cambia');
  });

  it('al asignar avisa al responsable (no a quien se asigna a sí mismo)', () => {
    const s = setConversationState('cs-line', '59170009999@c.us', { assignedTo: beto }, { id: ana, name: 'Ana' })!;
    assert.equal(s.assigned_agent?.id, beto);
    const aviso = get<{ title: string; link: string }>("SELECT title, link FROM notifications WHERE kind = 'chat_assigned' AND user_id = ?", beto)!;
    assert.match(aviso.title, /Ana te asignó el chat de Carla/);
    assert.equal(aviso.link, '/conversations/59170009999%40c.us');
    setConversationState('cs-line', '59170009999@c.us', { assignedTo: ana }, { id: ana, name: 'Ana' });
    assert.equal(get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'chat_assigned' AND user_id = ?", ana)!.c, 0);
    setConversationState('cs-line', '59170009999@c.us', { assignedTo: null }, { id: ana, name: 'Ana' });
    assert.equal(row().assigned_agent_id, null);
  });

  it('un chat que no existe devuelve null', () => {
    assert.equal(setConversationState('cs-line', 'nadie@c.us', { status: 'closed' }, { id: ana, name: 'Ana' }), null);
  });
});
