import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { esamSupervisaArea, upsertUser } from '../src/auth/users.js';
import { listAllNotes, noteInArea } from '../src/core/contacts.js';
import { ProspectError, removeProspect, upsertProspect } from '../src/core/prospects.js';
import { get, run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';
import type { SessionRow } from '../src/types.js';

/**
 * Prospectos de marketing registrados en cronogramas: cada uno es una nota de
 * seguimiento del asesor (área Marketing en /notes). La gerencia y la
 * supervisión de marketing ven las de todos los asesores; el resto, solo lo suyo.
 */
function asesor(uid: string, roles: string[], area: string) {
  const user = upsertUser({ sourceUid: uid, name: `Usuario ${uid}`, username: uid, email: `${uid}@test.local`, source: 'cronogramas', autorizado: true, area, roles });
  run(
    `INSERT INTO sessions (id, name, owner_uid, status, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)`,
    `s-${uid}`,
    `Línea ${uid}`,
    uid,
    nowIso(),
    nowIso(),
  );
  return { user, session: get<SessionRow>('SELECT * FROM sessions WHERE id = ?', `s-${uid}`)! };
}

const ana = asesor('pr-ana', ['Asesor de Marketing'], 'marketing');
const beto = asesor('pr-beto', ['Asesor de Marketing'], 'marketing');
const supervisora = asesor('pr-sup', ['Supervisor de Marketing'], 'marketing');
const gerente = asesor('pr-ger', ['Gerencia Marketing'], 'marketing');
const conta = asesor('pr-conta', ['Contabilidad'], 'contabilidad');

const prospectRefs = (opts: Parameters<typeof listAllNotes>[0]) =>
  listAllNotes({ status: 'all', ...opts }).map((n) => (n as { prospect_ref?: string }).prospect_ref).filter(Boolean).sort();

describe('prospectos de marketing', () => {
  it('crea la nota del asesor en su línea, con etiqueta y programa', () => {
    const { noteId, created } = upsertProspect(
      { ref: 'mp:1', account: 'pr-ana', phone: '71234501', name: 'Pedro', programa: 'Diplomado en Docencia', programaId: 177, estado: 'nuevo' },
      ana.session,
    );
    assert.equal(created, true);
    const note = get<{ user_id: number; note_text: string; contact_id: number; prospect_meta: string; done_at: string | null }>(
      'SELECT * FROM contact_notes WHERE id = ?',
      noteId,
    )!;
    assert.equal(note.user_id, ana.user.id);
    assert.match(note.note_text, /Diplomado en Docencia/);
    assert.equal(JSON.parse(note.prospect_meta).estado_label, 'Nuevo');
    assert.equal(get<{ chat_id: string }>('SELECT chat_id FROM contacts WHERE id = ?', note.contact_id)!.chat_id, '59171234501@c.us');
    assert.equal(get<{ name: string }>(
      'SELECT t.name FROM contact_note_tags nt JOIN note_tags t ON t.id = nt.tag_id WHERE nt.note_id = ?',
      noteId,
    )!.name, 'Prospecto');
  });

  it('el estado mueve la misma nota en el pipeline', () => {
    const first = upsertProspect({ ref: 'mp:1', account: 'pr-ana', phone: '71234501', programa: 'Diplomado en Docencia', estado: 'interesado' }, ana.session);
    assert.equal(first.created, false);
    assert.ok(get<{ contacted_at: string | null }>('SELECT contacted_at FROM contact_notes WHERE id = ?', first.noteId)!.contacted_at);
    upsertProspect({ ref: 'mp:1', account: 'pr-ana', phone: '71234501', programa: 'Diplomado en Docencia', estado: 'inscrito' }, ana.session);
    assert.ok(get<{ done_at: string | null }>('SELECT done_at FROM contact_notes WHERE id = ?', first.noteId)!.done_at);
  });

  it('rechaza asesor sin usuario o celular inválido', () => {
    assert.throws(() => upsertProspect({ ref: 'mp:x', account: 'nadie', phone: '71234509' }, ana.session), ProspectError);
    assert.throws(() => upsertProspect({ ref: 'mp:y', account: 'pr-ana', phone: '12' }, ana.session), ProspectError);
    assert.throws(() => upsertProspect({ ref: 'mp:z', account: 'pr-ana', phone: '71234509' }, undefined), ProspectError);
  });

  it('cada asesor ve lo suyo; gerencia y supervisión, todo marketing; otras áreas, nada', () => {
    upsertProspect({ ref: 'mp:2', account: 'pr-beto', phone: '71234502', programa: 'Maestría', estado: 'nuevo' }, beto.session);
    const view = (u: typeof ana.user) => prospectRefs({ ownerId: u.id, ownerArea: esamSupervisaArea(u) });
    assert.deepEqual(view(ana.user), ['mp:1']);
    assert.deepEqual(view(beto.user), ['mp:2']);
    assert.deepEqual(view(supervisora.user), ['mp:1', 'mp:2']);
    assert.deepEqual(view(gerente.user), ['mp:1', 'mp:2']);
    assert.deepEqual(view(conta.user), []);
    // Super Admin: sin restricción.
    assert.deepEqual(prospectRefs({}), ['mp:1', 'mp:2']);
  });

  it('el área de la nota habilita el acceso de la supervisión', () => {
    const id = get<{ id: number }>("SELECT id FROM contact_notes WHERE prospect_ref = 'mp:2'")!.id;
    assert.equal(noteInArea(id, 'marketing'), true);
    assert.equal(noteInArea(id, 'contabilidad'), false);
    assert.equal(esamSupervisaArea(ana.user), null);
  });

  it('al eliminar el prospecto la nota va a la papelera', () => {
    const id = removeProspect('mp:2');
    assert.ok(id);
    assert.ok(get<{ deleted_at: string | null }>('SELECT deleted_at FROM contact_notes WHERE id = ?', id)!.deleted_at);
    assert.equal(removeProspect('mp:no-existe'), null);
  });
});
