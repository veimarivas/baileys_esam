import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOptoutRequest, looksLikeBlock, normalizeChatId } from '../src/core/optout.js';

/**
 * Bajas y bloqueos: tienen valor legal y alimentan el anti-baneo (una baja
 * pedida y no respetada es la vía más rápida a un reporte).
 */

describe('isOptoutRequest', () => {
  it('reconoce los pedidos de baja habituales', () => {
    assert.equal(isOptoutRequest('BAJA'), true);
    assert.equal(isOptoutRequest('quiero darme de baja por favor'), true);
    assert.equal(isOptoutRequest('STOP'), true);
    assert.equal(isOptoutRequest('cancelar'), true);
    assert.equal(isOptoutRequest('no molestar'), true);
  });

  it('no confunde palabras que solo empiezan igual', () => {
    assert.equal(isOptoutRequest('bajame el precio'), false);
    assert.equal(isOptoutRequest('eso fue un bajón'), false);
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
