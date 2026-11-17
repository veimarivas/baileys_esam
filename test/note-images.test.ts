import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addNote, listNoteHistory, noteDTO, setNoteImage } from '../src/core/contacts.js';
import { run } from '../src/db/index.js';
import { nowIso } from '../src/util/async.js';

/** Las notas internas pueden llevar una imagen además del texto o el audio. */

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

function seedContact(chatId: string, phone: string): number {
  const now = nowIso();
  return run(
    `INSERT INTO contacts (session_id, chat_id, phone, name, created_at, updated_at)
     VALUES ('s-note-images', ?, ?, 'Persona imagen', ?, ?)`,
    chatId,
    phone,
    now,
    now,
  ).lastInsertRowid;
}

describe('imágenes en notas internas', () => {
  const autor = seedUser('Autora Imagen', 'autora.imagen');
  const contactId = seedContact('59170000666@c.us', '59170000666');

  it('guarda la imagen al crear la nota', () => {
    const note = addNote(contactId, autor, null, null, null, [], false, {
      imagePath: '/tmp/nota-inicial.jpg',
      imageMime: 'image/jpeg',
    });
    assert.equal(note.image_path, '/tmp/nota-inicial.jpg');
    assert.equal(note.image_mime, 'image/jpeg');
  });

  it('cambia la imagen y lo registra en el historial', () => {
    const note = addNote(contactId, autor, 'Con imagen', null, null, [], false, {
      imagePath: '/tmp/nota-vieja.jpg',
      imageMime: 'image/jpeg',
    });
    setNoteImage(note.id, autor, '/tmp/nota-nueva.png', 'image/png');
    assert.equal(noteDTO(note.id)?.image_path, '/tmp/nota-nueva.png');
    assert.equal(noteDTO(note.id)?.image_mime, 'image/png');
    const history = listNoteHistory(note.id);
    assert.equal(history[history.length - 1].action, 'image');
    assert.equal(history[history.length - 1].detail, 'Cambió la imagen');
  });

  it('quita la imagen conservando el texto y lo registra', () => {
    const note = addNote(contactId, autor, 'La nota queda con texto', null, null, [], false, {
      imagePath: '/tmp/nota-a-quitar.jpg',
      imageMime: 'image/jpeg',
    });
    setNoteImage(note.id, autor, null, null);
    assert.equal(noteDTO(note.id)?.image_path, null);
    const history = listNoteHistory(note.id);
    assert.equal(history[history.length - 1].action, 'image_removed');
    assert.equal(history[history.length - 1].detail, 'Quitó la imagen');
  });

  it('no permite dejar una nota vacía al quitar su única imagen', () => {
    const note = addNote(contactId, autor, null, null, null, [], false, {
      imagePath: '/tmp/nota-solo-imagen.jpg',
      imageMime: 'image/jpeg',
    });
    assert.throws(() => setNoteImage(note.id, autor, null, null), /no puede quedar vacía/i);
  });
});
