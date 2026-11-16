// Výsledky používateľa (pokrok): skóre kreslenia a časy úrovní Pentomina. Malé záznamy v localStorage pod kľúčom používateľa
// (utils/userScope.ts); ukladajú sa vždy pre prihláseného používateľa, nezávisle od súhlasu so záznamom surových dát z rukavice.
import { scopedKey, currentUserScope } from './userScope';

export type DrawingResult = { t: number; kind: 'drawing'; shape: string; level: number; score: number; accuracy: number; coverage: number; scoring?: 'normal' | 'hard' }; // scoring: len v záznamoch z obdobia s dvoma režimami; 'normal' (zhovievavý, takmer vždy 100) sa do pokroku neráta
export type PentominoResult = { t: number; kind: 'pentomino'; level: number; seconds: number };
export type GameResult = DrawingResult | PentominoResult;

/**
 * Kresba sa počíta ako pokus, len keď je tvar obkreslený celý: aspoň tento podiel obrysu musí mať ťah vo svojej blízkosti.
 * Platí pri ukladaní (ShapeTraceModal) aj pri čítaní: staršie záznamy vznikali z každého ťahu (aj z náhodného stisku
 * s pokrytím pár percent a skóre ~0) a kazili priemery a trend.
 */
export const DRAW_COMPLETE_COVERAGE = 0.6;

const KEY = 'rehapiano.results.v1';
const MAX_RESULTS = 3000; // najstaršie sa zahodia

export function loadResults(): GameResult[] {
  try {
    const list = JSON.parse(localStorage.getItem(scopedKey(KEY)) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && typeof r.t === 'number' && (r.kind === 'drawing' || r.kind === 'pentomino')) : [];
  } catch {
    return [];
  }
}

/** Pridá výsledok prihlásenému používateľovi (bez prihlásenia sa nič neukladá). */
export function addResult(r: GameResult) {
  if (!currentUserScope()) return;
  try {
    const list = loadResults();
    list.push(r);
    localStorage.setItem(scopedKey(KEY), JSON.stringify(list.slice(-MAX_RESULTS)));
  } catch { /* plné úložisko: výsledok sa neuloží */ }
}

export function clearResults() {
  try { localStorage.removeItem(scopedKey(KEY)); } catch { /* ignore */ }
}

const dayOf = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

export type DayPoint = { day: number; value: number; n: number };
/** Priemer hodnoty po dňoch (len dni, v ktorých niečo je), od najstaršieho. */
export function byDay<T extends { t: number }>(rows: T[], value: (r: T) => number): DayPoint[] {
  const m = new Map<number, number[]>();
  for (const r of rows) { const d = dayOf(r.t); (m.get(d) ?? m.set(d, []).get(d)!).push(value(r)); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([day, v]) => ({ day, value: mean(v), n: v.length }));
}

/**
 * Zmena medzi poslednými a predchádzajúcimi pokusmi (priemer posledných `n` mínus priemer `n` pred nimi).
 * null, kým nie je aspoň 2·n pokusov – z pár pokusov sa trend nedá poctivo povedať.
 */
export function recentChange(values: number[], n = 5): number | null {
  if (values.length < 2 * n) return null;
  return mean(values.slice(-n)) - mean(values.slice(-2 * n, -n));
}

export type Progress = {
  drawing: { count: number; best: number | null; bestByShape: { shape: string; best: number; count: number }[]; days: DayPoint[]; change: number | null };
  pentomino: { count: number; bestByLevel: { level: number; best: number; count: number }[]; days: DayPoint[]; change: number | null };
};

export function summarize(results: GameResult[]): Progress {
  const dr = results.filter((r): r is DrawingResult => r.kind === 'drawing' && r.coverage >= DRAW_COMPLETE_COVERAGE && r.scoring !== 'normal').sort((a, b) => a.t - b.t);
  const pe = results.filter((r): r is PentominoResult => r.kind === 'pentomino').sort((a, b) => a.t - b.t);
  const shapes = new Map<string, number[]>();
  for (const r of dr) (shapes.get(r.shape) ?? shapes.set(r.shape, []).get(r.shape)!).push(r.score);
  const levels = new Map<number, number[]>();
  for (const r of pe) (levels.get(r.level) ?? levels.set(r.level, []).get(r.level)!).push(r.seconds);
  // Časy Pentomina sa medzi úrovňami líšia, preto sa trend počíta z pomeru k najlepšiemu času danej úrovne (1 = osobný rekord)
  const bestTime = new Map([...levels.entries()].map(([l, v]) => [l, Math.min(...v)]));
  const rel = (r: PentominoResult) => r.seconds / Math.max(1, bestTime.get(r.level)!);
  return {
    drawing: {
      count: dr.length,
      best: dr.length ? Math.max(...dr.map((r) => r.score)) : null,
      bestByShape: [...shapes.entries()].map(([shape, v]) => ({ shape, best: Math.max(...v), count: v.length })),
      days: byDay(dr, (r) => r.score),
      change: recentChange(dr.map((r) => r.score)),
    },
    pentomino: {
      count: pe.length,
      bestByLevel: [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([level, v]) => ({ level, best: Math.min(...v), count: v.length })),
      days: byDay(pe, (r) => r.seconds),
      change: recentChange(pe.map(rel)),
    },
  };
}
