import { get, run } from '../db/index.js';
import { nowIso } from '../util/async.js';

/** Lee un valor de configuración global. */
export function getConfig(key: string): string | null {
  const row = get<{ value: string | null }>('SELECT value FROM configs WHERE key = ?', key);
  return row?.value ?? null;
}

/** Escribe (upsert) un valor de configuración global. */
export function setConfig(key: string, value: string | null): void {
  run(
    `INSERT INTO configs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}
