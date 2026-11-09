// Kalibrácia tenzometrov prstov pre konkrétneho človeka a sedenie (namiesto pevného prahu).
//
// Prečo: na záznamoch (tools/recordings/pose_*) má každý prst inú pokojovú hodnotu (-841 … +900) aj inú silu stisku (≈2 300 … 9 700)
// a samotný pohyb zápästia bez stisku zdvihne niektoré prsty na 2 400 – 3 600, teda nad pevný prah |raw| > 1 536. Pevný prah preto
// pre niekoho nikdy nezopne a pre iného zopne už pri pohybe ruky.
//
// Kalibrácia (v okne "Kalibrácia senzora" pri výbere ruky / Rekalibrovať) zmeria pre každý prst:
//   rest   – medián pri uvoľnenej ruke,       noise – rozptyl pri uvoľnenej ruke,
//   motion – p95 pri pohybe zápästia bez stisku, grip  – hodnota pri plnom stisku.
// Prah zopnutia prsta: rest + onFrac·(grip − rest), kde onFrac = max(35 %, výchylka od pohybu + 10 %), najviac 60 %;
// uvoľnenie pri 60 % tejto výšky (hysteréza, aby prst pri hranici neblikal).
// Počas hry sa pokojová hodnota pomaly dolaďuje (drift senzora), len keď je prst jasne uvoľnený, najviac o ±25 % rozsahu.
// Bez kalibrácie platí pôvodné pravidlo |raw| > TENSOMETER_RAW_THRESHOLD alebo |raw|/128 > TENSOMETER_NORM_THRESHOLD.
//
// Stav prstov sa počíta raz na vzorku vo WebSocketStatus a posiela sa v detail.fingers udalosti 'imu-sample'.

import { normalizeAdc } from './imuNormalize';

export const FINGER_COUNT = 5; // adc[1..5]
export type FingerHandKey = 'left' | 'right' | 'default';
export type FingerCal = { rest: number[]; noise: number[]; motion: number[]; grip: number[]; ts: number };
export type FingerState = {
  /** stlačené prsty v poradí kanálov adc[1..5] */
  pressed: boolean[];
  count: number;
  /** 0..1: 0 = pokoj, 1 = kalibrovaný plný stisk (bez kalibrácie hrubý odhad) */
  level: number[];
  /** 0..1: kde leží prah zopnutia na stupnici `level` */
  onLevel: number[];
  calibrated: boolean;
};

const STORAGE_KEY = 'rehapiano.fingerCal.v1';
const ON_FRAC_MIN = 0.35;
const ON_FRAC_MAX = 0.6;  // v otočenej polohe je stisk slabší (46–67 % stisku v zvyčajnej polohe); 0,6 ho ešte zachytí a znižuje falošné stisky od pohybu zápästia
const MOTION_MARGIN = 0.1;
const OFF_RATIO = 0.6;
const MIN_RANGE = 250;            // menší rozdiel stisk − pokoj sa považuje za nespoľahlivý prst
const DRIFT_ALPHA = 1 / (125 * 20); // ~20 s časová konštanta pri 125 Hz
const DRIFT_LIMIT = 0.25;
const DRIFT_ZONE = 0.15;          // dolaďuje sa len pod rest + 15 % rozsahu

export const handKeyOf = (hand: unknown): FingerHandKey => (hand === 'left' || hand === 'right' ? hand : 'default');

let cache: Partial<Record<FingerHandKey, FingerCal>> | null = null;
function readAll(): Partial<Record<FingerHandKey, FingerCal>> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache!;
}
function valid(c: any): c is FingerCal {
  return !!c && ['rest', 'noise', 'motion', 'grip'].every((k) => Array.isArray(c[k]) && c[k].length === FINGER_COUNT && c[k].every(Number.isFinite));
}

export function loadFingerCal(hand: unknown): FingerCal | null {
  const all = readAll();
  const key = handKeyOf(hand);
  const c = all[key] ?? (key !== 'default' ? all.default : undefined); // vzorky bez 'hand' sa kalibrujú pod 'default'
  return valid(c) ? c : null;
}

export function saveFingerCal(hand: unknown, cal: FingerCal) {
  const key = handKeyOf(hand);
  cache = { ...readAll(), [key]: cal };
  runtime[key] = undefined; // nový prah, nová hysteréza a drift od nuly
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // bez localStorage platí kalibrácia aspoň do obnovenia stránky
  }
}

