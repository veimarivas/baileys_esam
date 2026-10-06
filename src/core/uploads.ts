import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/** Guarda un archivo subido (base64 o multipart) en storage/uploads. */
export function saveUpload(originalName: string, contents: Buffer): string {
  const dir = path.resolve(config.storageDir, 'uploads', new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const safeExt = path.extname(originalName).replace(/[^.a-z0-9]/gi, '').slice(0, 8) || '.csv';
  const file = path.join(dir, `${randomUUID()}${safeExt}`);
  fs.writeFileSync(file, contents);
  return file;
}
