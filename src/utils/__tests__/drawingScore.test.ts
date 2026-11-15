// Skúška kreslenia: hodnotenie ťahu (utils/drawingScore.ts) a čo z neho ide do pokroku používateľa (utils/results.ts).
import { describe, it, expect } from 'vitest';
import { evaluate, outline, SCORING, type Pt, type ShapeKey } from '../drawingScore';
import { DRAW_COMPLETE_COVERAGE, summarize, type GameResult } from '../results';

/** Kruh/oblúk s polomerom `rad` od podielu `from` po `to` obvodu; `tremor` = amplitúda chvenia kolmo na čiaru. */
const arc = (rad: number, from = 0, to = 1, n = 600, tremor = 0): Pt[] => Array.from({ length: n }, (_, i) => {
  const a = (from + ((to - from) * i) / (n - 1)) * Math.PI * 2;
  const r = rad + tremor * Math.sin(a * 23);
  return [r * Math.cos(a), r * Math.sin(a)];
});
const circle = outline('circle');
const LEVEL3 = 1, LEVEL1 = 2; // tolScale: veľký tvar 1, malý tvar 2

describe('čo sa počíta ako nakreslený tvar', () => {
  it('bodka a krátky náhodný ťah sa nehodnotia vôbec', () => {
    const dot: Pt[] = Array.from({ length: 200 }, (_, i) => [1 + 0.001 * (i % 3), 0]);
    const short: Pt[] = Array.from({ length: 40 }, (_, i) => [0.2 + (i * 0.25) / 39, 0.1]);
    for (const ts of [LEVEL3, LEVEL1]) {
      expect(evaluate(dot, circle, ts)).toBeNull();
      expect(evaluate(short, circle, ts)).toBeNull();
    }
  });

  it(`pod ${DRAW_COMPLETE_COVERAGE * 100} % obrysu tvar nie je dokončený a nemá skóre`, () => {
    const half = evaluate(arc(1, 0, 0.5), circle, LEVEL3)!;
    expect(half.complete).toBe(false);
    expect(half.score).toBe(0);
    expect(half.coverage).toBeLessThan(DRAW_COMPLETE_COVERAGE);
  });

  it('65 % obrysu už je dokončený tvar', () => {
    const r = evaluate(arc(1, 0, 0.62), circle, LEVEL3)!;
    expect(r.coverage).toBeGreaterThanOrEqual(DRAW_COMPLETE_COVERAGE);
    expect(r.complete).toBe(true);
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('presnosť', () => {
  it.each(['circle', 'square', 'triangle', 'rhombus'] as ShapeKey[])('presne obkreslený %s má 100 v oboch režimoch', (key) => {
    const o = outline(key);
    expect(evaluate([...o, o[0]], o, LEVEL3, 'normal')!.score).toBe(100);
    expect(evaluate([...o, o[0]], o, LEVEL3, 'hard')!.score).toBe(100);
  });

  it('nezávisí od rýchlosti ruky: pauza na mieste nezmení presnosť (predtým sa vážilo časom)', () => {
    const line = [...arc(1, 0, 0.5, 300), ...arc(1.15, 0.5, 1, 300)];
    const bad = arc(1.15, 0.5, 1, 300);
    const pauseOnGood = [...arc(1, 0, 0.5, 300), ...Array.from({ length: 3000 }, () => [-1, 0] as Pt), ...bad];
    const pauseOnBad = [...arc(1, 0, 0.5, 300), ...bad.slice(0, 150), ...Array.from({ length: 3000 }, () => bad[150]), ...bad.slice(150)];
    const base = evaluate(line, circle, LEVEL3)!;
    expect(evaluate(pauseOnGood, circle, LEVEL3)!.accuracy).toBeCloseTo(base.accuracy, 3);
    expect(evaluate(pauseOnBad, circle, LEVEL3)!.accuracy).toBeCloseTo(base.accuracy, 3);
    expect(evaluate(pauseOnBad, circle, LEVEL3)!.score).toBe(base.score);
  });

  it('väčšia odchýlka = nižšie skóre', () => {
    const scores = [1, 0.9, 0.8, 0.7].map((rad) => evaluate(arc(rad), circle, LEVEL1, 'hard')!.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it('odchýlka sa meria od čiary obrysu, nie od jeho bodov', () => {
    const sq = outline('square');
    const mid: Pt[] = Array.from({ length: 200 }, (_, i) => [-0.7 + (1.4 * i) / 199 + 0.004, -0.8]); // medzi bodmi obrysu, presne na hrane
    expect(evaluate(mid, sq, LEVEL3)!.deviation).toBeLessThan(1e-9);
  });
});

describe('režimy hodnotenia', () => {
  const tremor = arc(1, 0, 1, 600, 0.08);
  const small = arc(0.85);

  it('zvyčajné: bežné chvenie ruky neznižuje skóre, prísne áno', () => {
    expect(evaluate(tremor, circle, LEVEL3, 'normal')!.score).toBe(100);
    expect(evaluate(tremor, circle, LEVEL3, 'hard')!.score).toBeLessThan(95);
  });

  it('zvyčajné nikdy nedá menej ako prísne', () => {
    for (const tr of [tremor, small, arc(1, 0, 0.7), arc(1.1, 0, 1, 600, 0.2)]) {
      for (const ts of [LEVEL3, LEVEL1]) {
        expect(evaluate(tr, circle, ts, 'normal')!.score).toBeGreaterThanOrEqual(evaluate(tr, circle, ts, 'hard')!.score);
      }
    }
  });

  it('kruh o 15 % menší: zvyčajné okolo 83, prísne okolo 57 (veľký tvar)', () => {
    expect(evaluate(small, circle, LEVEL3, 'normal')!.score).toBeGreaterThanOrEqual(78);
    expect(evaluate(small, circle, LEVEL3, 'hard')!.score).toBeLessThanOrEqual(62);
  });

  it('nastavenia režimov dávajú zmysel', () => {
    expect(SCORING.normal.free).toBeGreaterThan(SCORING.hard.free);
    expect(SCORING.normal.tol).toBeGreaterThan(SCORING.hard.tol);
    for (const m of [SCORING.normal, SCORING.hard]) { expect(m.tol).toBeGreaterThan(m.free); expect(m.fullCov).toBeGreaterThanOrEqual(DRAW_COMPLETE_COVERAGE); }
  });
});

describe('pokrok používateľa', () => {
  it('nedokončené kresby zo starších záznamov sa do štatistík nepočítajú', () => {
    const draw = (score: number, coverage: number, t: number): GameResult => ({ t, kind: 'drawing', shape: 'circle', level: 3, score, accuracy: 0.8, coverage });
    const p = summarize([draw(80, 0.95, 1), draw(0, 0.05, 2), draw(3, 0.3, 3), draw(60, 0.65, 4)]);
    expect(p.drawing.count).toBe(2);
    expect(p.drawing.best).toBe(80);
    expect(p.drawing.days[0].value).toBe(70);
  });
});
