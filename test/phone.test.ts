import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chatIdFor,
  digits,
  extractInviteCode,
  isGroupJid,
  normalizePhone,
  phoneFromChatId,
  phoneFromJid,
  typeForMime,
} from '../src/core/phone.js';

/**
 * Normalización de teléfonos y JIDs. Es la base de todo: un error acá manda el
 * mensaje al número equivocado o duplica contactos. `src/core/phone.ts` no toca
 * la base, así que estas pruebas corren aisladas.
 */

describe('digits', () => {
  it('deja solo los dígitos', () => {
    assert.equal(digits('+591 79-123-041'), '59179123041');
    assert.equal(digits('(591) 79323041'), '59179323041');
  });

  it('devuelve cadena vacía sin datos', () => {
    assert.equal(digits(''), '');
    assert.equal(digits(null), '');
    assert.equal(digits(undefined), '');
    assert.equal(digits('sin números'), '');
  });
});

describe('normalizePhone', () => {
  it('antepone 591 a un móvil boliviano de 8 dígitos', () => {
    assert.equal(normalizePhone('79323041'), '59179323041');
    assert.equal(normalizePhone('79-323-041'), '59179323041');
  });

  it('respeta un número que ya trae el país', () => {
    assert.equal(normalizePhone('59179323041'), '59179323041');
    assert.equal(normalizePhone('+591 79323041'), '59179323041');
  });

  it('no rompe con vacíos', () => {
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), '');
  });
});

describe('chatIdFor', () => {
  it('construye el chat individual', () => {
    assert.equal(chatIdFor('59179323041'), '59179323041@c.us');
    assert.equal(chatIdFor('+591 79323041'), '59179323041@c.us');
  });
});

describe('isGroupJid', () => {
  it('distingue grupos de individuales', () => {
    assert.equal(isGroupJid('59179323041-1605049170@g.us'), true);
    assert.equal(isGroupJid('59179323041@c.us'), false);
    assert.equal(isGroupJid('123@lid'), false);
    assert.equal(isGroupJid(null), false);
  });
});

describe('phoneFromJid', () => {
  it('extrae el número del JID', () => {
    assert.equal(phoneFromJid('59179323041@s.whatsapp.net'), '59179323041');
    assert.equal(phoneFromJid('59179323041@c.us'), '59179323041');
  });

  it('quita el sufijo de dispositivo (:NN)', () => {
    assert.equal(phoneFromJid('59179323041:12@s.whatsapp.net'), '59179323041');
  });

  it('vacío sin JID', () => {
    assert.equal(phoneFromJid(''), '');
    assert.equal(phoneFromJid(null), '');
  });
});

describe('phoneFromChatId', () => {
  it('devuelve el número de un chat individual', () => {
    assert.equal(phoneFromChatId('59179323041@c.us'), '59179323041');
  });

  it('no inventa número para chats anónimos, grupos ni estados', () => {
    assert.equal(phoneFromChatId('123456@lid'), '');
    assert.equal(phoneFromChatId('59179323041-1605049170@g.us'), '');
    assert.equal(phoneFromChatId('status@broadcast'), '');
    assert.equal(phoneFromChatId(''), '');
  });
});

describe('typeForMime', () => {
  it('clasifica por familia de MIME', () => {
    assert.equal(typeForMime('image/jpeg'), 'image');
    assert.equal(typeForMime('image/webp'), 'image');
    assert.equal(typeForMime('video/mp4'), 'video');
    assert.equal(typeForMime('audio/ogg; codecs=opus'), 'audio');
    assert.equal(typeForMime('application/pdf'), 'document');
    assert.equal(typeForMime('text/plain'), 'document');
  });
});

describe('extractInviteCode', () => {
  it('saca el código del enlace de invitación', () => {
    assert.equal(extractInviteCode('https://chat.whatsapp.com/AbC123xyz'), 'AbC123xyz');
    assert.equal(extractInviteCode('chat.whatsapp.com/AbC123xyz'), 'AbC123xyz');
  });

  it('acepta el código pelado y limpia separadores', () => {
    assert.equal(extractInviteCode('AbC-123'), 'AbC123');
    assert.equal(extractInviteCode('  AbC123xyz  '), 'AbC123xyz');
  });
});
