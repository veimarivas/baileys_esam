/** Espera asincrona. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Entero aleatorio en [min, max]. */
export function randInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/** Fecha/hora en ISO para columnas TEXT de SQLite. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Segundos epoch. */
export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}
