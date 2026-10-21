import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchChatMessages } from '../src/core/conversations.js';
import { run } from '../src/db/index.js';

/**
 * La búsqueda del inbox consulta el historial completo de un chat (no solo lo
 * cargado en pantalla). Estas pruebas fijan el orden, el alcance y que los
 * comodines de SQL se traten como texto.
 */

let clock = Date.now();

function insertMessage(
  chatId: string,
  body: string | null,
  options: { sessionId?: string; contentType?: string; transcription?: string | null } = {},
): number {
  const at = new Date(clock += 1000).toISOString();
  return run(
    `INSERT INTO messages (session_id, chat_id, direction, content_type, body, transcription, occurred_at, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?)`,
    options.sessionId ?? 'ses-search',
    chatId,
    options.contentType ?? 'text',
    body,
    options.transcription ?? null,
    at,
    at,
  ).lastInsertRowid;
}

describe('búsqueda en la conversación', () => {
  it('encuentra texto sin distinguir mayúsculas y devuelve lo más nuevo primero', () => {
    const chat = '59170001001@c.us';
    const first = insertMessage(chat, 'Enviar el informe mensual');
    const second = insertMessage(chat, 'El INFORME ya está listo');

    const found = searchChatMessages('ses-search', chat, 'informe');
    assert.equal(found.total, 2);
    assert.deepEqual(found.results.map((r) => r.id), [second, first]);
    assert.equal(found.results[0].text, 'El INFORME ya está listo');
  });

  it('devuelve el total aunque la lista venga recortada', () => {
    const chat = '59170001002@c.us';
    for (let i = 0; i < 5; i++) insertMessage(chat, `Presupuesto ${i}`);

    const found = searchChatMessages('ses-search', chat, 'presupuesto', 2);
    assert.equal(found.total, 5);
    assert.equal(found.results.length, 2);
  });

  it('trata % y _ como texto, no como comodines', () => {
    const chat = '59170001003@c.us';
    insertMessage(chat, 'Avance del 50% hoy');
    insertMessage(chat, 'Avance del 50x hoy');
    insertMessage(chat, 'Plan_a revisado');
    insertMessage(chat, 'Planxa revisado');

    const percent = searchChatMessages('ses-search', chat, '50%');
    assert.equal(percent.total, 1);
    assert.match(percent.results[0].text, /50%/);

    const underscore = searchChatMessages('ses-search', chat, 'plan_a');
    assert.equal(underscore.total, 1);
    assert.match(underscore.results[0].text, /Plan_a/);
  });

  it('no mezcla chats ni líneas', () => {
    const chat = '59170001004@c.us';
    insertMessage(chat, 'Palabra clave del chat');
    insertMessage('59170001005@c.us', 'Palabra clave de otro chat');
    insertMessage(chat, 'Palabra clave de otra línea', { sessionId: 'ses-otra' });

    const found = searchChatMessages('ses-search', chat, 'palabra clave');
    assert.equal(found.total, 1);
    assert.equal(found.results[0].text, 'Palabra clave del chat');
  });

  it('busca también en la transcripción de una nota de voz', () => {
    const chat = '59170001006@c.us';
    insertMessage(chat, null, { contentType: 'audio', transcription: 'El presupuesto quedó aprobado' });

    const found = searchChatMessages('ses-search', chat, 'aprobado');
    assert.equal(found.total, 1);
    assert.equal(found.results[0].contentType, 'audio');
    assert.match(found.results[0].text, /aprobado/);
  });

  it('con menos de dos letras no busca', () => {
    const chat = '59170001007@c.us';
    insertMessage(chat, 'Una frase cualquiera');

    assert.deepEqual(searchChatMessages('ses-search', chat, ' '), { total: 0, results: [] });
    assert.deepEqual(searchChatMessages('ses-search', chat, 'u'), { total: 0, results: [] });
  });
});
