import fs from 'node:fs';
import { config } from '../config.js';

export interface TranscriptionResult {
  ok: boolean;
  text: string | null;
  error: string | null;
}

function enabled(): boolean {
  return !!(config.transcription.apiKey && config.transcription.url);
}

function endpoint(suffix: string): string {
  const base = config.transcription.url.replace(/\/+$/, '');
  return base.endsWith(suffix) ? base : `${base}/${suffix}`;
}

function formatFor(mime: string | null): string {
  const m = mime ?? '';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'mp3';
}

/**
 * Transcribe una nota de voz. Dos backends compatibles con OpenAI:
 * - `chat`: modelo multimodal vía `/chat/completions` (`input_audio`).
 * - `whisper`: `/audio/transcriptions` (multipart).
 */
export async function transcribe(filePath: string, mime: string | null): Promise<TranscriptionResult> {
  if (!enabled()) return { ok: false, text: null, error: 'La transcripción no está configurada.' };
  if (!fs.existsSync(filePath)) return { ok: false, text: null, error: 'El archivo de audio no está disponible.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.transcription.timeoutMs);

  try {
    const text =
      config.transcription.driver === 'whisper'
        ? await viaWhisper(filePath, mime, controller.signal)
        : await viaChat(filePath, mime, controller.signal);
    const clean = (text ?? '').trim();
    if (!clean) return { ok: false, text: null, error: 'No se pudo obtener texto del audio.' };
    return { ok: true, text: clean, error: null };
  } catch (err) {
    return { ok: false, text: null, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function viaWhisper(filePath: string, mime: string | null, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  const buffer = fs.readFileSync(filePath);
  form.append('file', new Blob([buffer], { type: mime ?? 'audio/ogg' }), filePath.split(/[\\/]/).pop() || 'audio.ogg');
  form.append('model', config.transcription.model);
  form.append('language', config.transcription.language);
  form.append('response_format', 'json');

  const res = await fetch(endpoint('audio/transcriptions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.transcription.apiKey}` },
    body: form,
    signal,
  });
  await ensureOk(res, 'Transcripción');
  const data = (await res.json()) as { text?: string };
  return data.text ?? '';
}

async function viaChat(filePath: string, mime: string | null, signal: AbortSignal): Promise<string> {
  const contents = fs.readFileSync(filePath);
  const res = await fetch(endpoint('chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.transcription.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.transcription.model,
      temperature: 0,
      messages: [
        { role: 'system', content: config.transcription.prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe el audio. Devuelve sólo la transcripción.' },
            { type: 'input_audio', input_audio: { data: contents.toString('base64'), format: formatFor(mime) } },
          ],
        },
      ],
    }),
    signal,
  });
  await ensureOk(res, 'Transcripción');
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  }
  return String(content ?? '');
}

async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    const data = (await res.json()) as any;
    detail = data?.error?.message ?? data?.message ?? JSON.stringify(data);
  } catch {
    detail = await res.text().catch(() => '');
  }
  throw new Error(`${label} (${res.status}): ${String(detail).slice(0, 300)}`);
}
