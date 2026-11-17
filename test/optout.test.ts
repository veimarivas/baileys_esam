import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addOptout, isBlocked, isOptoutRequest, looksLikeBlock, normalizeChatId, removeOptout } from '../src/core/optout.js';

/**
 * Bajas y bloqueos: tienen valor legal y alimentan el anti-baneo (una baja
 * pedida y no respetada es la vía más rápida a un reporte).
 */

describe('isOptoutRequest', () => {
  it('reconoce los pedidos de baja habituales', () => {
    assert.equal(isOptoutRequest('BAJA'), true);
    assert.equal(isOptoutRequest('quiero darme de baja por favor'), true);
    assert.equal(isOptoutRequest('STOP'), true);
    assert.equal(isOptoutRequest('solicito la baja del programa'), true);
    assert.equal(isOptoutRequest('no quiero recibir más mensajes'), true);
    assert.equal(isOptoutRequest('no me envíen más'), true);
    assert.equal(isOptoutRequest('cancelar mi inscripción'), true);
    assert.equal(isOptoutRequest('eliminar de la lista'), true);
    assert.equal(isOptoutRequest('no molestar'), true);
  });

  it('no confunde palabras que solo empiezan igual', () => {
    assert.equal(isOptoutRequest('bajame el precio'), false);
    assert.equal(isOptoutRequest('eso fue un bajón'), false);
  });

  it('no toma como baja palabras usadas para pagos, salud o notas', () => {
    assert.equal(isOptoutRequest('cancelar'), false);
    assert.equal(isOptoutRequest('¿cuánto debo cancelar?'), false);
    assert.equal(isOptoutRequest('voy a cancelar y le envío el recibo'), false);
    assert.equal(isOptoutRequest('tengo una baja médica'), false);
    assert.equal(isOptoutRequest('el docente me puso baja nota'), false);
    assert.equal(isOptoutRequest('diplomado en baja y alta tensión'), false);
    assert.equal(isOptoutRequest('dar de baja la factura del IVA'), false);
    assert.equal(isOptoutRequest('para no molestar'), false);
    assert.equal(isOptoutRequest('la carga horaria es muy baja'), false);
    assert.equal(isOptoutRequest('debía salir antes'), false);
  });

  it('con el texto vacío no hay baja', () => {
    assert.equal(isOptoutRequest(''), false);
    assert.equal(isOptoutRequest(null), false);
    assert.equal(isOptoutRequest(undefined), false);
    assert.equal(isOptoutRequest('   '), false);
  });

  it('suma las palabras extra de la política, sin acentos ni mayúsculas', () => {
    assert.equal(isOptoutRequest('Por favor no enviar mas mensajes', 'no enviar'), true);
    assert.equal(isOptoutRequest('DÉJENME EN PAZ', 'dejenme'), true);
    assert.equal(isOptoutRequest('hola, todo bien', 'no enviar'), false);
  });

  it('exige límite de palabra en las palabras extra', () => {
    assert.equal(isOptoutRequest('salirnos de la lista', 'salir'), false);
  });

  it('ignora palabras extra de una sola letra', () => {
    assert.equal(isOptoutRequest('hola', 'x'), false);
  });
});

describe('looksLikeBlock', () => {
  it('detecta los errores típicos de bloqueo o spam', () => {
    assert.equal(looksLikeBlock('Forbidden'), true);
    assert.equal(looksLikeBlock('message blocked by user'), true);
    assert.equal(looksLikeBlock('Error 403: request not authorized'), true);
    assert.equal(looksLikeBlock('spam detected'), true);
    assert.equal(looksLikeBlock('too many requests'), true);
  });

  it('no marca errores que no son bloqueos', () => {
    assert.equal(looksLikeBlock('Connection timed out'), false);
    assert.equal(looksLikeBlock(''), false);
    assert.equal(looksLikeBlock(null), false);
  });
});

describe('normalizeChatId', () => {
  it('deja el chat en forma canónica', () => {
    assert.equal(normalizeChatId('+591 79-123-041'), '59179123041@c.us');
    assert.equal(normalizeChatId('59179323041@c.us'), '59179323041@c.us');
  });

  it('devuelve vacío si no hay dígitos', () => {
    assert.equal(normalizeChatId('abc'), '');
    assert.equal(normalizeChatId(''), '');
  });
});

describe('grupos en la lista de no enviar', () => {
  it('no agrega grupos y no los considera bloqueados', () => {
    const group = '120363425618313194@g.us';
    addOptout(group, 'Fallo de entrega', 'blocked', null);
    assert.equal(isBlocked(group), false);
  });

  it('sigue agregando y quitando números individuales', () => {
    const phone = '59170000001';
    addOptout(phone, 'Prueba', 'manual', null);
    assert.equal(isBlocked(phone), true);
    removeOptout(phone);
    assert.equal(isBlocked(phone), false);
  });
});