export function clearFingerCal(hand?: unknown) {
  const all = { ...readAll() };
  if (hand === undefined) { cache = {}; for (const k of Object.keys(runtime)) runtime[k as FingerHandKey] = undefined; }
  else { delete all[handKeyOf(hand)]; cache = all; runtime[handKeyOf(hand)] = undefined; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
}

/** Prahové hodnoty pre jeden prst z kalibrácie (bez driftu). */
export function fingerThreshold(cal: FingerCal, i: number) {
  const rest = cal.rest[i];
  const range = Math.max(1, cal.grip[i] - rest);
  const motionFrac = Math.max(0, cal.motion[i] - rest) / range;
  const onFrac = Math.min(ON_FRAC_MAX, Math.max(ON_FRAC_MIN, motionFrac + MOTION_MARGIN));
  return { rest, range, onFrac, offFrac: onFrac * OFF_RATIO, reliable: cal.grip[i] - rest >= Math.max(MIN_RANGE, 6 * cal.noise[i]) };
}

/** Pôvodné pevné pravidlo (bez kalibrácie). */
export function legacyPressed(v: number, cfg?: any) {
  const raw = Math.abs(Number(v) || 0);
  const rawThr = cfg?.TENSOMETER_RAW_THRESHOLD ?? 2000;
  const normThr = cfg?.TENSOMETER_NORM_THRESHOLD ?? 12;
  return raw > rawThr || normalizeAdc(raw) > normThr;
}

type Runtime = { pressed: boolean[]; drift: number[] };
const runtime: Partial<Record<FingerHandKey, Runtime>> = {};

/**
 * Stav prstov pre jednu vzorku. Má stav (hysteréza, drift), preto sa volá raz na vzorku – robí to WebSocketStatus.
 * Hry čítajú výsledok z detail.fingers (pozri pressedCountOf / pressedOf).
 */
export function detectFingers(adc: unknown, hand: unknown, cfg?: any): FingerState {
  const arr = Array.isArray(adc) ? adc : [];
  const vals = Array.from({ length: FINGER_COUNT }, (_, i) => Number(arr[i + 1]) || 0);
  const cal = loadFingerCal(hand);
  if (!cal) {
    const pressed = vals.map((v) => legacyPressed(v, cfg));
    const thr = Math.min(cfg?.TENSOMETER_RAW_THRESHOLD ?? 2000, (cfg?.TENSOMETER_NORM_THRESHOLD ?? 12) * 128);
    return {
      pressed, count: pressed.filter(Boolean).length,
      level: vals.map((v) => Math.min(1, Math.abs(v) / (thr * 2))), onLevel: vals.map(() => 0.5), calibrated: false,
    };
  }
  const key = handKeyOf(hand);
  const rt = (runtime[key] ??= { pressed: new Array(FINGER_COUNT).fill(false), drift: new Array(FINGER_COUNT).fill(0) });
  const level: number[] = [], onLevel: number[] = [];
  for (let i = 0; i < FINGER_COUNT; i++) {
    const t = fingerThreshold(cal, i);
    const rest = t.rest + rt.drift[i];
    const frac = (vals[i] - rest) / t.range;
    if (rt.pressed[i] ? frac < t.offFrac : frac > t.onFrac) rt.pressed[i] = !rt.pressed[i];
    // pomalé doladenie pokoja: len uvoľnený prst blízko pokoja (pohyb zápästia a stisk sa do neho nezapočítajú)
    if (!rt.pressed[i] && frac < DRIFT_ZONE) {
      rt.drift[i] += DRIFT_ALPHA * (vals[i] - rest);
      const lim = DRIFT_LIMIT * t.range;
      rt.drift[i] = Math.max(-lim, Math.min(lim, rt.drift[i]));
    }
    level.push(Math.max(0, Math.min(1, frac)));
    onLevel.push(t.onFrac);
  }
  return { pressed: [...rt.pressed], count: rt.pressed.filter(Boolean).length, level, onLevel, calibrated: true };
}

/** Počet stlačených prstov zo vzorky (detail udalosti 'imu-sample'); ak chýba detail.fingers, pôvodné pevné pravidlo. */
export function pressedCountOf(detail: any, cfg?: any): number {
  const f = detail?.fingers as FingerState | undefined;
  if (f && typeof f.count === 'number') return f.count;
  return pressedOf(detail, cfg).filter(Boolean).length;
}

/** Stlačené prsty v poradí kanálov adc[1..5]. */
export function pressedOf(detail: any, cfg?: any): boolean[] {
  const f = detail?.fingers as FingerState | undefined;
  if (f && Array.isArray(f.pressed)) return f.pressed;
  const arr = Array.isArray(detail?.adc) ? detail.adc : [];
  return Array.from({ length: FINGER_COUNT }, (_, i) => legacyPressed(arr[i + 1], cfg));
}

// ---------- výpočet kalibrácie z nameraných vzoriek ----------
const quantile = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

/** rest/motion/grip: zoznamy vzoriek, každá = 5 hodnôt adc[1..5]. */
export function computeFingerCal(rest: number[][], motion: number[][], grip: number[][]): FingerCal {
  const col = (rows: number[][], i: number) => rows.map((r) => r[i]);
  const out: FingerCal = { rest: [], noise: [], motion: [], grip: [], ts: Date.now() };
  for (let i = 0; i < FINGER_COUNT; i++) {
    const r = col(rest, i);
    const restMed = quantile(r, 0.5);
    out.rest.push(restMed);
    // robustný šum (MAD·1,4826): niekoľko odľahlých vzoriek (dobiehajúce uvoľnenie prstov) ho nenafúkne – (p95 − p05)/2 sa nafúklo až na tisíce
    out.noise.push(Math.max(1, 1.4826 * quantile(r.map((v) => Math.abs(v - restMed)), 0.5)));
    out.motion.push(motion.length ? quantile(col(motion, i), 0.95) : restMed);
    out.grip.push(quantile(col(grip, i), 0.5)); // medián držania: konzervatívny odhad sily stisku
  }
  return out;
}

// Predbežný prah stisku počas kalibrácie. Horná hranica je nutná: slabý prst (na záznamoch prstenník) pri plnom stisku
// dosiahne len ≈ 550–950 nad pokojom, takže prah 6·šum (pri nafúknutom šume aj 5 000 – 6 000) ho nikdy nepustil.
const PROV_MIN = 300;
const PROV_MAX = 500;
const PROV_NOISE_K = 5;
export const provisionalThreshold = (noise: number) => Math.min(PROV_MAX, Math.max(PROV_MIN, PROV_NOISE_K * noise));

/** Predbežné rozpoznanie stisku počas kalibrácie (ešte nie je známa sila stisku): zreteľne nad pokojom. */
export function provisionalPressed(v: number, rest: number, noise: number) {
  return v - rest > provisionalThreshold(noise);
}
