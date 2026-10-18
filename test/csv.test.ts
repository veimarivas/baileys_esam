import './helpers/temp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { importCsvToBatch, parseCsv } from '../src/core/csv.js';
import { testDir } from './helpers/temp-env.js';

/**
 * Importación de destinatarios por CSV: es la puerta de entrada de los lotes,
 * así que un error de parseo manda mensajes a números mal armados o los pierde.
 */

describe('parseCsv', () => {
  it('separa filas y columnas', () => {
    assert.deepEqual(parseCsv('a,b\n1,2'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('respeta comas dentro de comillas', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y",2'), [
      ['a', 'b'],
      ['x, y', '2'],
    ]);
  });

  it('desescapa comillas dobles', () => {
    assert.deepEqual(parseCsv('a,b\n"dijo ""hola""",2'), [
      ['a', 'b'],
      ['dijo "hola"', '2'],
    ]);
  });

  it('acepta saltos de línea dentro de un campo entrecomillado', () => {
    assert.deepEqual(parseCsv('a,b\n"linea1\nlinea2",2'), [
      ['a', 'b'],
      ['linea1\nlinea2', '2'],
    ]);
  });

  it('ignora los CR y las filas vacías', () => {
    assert.deepEqual(parseCsv('a,b\r\n\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('no agrega una fila por el salto final', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

/** Crea un CSV temporal y devuelve su ruta. */
function csvFile(name: string, content: string): string {
  const file = path.join(testDir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

interface Item {
  chat_id: string;
  contact_name: string | null;
  variables: Record<string, unknown>;
}

/** Captura lo que se le pasa a `createBatch` sin tocar la base. */
function collector(): { items: Item[]; meta: Record<string, unknown> | null } {
  return { items: [], meta: null };
}

describe('importCsvToBatch', () => {
  it('mapea encabezados, quita el BOM y arma las variables de plantilla', () => {
    const state = collector();
    const file = csvFile(
      'ok.csv',
      '\uFEFFphone,nombre,programa,total\r\n59179323041,Juan Pérez,MAT,150\r\n59171234567,Ana,INF,\r\n',
    );
    const res = importCsvToBatch(file, { name: 'Lote X', category: 'cobranza' }, (payload) => {
      state.items = payload.items as Item[];
      state.meta = payload.meta;
      return 7;
    });

    assert.equal(res.batchId, 7);
    assert.equal(res.total, 2);
    assert.equal(res.skipped, 0);
    assert.deepEqual(res.errors, []);
    assert.equal(state.items.length, 2);
    assert.deepEqual(state.items[0], {
      chat_id: '59179323041@c.us',
      contact_name: 'Juan Pérez',
      variables: { programa: 'MAT', total: '150' },
    });
    // Las variables vacías no se envían a la plantilla.
    assert.deepEqual(state.items[1], {
      chat_id: '59171234567@c.us',
      contact_name: 'Ana',
      variables: { programa: 'INF' },
    });
    assert.equal(state.meta?.source, 'csv');
  });

  it('respeta `chat_id` cuando viene en el CSV', () => {
    const state = collector();
    const file = csvFile('chatid.csv', 'chat_id,nombre\n59179323041@c.us,Directo\n');
    const res = importCsvToBatch(file, {}, (payload) => {
      state.items = payload.items as Item[];
      return 1;
    });
    assert.equal(res.total, 1);
    assert.equal(state.items[0].chat_id, '59179323041@c.us');
  });

  it('cuenta las filas sin teléfono', () => {
    const file = csvFile('skip.csv', 'phone,nombre\n,sin número\n59179323041,Juan\n');
    const res = importCsvToBatch(file, {}, () => 3);
    assert.equal(res.total, 1);
    assert.equal(res.skipped, 1);
  });

  it('avisa cuando no hay ninguna fila válida', () => {
    const file = csvFile('empty.csv', 'phone,nombre\n');
    const res = importCsvToBatch(file, {}, () => 3);
    assert.equal(res.batchId, null);
    assert.equal(res.total, 0);
    assert.ok(res.errors.length > 0);
  });

  it('avisa cuando el archivo no existe', () => {
    const res = importCsvToBatch(path.join(testDir, 'no-existe.csv'), {}, () => 3);
    assert.equal(res.batchId, null);
    assert.deepEqual(res.errors, ['No existe el archivo.']);
  });
});
