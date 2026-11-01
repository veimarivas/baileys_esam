import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Push a la app: tokens por usuario, a quién le llega un mensaje de una línea y
 * el envío a Firebase (con un `fetch` simulado y una clave generada aquí).
 */
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const saFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-')), 'sa.json');
fs.writeFileSync(saFile, JSON.stringify({
  project_id: 'esam-test',
  client_email: 'push@esam-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.example.test/token',
}));
process.env.FCM_SERVICE_ACCOUNT = saFile;

const { registerDevice, deviceTokens, lineUserIds, sendPush, pushEnabled, removeDevice } = await import('../src/core/push.js');
const { upsertUser } = await import('../src/auth/users.js');
const { get, run } = await import('../src/db/index.js');
const { nowIso } = await import('../src/util/async.js');

upsertUser({ sourceUid: 'p-ana', name: 'Ana', username: 'p-ana', email: 'p-ana@t.local', source: 'cronogramas', autorizado: true, roles: [], numero: '59170001111' });
const ana = get<{ id: number }>("SELECT id FROM users WHERE source_uid = 'p-ana'")!.id;
run("INSERT INTO sessions (id, name, owner_uid, expected_phone, status, created_at, updated_at) VALUES ('p-line', 'p-line', NULL, '59170001111', 'ready', ?, ?)", nowIso(), nowIso());

describe('push a la app móvil', () => {
  it('registra el token una sola vez y lo reasigna al cambiar de cuenta', () => {
    registerDevice(ana, 'tok-1', 'android');
    registerDevice(ana, 'tok-1', 'android');
    assert.equal(deviceTokens([ana]).length, 1);
    assert.throws(() => registerDevice(ana, '  ', 'android'));
  });

  it('los mensajes de una línea van a quien tiene ese número', () => {
    assert.deepEqual(lineUserIds('p-line'), [ana]);
    assert.deepEqual(lineUserIds('no-existe'), []);
  });

  it('envía a Firebase con OAuth y olvida los tokens que ya no existen', async () => {
    assert.equal(pushEnabled(), true);
    registerDevice(ana, 'tok-viejo', 'android');
    const calls: Array<{ url: string; body: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 });
      if (String(init.body).includes('tok-viejo')) return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const n = await sendPush([ana], { title: 'Hola', body: 'Mensaje', tag: 'chat:1', data: { type: 'chat' }, channel: 'mensajes' });
      assert.equal(n, 1);
      const oauth = calls.find((c) => c.url.includes('oauth2'))!;
      assert.match(oauth.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
      const msg = JSON.parse(calls.find((c) => c.body.includes('tok-1'))!.body);
      assert.equal(msg.message.android.notification.tag, 'chat:1');
      assert.equal(msg.message.android.notification.channel_id, 'mensajes');
      assert.deepEqual(deviceTokens([ana]).map((d) => d.token), ['tok-1']);
    } finally {
      globalThis.fetch = realFetch;
    }
    removeDevice('tok-1');
    assert.equal(deviceTokens([ana]).length, 0);
  });
});
