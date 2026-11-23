// Čas medzi vzorkami rukavice podľa hodín streamera, nie prehliadača.
//
// Prečo: hry brali dt z Date.now() v okamihu spracovania udalosti. Keď je prehliadač zaneprázdnený (React, kreslenie), správy
// z WebSocketu prídu v dávkach: prvá vzorka dávky dostala dt = celá pauza, ďalšie ~0 (orezané na 1 ms), hoci senzor ich meral
// rovnomerne po ~8 ms. Streamer posiela pri každej vzorke čas zachytenia:
//   sys_mono – monotónne hodiny streamera (s), na zázname pose_20261102 nikdy necúvajú  -> používa sa prednostne
//   ts       – epochový čas (s); na tom istom zázname 156× skočil dozadu (nevhodný na rozdiely, len záloha)
// Bez oboch (starší streamer) platí čas prehliadača ako doteraz.
//
// Opakované kvaternióny (fúzia senzora beží pomalšie ako stream, ~17 % vzoriek) sa zámerne NEzahadzujú: ADC prstov je v každej
// z nich nové a EMA polohy v kontroléri ich vyrovná.

/** Hranice dt (s). Horná: po výpadku (pauza sekundy) sa nemá integrovať posledná rýchlosť gyra cez celú pauzu. */
export const SAMPLE_DT_MIN = 0.001;
export const SAMPLE_DT_MAX = 0.1;

const clampDt = (s: number) => Math.max(SAMPLE_DT_MIN, Math.min(SAMPLE_DT_MAX, s));

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type Last = { mono: number | null; ts: number | null; host: number };

/** Počíta dt pre každé zariadenie zvlášť (dve rukavice = dva prúdy vzoriek s vlastným časom). */
export class SampleClock {
  private last = new Map<string, Last>();

  /**
   * dt (s) od predchádzajúcej vzorky toho istého zariadenia. Prvá vzorka zariadenia: null (volajúci použije vlastný odhad).
   * `msg` = rozparsovaná správa streamera, `hostNowMs` = čas prehliadača (záloha, keď streamer čas neposiela).
   */
  dt(msg: any, hostNowMs: number): number | null {
    const key = String(msg?.port ?? msg?.hand ?? 'default');
    const mono = finite(msg?.sys_mono);
    const ts = finite(msg?.ts);
    const prev = this.last.get(key);
    this.last.set(key, { mono, ts, host: hostNowMs });
    if (!prev) return null;
    let d: number | null = null;
    if (mono !== null && prev.mono !== null && mono > prev.mono) d = mono - prev.mono;
    else if (mono === null && ts !== null && prev.ts !== null && ts > prev.ts) d = ts - prev.ts;
    if (d === null || d > 5) d = (hostNowMs - prev.host) / 1000; // hodiny streamera chýbajú / cúvli / reštart streamera
    return clampDt(d);
  }

  /** Zabudne všetky zariadenia (nové spojenie: čas streamera mohol začať odznova). */
  reset() { this.last.clear(); }
}

/**
 * dt (s) pre spracovanie vzorky v hre: z hodín streamera (detail.dt z WebSocketStatus), inak z času prehliadača ako doteraz
 * (`fallbackMs` = rozdiel Date.now() od poslednej vzorky).
 */
export function sampleDt(detail: any, fallbackMs: number): number {
  const d = detail?.dt;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return Math.max(1, fallbackMs) / 1000;
}
