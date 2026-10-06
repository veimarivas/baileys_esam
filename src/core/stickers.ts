import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { nowIso } from '../util/async.js';
import { logger } from '../logger.js';

export interface StickerRow {
  id: number;
  name: string;
  media_path: string;
  media_mime: string;
  size: number;
  active: number;
  created_at: string;
}

/** Convierte una imagen en sticker WebP 512×512 (fondo transparente). */
export async function makeSticker(contents: Buffer, name: string): Promise<StickerRow> {
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error('No se pudo cargar sharp para generar el sticker.');
  }

  const webp = await sharp(contents)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 })
    .toBuffer();

  const dir = path.resolve(config.storageDir, 'stickers', new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.webp`);
  fs.writeFileSync(file, webp);

  const created = run(
    'INSERT INTO stickers (name, media_path, media_mime, size, active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    name || 'sticker',
    file,
    'image/webp',
    webp.length,
    nowIso(),
  );
  logger.info({ sticker: created.lastInsertRowid }, 'Sticker creado');
  return get<StickerRow>('SELECT * FROM stickers WHERE id = ?', created.lastInsertRowid)!;
}

export function listStickers(): StickerRow[] {
  return all<StickerRow>('SELECT * FROM stickers ORDER BY id DESC');
}

export function activeStickers(): StickerRow[] {
  return all<StickerRow>('SELECT * FROM stickers WHERE active = 1 ORDER BY id DESC');
}

export function getSticker(id: number): StickerRow | undefined {
  return get<StickerRow>('SELECT * FROM stickers WHERE id = ?', id);
}

export function toggleSticker(id: number): void {
  run('UPDATE stickers SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?', id);
}

export function deleteSticker(id: number): void {
  const row = getSticker(id);
  if (row) {
    try {
      fs.rmSync(row.media_path, { force: true });
    } catch {
      // ignore
    }
  }
  run('DELETE FROM stickers WHERE id = ?', id);
}
