import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { MediaPayload } from '../types.js';
import { typeForMime } from './phone.js';

export interface StoredMedia {
  path: string;
  mime: string;
  content_type: string;
}

/** Extensión de archivo según MIME o nombre original. */
export function extensionFor(mime: string | null, filename?: string | null): string {
  const m = mime ?? '';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('pdf')) return 'pdf';
  if (filename) {
    const ext = path.extname(filename).replace('.', '').toLowerCase();
    if (ext) return ext;
  }
  return 'bin';
}

/**
 * Guarda una media base64 en disco (una sola vez por lote) y devuelve su
 * ruta/mime/tipo. Equivale a `IntegrationController::storeMedia`.
 */
export function storeMedia(media: MediaPayload): StoredMedia {
  const mime = media.mimetype ?? 'application/octet-stream';
  const contents = Buffer.from(media.base64 ?? '', 'base64');
  if (contents.length === 0) throw new Error('base64 inválido.');

  const ext = extensionFor(mime, media.filename);
  const dir = path.resolve(config.storageDir, 'out', new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(file, contents);

  return {
    path: file,
    mime,
    content_type: media.content_type ?? typeForMime(mime),
  };
}

/** Lee una media previamente guardada. */
export function readMedia(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function mediaExists(filePath: string | null | undefined): boolean {
  return !!filePath && fs.existsSync(filePath);
}

/** Carpeta de las notas de voz internas: la retención de media no la toca. */
export const NOTES_MEDIA_DIR = 'notes';

/** Guarda una nota de voz interna (permanente, fuera de la retención). */
export function storeNoteAudio(contents: Buffer, mime: string | null, filename?: string | null): string {
  const ext = extensionFor(mime, filename);
  const dir = path.resolve(config.storageDir, NOTES_MEDIA_DIR, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(file, contents);
  return file;
}

/** Carpeta de las fotos de perfil: la retención de media no la toca. */
export const AVATARS_MEDIA_DIR = 'avatars';

/** Guarda una foto de perfil (permanente, fuera de la retención). */
export function storeAvatar(contents: Buffer, mime: string | null): string {
  const ext = extensionFor(mime, 'avatar.jpg');
  const dir = path.resolve(config.storageDir, AVATARS_MEDIA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(file, contents);
  return file;
}

/** Guarda media entrante (webhook) y devuelve la ruta. */
export function storeIncoming(contents: Buffer, mime: string | null, filename?: string | null): string {
  const ext = extensionFor(mime, filename);
  const dir = path.resolve(config.storageDir, 'in', new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  fs.writeFileSync(file, contents);
  return file;
}
