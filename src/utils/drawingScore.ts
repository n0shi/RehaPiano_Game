// Hodnotenie kresby v "Skúške kreslenia" (ShapeTraceModal): obrys tvaru a skóre ťahu. Bez Reactu, aby sa dalo testovať.
import { DRAW_COMPLETE_COVERAGE } from './results';

export type ShapeKey = 'triangle' | 'circle' | 'square' | 'rhombus';
export type Pt = [number, number];

export const REF_SCALE = 0.32;         // veľkosť, pre ktorú sú nastavené tolerancie hodnotenia
export const MIN_STROKE_POINTS = 20;
export const MIN_STROKE_LEN = 0.3;     // kratší ťah (v jednotkách tvaru pri REF_SCALE, ~6 % obvodu kruhu) je len bodka/náhodný stisk: nehodnotí sa vôbec
export const COVER_TOL = 0.18;         // tolerancia pokrytia obrysu (v jednotkách tvaru)
// Režim hodnotenia (v jednotkách tvaru pri REF_SCALE):
//  free     = priemerná odchýlka, ktorá sa ešte neráta (bežné chvenie ruky nezníži presnosť)
//  tol      = priemerná odchýlka, pri ktorej je presnosť 0 %
//  fullCov  = pokrytie obrysu, od ktorého sa už skóre neznižuje (malá medzera na konci ťahu nevadí)
// 'normal' je zhovievavý (predvolený, pre hráča s tremorom), 'hard' je pôvodné prísne hodnotenie.
export type ScoringMode = 'normal' | 'hard';
export const SCORING: Record<ScoringMode, { label: string; free: number; tol: number; fullCov: number }> = {
  normal: { label: 'Zvyčajné', free: 0.06, tol: 0.6, fullCov: 0.9 },
  hard: { label: 'Prísne', free: 0, tol: 0.35, fullCov: 1 },
};

/** Obrys tvaru v súradniciach -1..1, hustý zatvorený polygón. */
export function outline(key: ShapeKey): Pt[] {
  if (key === 'circle') {
    return Array.from({ length: 240 }, (_, i) => {
      const a = (i / 240) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)] as Pt;
    });
  }
  const verts: Record<Exclude<ShapeKey, 'circle'>, Pt[]> = {
    triangle: [[0, -1], [0.95, 0.7], [-0.95, 0.7]],
    square: [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]],
    rhombus: [[0, -1], [0.75, 0], [0, 1], [-0.75, 0]],
  };
  const v = verts[key];
  const pts: Pt[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 60)); // rovnaká hustota bodov na všetkých stranách
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return pts;
}

export type Result = {
  complete: boolean;  // tvar je obkreslený celý (pokrytie >= DRAW_COMPLETE_COVERAGE); len vtedy má kresba skóre a ukladá sa
  score: number;
  accuracy: number;
  coverage: number;
  range: number;
  deviation: number;  // priemerná odchýlka čiary od obrysu v jednotkách tvaru
};

/** Vzdialenosť bodu od zatvoreného obrysu (od úsečiek medzi jeho bodmi, nie len od bodov). */
export function distToOutline(p: Pt, shape: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const a = shape[i], b = shape[(i + 1) % shape.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const d = Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Hodnotenie ťahu. null = ťah je príliš krátky na to, aby bol pokusom o tvar (bodka, náhodný stisk).
 * tolScale: tolerancie sú v jednotkách tvaru; pri menšom tvare sa zväčšia, aby zodpovedali rovnakej odchýlke v pixeloch.
 *
 * - pokrytie: podiel obrysu, ktorý má ťah vo svojej blízkosti (COVER_TOL). Pod DRAW_COMPLETE_COVERAGE tvar nie je dokončený.
 * - presnosť: priemerná odchýlka čiary od obrysu VÁŽENÁ DĹŽKOU ČIARY. Vzorky chodia 125×/s, takže obyčajný priemer cez body
 *   vážil časom: státie na mieste (pauza, pomalý úsek) presnosť umelo zvyšovalo alebo znižovalo, hoci čiara bola rovnaká.
 *   Teraz má každý kúsok nakreslenej čiary rovnakú váhu bez ohľadu na rýchlosť ruky. Prísnosť určuje režim (SCORING).
 */
export function evaluate(trail: Pt[], shape: Pt[], tolScale = 1, mode: ScoringMode = 'normal'): Result | null {
  const sc = SCORING[mode];
  const dist = trail.map((p) => distToOutline(p, shape));
  let len = 0, weighted = 0;
  for (let i = 1; i < trail.length; i++) {
    const seg = Math.hypot(trail[i][0] - trail[i - 1][0], trail[i][1] - trail[i - 1][1]);
    len += seg;
    weighted += seg * (dist[i] + dist[i - 1]) * 0.5;
  }
  if (len < MIN_STROKE_LEN * tolScale) return null;
  const deviation = weighted / len;
  let covered = 0;
  const tol = COVER_TOL * tolScale;
  for (const q of shape) {
    for (const p of trail) {
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) { covered++; break; }
    }
  }
  const coverage = covered / shape.length;
  const accuracy = Math.max(0, Math.min(1, 1 - (deviation - sc.free * tolScale) / ((sc.tol - sc.free) * tolScale)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of trail) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const range = Math.max(maxX - minX, maxY - minY) / 2;
  const complete = coverage >= DRAW_COMPLETE_COVERAGE;
  return { complete, score: complete ? Math.round(100 * accuracy * Math.min(1, coverage / sc.fullCov)) : 0, accuracy, coverage, range, deviation };
}
