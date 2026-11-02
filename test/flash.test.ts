import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { FLASH_COOKIE, setFlash, takeFlash } from '../src/panel/flash.js';

function req(cookie?: string): Request {
  return {
    secure: false,
    header(name: string) {
      return name.toLowerCase() === 'cookie' ? cookie : undefined;
    },
  } as unknown as Request;
}

function res(target: Request): Response & { cookies: string[] } {
  const cookies: string[] = [];
  return {
    req: target,
    cookies,
    append(name: string, value: string) {
      if (name.toLowerCase() === 'set-cookie') cookies.push(value);
      return this;
    },
  } as unknown as Response & { cookies: string[] };
}

function cookieFrom(raw: string): string {
  return raw.split(';')[0];
}

describe('avisos firmados', () => {
  it('guarda y consume un aviso una sola vez', () => {
    const r1 = req();
    const w1 = res(r1);
    setFlash(w1, 'ok', 'Plantilla guardada.');
    assert.equal(w1.cookies.length, 1);
    assert.match(w1.cookies[0], new RegExp(`^${FLASH_COOKIE}=`));

    const r2 = req(cookieFrom(w1.cookies[0]));
    const w2 = res(r2);
    const flash = takeFlash(r2, w2);
    assert.deepEqual(flash && { kind: flash.kind, message: flash.message }, { kind: 'ok', message: 'Plantilla guardada.' });
    assert.match(w2.cookies[0], /Max-Age=0/);
  });

  it('rechaza una firma manipulada', () => {
    const r1 = req();
    const w1 = res(r1);
    setFlash(w1, 'error', 'No se pudo guardar.');
    const tampered = cookieFrom(w1.cookies[0]).replace(/\.$/, '') + 'x';
    const r2 = req(tampered);
    const w2 = res(r2);
    assert.equal(takeFlash(r2, w2), null);
  });

  it('ignora mensajes vacíos', () => {
    const r1 = req();
    const w1 = res(r1);
    setFlash(w1, 'ok', '   ');
    assert.equal(w1.cookies.length, 0);
  });
});
