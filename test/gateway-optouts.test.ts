import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { SessionManager } from '../src/baileys/manager.js';
import { addOptout } from '../src/core/optout.js';
import { createGatewayApp } from '../src/gateway/server.js';

/**
 * El opt-out en la API del gateway (B4 del plan del CRM).
 *
 * Antes solo el motor de lotes de este servicio miraba la lista de «no
 * enviar»; lo que llegaba por la API —que es lo que usa el CRM— salía igual.
 * Estos tests fijan la segunda barrera y la sincronización.
 *
 * El manager es un doble: lo único que importa acá es si se le pidió enviar o
 * no, y un manager real abriría sesiones de WhatsApp.
 */
describe('gateway: opt-out en la API', () => {
  const enviados: Array<{ chatId: string; text: string }> = [];
  const manager = {
    list: () => [],
    sendText: async (_sessionId: string, chatId: string, text: string) => {
      enviados.push({ chatId, text });
      return { messageId: `OUT-${enviados.length}` };
    },
    sendMedia: async (_sessionId: string, chatId: string) => {
      enviados.push({ chatId, text: '[media]' });
      return { messageId: `OUT-${enviados.length}` };
    },
  } as unknown as SessionManager;

  let base = '';
  let server: ReturnType<ReturnType<typeof createGatewayApp>['listen']>;

  before(async () => {
    const app = createGatewayApp(manager);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('un masivo a quien pidió la baja no sale y se informa con 409', async () => {
    addOptout('59170000111@c.us', 'Solicitó la baja', 'reply', 'linea-1');
    const antes = enviados.length;

    const res = await post('/api/sessions/linea-1/messages/send-text', {
      chatId: '59170000111@c.us',
      text: 'promo',
      bulk: true,
    });

    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { blocked: boolean }).blocked, true);
    assert.equal(enviados.length, antes, 'no se le tenía que pedir al manager que enviara');
  });

  it('una respuesta 1:1 a quien pidió la baja SÍ sale', async () => {
    // Pidió no recibir publicidad, no que lo ignoren: si escribe, se le
    // contesta. Sin `bulk` el gateway no puede saber que es un masivo.
    addOptout('59170000222@c.us', 'Solicitó la baja', 'reply', 'linea-1');

    const res = await post('/api/sessions/linea-1/messages/send-text', {
      chatId: '59170000222@c.us',
      text: 'te respondo lo que preguntaste',
    });

    assert.equal(res.status, 200);
    assert.ok(enviados.some((e) => e.chatId === '59170000222@c.us'));
  });

  it('la barrera también aplica a los adjuntos masivos', async () => {
    addOptout('59170000333@c.us', 'Solicitó la baja', 'reply', 'linea-1');

    const res = await post('/api/sessions/linea-1/messages/send-image', {
      chatId: '59170000333@c.us',
      base64: Buffer.from('imagen').toString('base64'),
      mimetype: 'image/jpeg',
      bulk: true,
    });

    assert.equal(res.status, 409);
  });

  it('un masivo a quien NO pidió la baja sale normal', async () => {
    const res = await post('/api/sessions/linea-1/messages/send-text', {
      chatId: '59170000444@c.us',
      text: 'promo',
      bulk: true,
    });

    assert.equal(res.status, 200);
  });

  it('el CRM puede registrar una baja y después leerla', async () => {
    const alta = await post('/api/sessions/linea-1/optouts', { chatId: '+591 70000555', reason: 'Lo pidió por el CRM' });
    assert.equal(alta.status, 201);
    // Se normaliza a la forma canónica, igual que las bajas propias.
    assert.equal(((await alta.json()) as { chatId: string }).chatId, '59170000555@c.us');

    const lista = (await (await fetch(`${base}/api/sessions/linea-1/optouts`)).json()) as Array<{ chatId: string; source: string }>;
    const fila = lista.find((r) => r.chatId === '59170000555@c.us');
    assert.ok(fila);
    assert.equal(fila?.source, 'crm');
  });

  it('since devuelve solo lo nuevo', async () => {
    const corte = new Date(Date.now() + 1000).toISOString();
    const lista = (await (await fetch(`${base}/api/sessions/linea-1/optouts?since=${encodeURIComponent(corte)}`)).json()) as unknown[];

    // Nada se creó después de un instante en el futuro.
    assert.equal(lista.length, 0);
  });

  it('un chatId inválido se rechaza', async () => {
    const res = await post('/api/sessions/linea-1/optouts', { chatId: 'sin-digitos' });
    assert.equal(res.status, 422);
  });
});
