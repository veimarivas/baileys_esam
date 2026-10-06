import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Genera PDFs mínimos (sin dependencias externas): una página por documento con
 * texto plano en Helvetica. Suficiente para estados de cuenta y boletines.
 *
 * Nota: usa solo caracteres latinos; acentos se transliteran para máxima
 * compatibilidad con el encoding base del PDF.
 */

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function translit(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '');
}

/**
 * Construye un PDF a partir de un título y líneas de texto.
 * @returns Buffer del PDF
 */
export function buildPdf(title: string, lines: string[]): Buffer {
  const contentLines: string[] = [];
  let y = 780;
  contentLines.push('BT /F2 16 Tf 56 800 Td (' + escapePdf(translit(title)) + ') Tj ET');
  contentLines.push('BT /F1 11 Tf');
  let body = '';
  for (const line of lines) {
    const wrapped = wrap(translit(line), 88);
    for (const w of wrapped) {
      body += `1 0 0 1 56 ${y} Tm (${escapePdf(w)}) Tj `;
      y -= 16;
      if (y < 60) break;
    }
    if (y < 60) break;
  }
  contentLines.push(body + 'ET');
  const stream = contentLines.join('\n');

  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>');
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'binary');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** Guarda un PDF en storage y devuelve la ruta absoluta. */
export function savePdf(kind: string, ref: string, title: string, lines: string[]): string {
  const dir = path.resolve(config.storageDir, 'pdf', new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${ref}.pdf`);
  fs.writeFileSync(file, buildPdf(title, lines));
  return file;
}

/** Estado de cuenta simple. */
export function statementPdf(customer: {
  name?: string | null;
  ref?: string | number;
  concept?: string | null;
  amount?: number | null;
  currency?: string | null;
  dueDate?: string | null;
}): string {
  const lines = [
    `Cliente: ${customer.name ?? '-'}`,
    `Referencia: ${String(customer.ref ?? '-')}`,
    `Concepto: ${customer.concept ?? '-'}`,
    `Monto: ${customer.currency ?? 'Bs'} ${(customer.amount ?? 0).toFixed(2)}`,
    `Vencimiento: ${customer.dueDate ?? '-'}`,
    '',
    `Generado: ${new Date().toLocaleString('es-BO')}`,
  ];
  return savePdf('estado', String(customer.ref ?? Date.now()), 'ESTADO DE CUENTA', lines);
}

/** Boletín académico simple. */
export function boletinPdf(student: {
  name?: string | null;
  period?: string | null;
  course?: string | null;
  rows?: Array<{ label: string; value: string }>;
}): string {
  const lines = [
    `Participante: ${student.name ?? '-'}`,
    `Periodo: ${student.period ?? '-'}`,
    `Programa/Curso: ${student.course ?? '-'}`,
    '',
    ...(student.rows ?? []).map((r) => `${r.label}: ${r.value}`),
    '',
    `Generado: ${new Date().toLocaleString('es-BO')}`,
  ];
  return savePdf('boletin', `${String(student.name ?? 'alumno')}-${student.period ?? ''}`.replace(/\s+/g, '_'), 'BOLETIN ACADEMICO', lines);
}
