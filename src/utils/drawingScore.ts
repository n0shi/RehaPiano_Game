// Hodnotenie kresby v "Skúške kreslenia" (ShapeTraceModal): obrys tvaru a skóre ťahu. Bez Reactu, aby sa dalo testovať.
import { DRAW_COMPLETE_COVERAGE } from './results';

export type ShapeKey = 'triangle' | 'circle' | 'square' | 'rhombus';
export type Pt = [number, number];

export const REF_SCALE = 0.32;         // veľkosť, pre ktorú sú nastavené tolerancie hodnotenia
export const MIN_STROKE_POINTS = 20;
export const MIN_STROKE_LEN = 0.3;     // kratší ťah (v jednotkách tvaru pri REF_SCALE, ~6 % obvodu kruhu) je len bodka/náhodný stisk: nehodnotí sa vôbec
export const COVER_TOL = 0.18;         // tolerancia pokrytia obrysu (v jednotkách tvaru)
export const ACC_TOL = 0.35;          // priemerná odchýlka čiary od obrysu (v jednotkách tvaru pri REF_SCALE), pri ktorej je presnosť 0 %

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
  size: number;       // veľkosť kresby voči tvaru: 1 = rovnako veľká, 1.03 = o 3 % väčšia, 0.9 = o 10 % menšia
  deviation: number;  // priemerná odchýlka čiary od obrysu v jednotkách tvaru
};

/** Šírka a výška bodov (ohraničujúci obdĺžnik). */
function extent(pts: Pt[]): [number, number] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return [maxX - minX, maxY - minY];
}

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
 * Skóre = presnosť × pokrytie (pôvodný vzorec). Zhovievavý režim, v ktorom sa malá odchýlka nerátala, dával takmer vždy 100,
 * takže medzi pokusmi nebolo vidieť rozdiel; preto je zrušený a každá odchýlka od obrysu skóre znižuje.
 * - pokrytie: podiel obrysu, ktorý má ťah vo svojej blízkosti (COVER_TOL). Pod DRAW_COMPLETE_COVERAGE tvar nie je dokončený.
 * - presnosť: 1 - priemerná odchýlka / ACC_TOL. Odchýlka je VÁŽENÁ DĹŽKOU ČIARY: vzorky chodia 125×/s, takže obyčajný priemer
 *   cez body vážil časom a státie na mieste (pauza, pomalý úsek) presnosť menilo, hoci čiara bola rovnaká.
 * - veľkosť: šírka a výška kresby voči šírke a výške SAMOTNÉHO TVARU (priemer oboch osí). Predtým sa väčší rozmer delil
 *   pevnou hodnotou 1, takže presne obkreslený štvorec mal "80 %" a kruh nakreslený tesne zvonka "103 %" bez vysvetlenia.
 */
export function evaluate(trail: Pt[], shape: Pt[], tolScale = 1): Result | null {
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
  const accuracy = Math.max(0, 1 - deviation / (ACC_TOL * tolScale));
  const [tw, th] = extent(trail), [sw, sh] = extent(shape);
  const size = (tw / sw + th / sh) / 2;
  const complete = coverage >= DRAW_COMPLETE_COVERAGE;
  return { complete, score: complete ? Math.round(100 * accuracy * coverage) : 0, accuracy, coverage, size, deviation };
}

/** Veľkosť kresby slovom, napr. "o 3 % väčšia než tvar". */
export function sizeLabel(size: number): string {
  const d = Math.round((size - 1) * 100);
  return d === 0 ? 'rovnaká ako tvar' : `o ${Math.abs(d)} % ${d > 0 ? 'väčšia' : 'menšia'} než tvar`;
}
