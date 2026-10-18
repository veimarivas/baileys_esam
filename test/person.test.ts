import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { personTagsByKeys, phoneKeyOf, setPersonName, tagPerson } from '../src/core/person.js';

/**
 * `phone_key`: la clave que une a una persona entre líneas. Si se calcula mal,
 * el nombre y los programas se pierden o se mezclan dos personas distintas.
 */

describe('phoneKeyOf', () => {
  it('extrae los dígitos del JID', () => {
    assert.equal(phoneKeyOf('59179323041@c.us'), '59179323041');
    assert.equal(phoneKeyOf('59179323041@s.whatsapp.net'), '59179323041');
  });

  it('antepone 591 a un móvil de 8 dígitos', () => {
    assert.equal(phoneKeyOf('79323041'), '59179323041');
  });

  it('quita el prefijo internacional 00', () => {
    assert.equal(phoneKeyOf('0059179323041'), '59179323041');
  });

  it('acepta un chat anónimo (@lid) por sus dígitos', () => {
    assert.equal(phoneKeyOf('123456789@lid'), '123456789');
  });

  it('devuelve null sin dígitos', () => {
    assert.equal(phoneKeyOf(''), null);
    assert.equal(phoneKeyOf(null), null);
    assert.equal(phoneKeyOf(undefined), null);
    assert.equal(phoneKeyOf('sin-numero'), null);
  });
});

describe('tagPerson / personTagsByKeys', () => {
  it('guarda el nombre completo y el programa de la persona', () => {
    tagPerson('59179323041@c.us', { fullName: 'Juan Pérez', programa: 'MAT', programaId: 4, sessionId: 's1' });
    const tags = personTagsByKeys(['59179323041']).get('59179323041');
    assert.ok(tags);
    assert.equal(tags.full_name, 'Juan Pérez');
    assert.equal(tags.name_source, 'cronogramas');
    assert.deepEqual(tags.programas, ['MAT']);
  });

  it('acumula varios programas de la misma persona', () => {
    tagPerson('59179323041@c.us', { fullName: 'Juan Pérez', programa: 'INF' });
    const tags = personTagsByKeys(['59179323041']).get('59179323041');
    assert.deepEqual(tags?.programas.slice().sort(), ['INF', 'MAT']);
  });

  it('ignora los grupos (no representan a una persona)', () => {
    tagPerson('123456-1605049170@g.us', { fullName: 'Grupo X', programa: 'MAT' });
    // La clave que le correspondería a ese JID queda sin datos.
    assert.equal(personTagsByKeys(['1234561605049170']).size, 0);
  });

  it('un nombre escrito a mano en el panel gana al de cronogramas', () => {
    setPersonName('59179323041', 'Juan P.', 7);
    const tags = personTagsByKeys(['59179323041']).get('59179323041');
    assert.equal(tags?.full_name, 'Juan P.');
    assert.equal(tags?.name_source, 'manual');
  });

  it('borrar el nombre a mano deja de nuevo el de cronogramas', () => {
    setPersonName('59179323041', null, 7);
    const tags = personTagsByKeys(['59179323041']).get('59179323041');
    assert.equal(tags?.full_name, 'Juan Pérez');
    assert.equal(tags?.name_source, 'cronogramas');
  });

  it('devuelve un mapa vacío si no hay claves', () => {
    assert.equal(personTagsByKeys([]).size, 0);
    assert.equal(personTagsByKeys([null, undefined, '']).size, 0);
  });
});
