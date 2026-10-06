import { randInt } from '../util/async.js';

/** Opciones de pacing resueltas desde la politica anti-baneo. */
export interface PacingOptions {
  enabled: boolean;
  /** Delay aleatorio minimo/maximo entre envios (segundos). */
  delayMin: number;
  delayMax: number;
  /** Dias ISO permitidos (1=lunes ... 7=domingo). */
  windowDays: number[];
  windowStart: string;
  windowEnd: string;
  /** Enfriamiento al cambiar de programa (minutos). */
  programCooldownMinutes: number;
  /** Pausa larga cada `pauseEvery` envios para simular fatiga humana. */
  pausesEnabled: boolean;
  pauseEvery: number;
  pauseMin: number;
  pauseMax: number;
}

function parseHM(value: string): number {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 8 * 60;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Día ISO: 1=lunes ... 7=domingo. */
function isoDay(date: Date): number {
  const js = date.getDay(); // 0=domingo
  return js === 0 ? 7 : js;
}

/**
 * Motor anti-baneo: jitter aleatorio, ventana horaria/días de envío, pausas por
 * fatiga y enfriamiento entre programas.
 */
export class Pacing {
  private static lastProgram = new Map<string, { programKey: string; at: number }>();

  constructor(
    private readonly sessionId: string,
    private readonly opts: PacingOptions,
  ) {}

  enabled(): boolean {
    return this.opts.enabled;
  }

  isWithinWindow(date = new Date()): boolean {
    if (!this.opts.enabled) return true;
    if (!this.opts.windowDays.includes(isoDay(date))) return false;
    const start = parseHM(this.opts.windowStart);
    const end = parseHM(this.opts.windowEnd);
    const minutes = date.getHours() * 60 + date.getMinutes();
    if (start === end) return true;
    if (start < end) return minutes >= start && minutes < end;
    // Ventana que cruza medianoche (ej. 08:00 → 01:00): activa de noche.
    return minutes >= start || minutes < end;
  }

  /** Próximo instante válido dentro de la ventana (epoch ms). */
  nextWindowStartMs(fromMs: number): number {
    const startMin = parseHM(this.opts.windowStart);
    const base = new Date(fromMs);
    for (let add = 0; add < 8; add++) {
      const cand = new Date(base);
      cand.setDate(base.getDate() + add);
      cand.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (cand.getTime() <= fromMs) continue;
      if (this.opts.windowDays.includes(isoDay(cand))) return cand.getTime();
    }
    return fromMs + 3600_000;
  }

  secondsUntilNextWindow(fromMs = Date.now()): number {
    return Math.max(1, Math.round((this.nextWindowStartMs(fromMs) - fromMs) / 1000));
  }

  private jitterMs(): number {
    return randInt(this.opts.delayMin, this.opts.delayMax) * 1000;
  }

  private pauseMs(): number {
    return randInt(this.opts.pauseMin, this.opts.pauseMax) * 1000;
  }

  /**
   * Espera (ms) antes del envío `sentSoFar` + 1 de un lote: enfriamiento al
   * cambiar de programa en el primero, y luego jitter o pausa por fatiga.
   *
   * Se calcula en cada envío (no como plan previo): un plan de instantes fijos
   * queda en el pasado tras una pausa, un límite horario o la espera de la
   * ventana, y los envíos siguientes salían en ráfaga sin separación.
   */
  delayBeforeMs(sentSoFar: number, programKey?: string): number {
    if (sentSoFar === 0) {
      let wait = 0;
      if (programKey) {
        const prev = Pacing.lastProgram.get(this.sessionId);
        if (this.enabled() && prev && prev.programKey !== programKey) {
          wait = this.opts.programCooldownMinutes * 60 * 1000;
        }
        Pacing.lastProgram.set(this.sessionId, { programKey, at: Date.now() + wait });
      }
      return wait;
    }
    if (!this.enabled()) return 1000;
    const fatigue = this.opts.pausesEnabled && this.opts.pauseEvery > 0 && sentSoFar % this.opts.pauseEvery === 0;
    return fatigue ? this.pauseMs() : this.jitterMs();
  }
}
