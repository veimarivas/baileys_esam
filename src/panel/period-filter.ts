/**
 * Períodos de consulta de las listas del panel (lotes y auditoría).
 *
 * La lista se muestra por mes por defecto: el mes en curso. Las pestañas
 * permiten retroceder a meses anteriores o abrir todo el historial, y el
 * rango personalizado se expresa con fechas inclusivas (YYYY-MM-DD).
 */

export type PanelPeriod = 'month' | 'prev' | 'quarter' | 'year' | 'all' | 'custom';

const PERIODS: readonly PanelPeriod[] = ['month', 'prev', 'quarter', 'year', 'all', 'custom'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export interface PanelRange {
  period: PanelPeriod;
  /** Fecha inicial inclusiva (YYYY-MM-DD); vacía en «todo el historial». */
  from: string;
  /** Fecha final inclusiva (YYYY-MM-DD); vacía en «todo el historial». */
  to: string;
  /** Límite inferior para comparar con `created_at` (ISO), o null. */
  fromIso: string | null;
  /** Límite superior exclusivo para comparar con `created_at` (ISO), o null. */
  toIso: string | null;
  label: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(value: unknown): Date | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!DATE_RE.test(raw)) return null;
  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function short(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function isPeriod(value: unknown): value is PanelPeriod {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

/**
 * Resuelve el período pedido. Sin parámetro usa el mes en curso; si llegan
 * fechas sueltas se interpretan como un rango personalizado.
 */
export function resolvePanelRange(
  periodRaw: unknown,
  fromRaw: unknown,
  toRaw: unknown,
  now = new Date(),
): PanelRange {
  const fromDay = parseDay(fromRaw);
  const toDay = parseDay(toRaw);
  const period: PanelPeriod = isPeriod(periodRaw) ? periodRaw : fromDay || toDay ? 'custom' : 'month';

  if (period === 'all') {
    return { period, from: '', to: '', fromIso: null, toIso: null, label: 'Todo el historial' };
  }

  const year = now.getFullYear();
  const month = now.getMonth();
  let start = new Date(year, month, 1);
  let end = new Date(year, month + 1, 1);
  let label = `${cap(MONTHS[month])} ${year}`;

  if (period === 'prev') {
    start = new Date(year, month - 1, 1);
    end = new Date(year, month, 1);
    label = `${cap(MONTHS[start.getMonth()])} ${start.getFullYear()}`;
  } else if (period === 'quarter') {
    start = new Date(year, month - 2, 1);
    end = new Date(year, month + 1, 1);
    const last = new Date(year, month, 1);
    label = start.getFullYear() === last.getFullYear()
      ? `${cap(MONTHS[start.getMonth()])} – ${MONTHS[last.getMonth()]} ${last.getFullYear()}`
      : `${cap(MONTHS[start.getMonth()])} ${start.getFullYear()} – ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
  } else if (period === 'year') {
    start = new Date(year, 0, 1);
    end = new Date(year + 1, 0, 1);
    label = `Año ${year}`;
  } else if (period === 'custom') {
    const rawStart = fromDay ?? toDay ?? new Date(year, month, 1);
    const rawEnd = toDay ?? fromDay ?? new Date();
    const first = rawStart <= rawEnd ? rawStart : rawEnd;
    const last = rawStart <= rawEnd ? rawEnd : rawStart;
    start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
    end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    const firstLabel = short(ymd(start));
    const lastLabel = short(ymd(last));
    label = fromDay && toDay
      ? `Del ${firstLabel} al ${lastLabel}`
      : fromDay
        ? `Desde el ${firstLabel}`
        : `Hasta el ${lastLabel}`;
  }

  const lastInclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  return {
    period,
    from: ymd(start),
    to: ymd(lastInclusive),
    fromIso: start.toISOString(),
    toIso: end.toISOString(),
    label,
  };
}

/** Parámetros de URL que conservan el período elegido. */
export function panelRangeParams(range: PanelRange): Record<string, string> {
  return range.period === 'custom'
    ? { period: 'custom', from: range.from, to: range.to }
    : { period: range.period };
}
