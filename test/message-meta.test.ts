import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contactMeta,
  contactPreview,
  contactsArrayMeta,
  parseVCard,
  pollMeta,
} from '../src/core/message-meta.js';

/**
 * Los contactos compartidos llegan como vCard y las encuestas como listas de
 * opciones. Si este parseo falla, la tarjeta muestra solo el nombre o pierde el
 * número con el que se puede iniciar la conversación.
 */

describe('parseVCard', () => {
  it('extrae el nombre y el waid del teléfono', () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:;Ana;;;',
      'FN:Ana Pérez',
      'item1.TEL;type=CELL;waid=59179323041:+591 79 323 041',
      'item1.X-ABLabel:Cellular',
      'END:VCARD',
    ].join('\n');
    assert.deepEqual(parseVCard(vcard), { name: 'Ana Pérez', phone: '59179323041' });
  });

  it('usa el teléfono visible cuando no hay waid', () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Luis Gómez',
      'TEL;type=CELL:+591 700-12345',
      'END:VCARD',
    ].join('\n');
    assert.deepEqual(parseVCard(vcard), { name: 'Luis Gómez', phone: '59170012345' });
  });

  it('reconstruye el nombre desde N si falta FN', () => {
    const vcard = 'BEGIN:VCARD\nN:Pérez;Ana;;;\nEND:VCARD';
    assert.deepEqual(parseVCard(vcard), { name: 'Ana Pérez', phone: null });
  });

  it('entiende vCards plegados', () => {
    const vcard = 'BEGIN:VCARD\r\nFN:Ana\r\n Pérez\r\nTEL;waid=59170000000:+591 70 000 000\r\nEND:VCARD';
    assert.deepEqual(parseVCard(vcard), { name: 'AnaPérez', phone: '59170000000' });
  });
});

describe('contactMeta', () => {
  it('prefiere el nombre que muestra WhatsApp', () => {
    const meta = contactMeta('Ana', 'BEGIN:VCARD\nFN:Ana Pérez\nTEL;waid=59179323041:+591 79 323 041\nEND:VCARD');
    assert.deepEqual(meta.contacts, [{ name: 'Ana', phone: '59179323041' }]);
    assert.equal(contactPreview(meta), 'Ana');
  });

  it('resume una lista de varios contactos', () => {
    const meta = contactsArrayMeta([
      { displayName: 'Ana', vcard: 'BEGIN:VCARD\nFN:Ana\nTEL;waid=59170000001:+591 70 000 001\nEND:VCARD' },
      { displayName: 'Luis', vcard: 'BEGIN:VCARD\nFN:Luis\nTEL;waid=59170000002:+591 70 000 002\nEND:VCARD' },
    ]);
    assert.equal(meta.contacts.length, 2);
    assert.equal(contactPreview(meta), 'Ana y 1 más');
  });

  it('no inventa teléfono cuando el vCard no lo trae', () => {
    const meta = contactMeta('Contacto sin número', 'BEGIN:VCARD\nFN:Contacto sin número\nEND:VCARD');
    assert.deepEqual(meta.contacts, [{ name: 'Contacto sin número', phone: null }]);
  });
});

describe('pollMeta', () => {
  it('conserva pregunta, opciones y respuesta única', () => {
    const meta = pollMeta('¿Qué día te queda mejor?', [
      { optionName: 'Lunes' },
      { optionName: 'Martes' },
    ], 1);
    assert.deepEqual(meta, {
      kind: 'poll',
      question: '¿Qué día te queda mejor?',
      options: ['Lunes', 'Martes'],
      selectable_count: 1,
    });
  });

  it('mantiene 0 para encuestas de varias respuestas', () => {
    const meta = pollMeta('Elegí los temas', [{ optionName: 'A' }, { optionName: 'B' }], 0);
    assert.equal(meta.selectable_count, 0);
  });
});
