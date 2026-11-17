import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeSendError } from '../src/core/send-errors.js';

describe('describeSendError', () => {
  it('un forbidden en un grupo significa que la línea no está en el grupo', () => {
    const e = describeSendError('Bloqueado: forbidden', '120363425090464551@g.us');
    assert.equal(e.kind, 'group-membership');
    assert.match(e.title, /no está en el grupo/i);
    assert.match(e.action, /Agregá esta línea al grupo/i);
  });

  it('un forbidden en un contacto sí es un bloqueo', () => {
    const e = describeSendError('Bloqueado: forbidden', '59170000001@c.us');
    assert.equal(e.kind, 'blocked');
    assert.match(e.title, /bloqueó la línea/i);
  });

  it('reconoce números sin WhatsApp', () => {
    assert.equal(describeSendError('number not on WhatsApp', '59170000001@c.us').kind, 'no-whatsapp');
    assert.equal(describeSendError('Error 404: not found', '59170000001@c.us').kind, 'no-whatsapp');
  });

  it('separa límites, conexión y archivos', () => {
    assert.equal(describeSendError('Too many requests (429)', '59170000001@c.us').kind, 'rate-limit');
    assert.equal(describeSendError('Connection timed out', '59170000001@c.us').kind, 'connection');
    assert.equal(describeSendError('media upload failed', '59170000001@c.us').kind, 'media');
  });

  it('deja el mensaje original y un texto entendible para casos desconocidos', () => {
    const e = describeSendError('algo raro', '59170000001@c.us');
    assert.equal(e.kind, 'other');
    assert.equal(e.raw, 'algo raro');
    assert.match(e.detail, /algo raro/);
  });
});
