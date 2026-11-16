// Skúška kreslenia: hodnotenie ťahu (utils/drawingScore.ts) a čo z neho ide do pokroku používateľa (utils/results.ts).
import { describe, it, expect } from 'vitest';
import { evaluate, outline, sizeLabel, type Pt, type ShapeKey } from '../drawingScore';
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
  it.each(['circle', 'square', 'triangle', 'rhombus'] as ShapeKey[])('presne obkreslený %s má 100 a veľkosť rovnakú ako tvar', (key) => {
    const o = outline(key);
    const r = evaluate([...o, o[0]], o, LEVEL3)!;
    expect(r.score).toBe(100);
    expect(r.size).toBeCloseTo(1, 2);
    expect(sizeLabel(r.size)).toBe('rovnaká ako tvar');
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
    const scores = [1, 0.9, 0.8, 0.7].map((rad) => evaluate(arc(rad), circle, LEVEL1)!.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it('odchýlka sa meria od čiary obrysu, nie od jeho bodov', () => {
    const sq = outline('square');
    const mid: Pt[] = Array.from({ length: 200 }, (_, i) => [-0.7 + (1.4 * i) / 199 + 0.004, -0.8]); // medzi bodmi obrysu, presne na hrane
    expect(evaluate(mid, sq, LEVEL3)!.deviation).toBeLessThan(1e-9);
  });
});

describe('skóre nie je vždy 100', () => {
  it('chvenie ruky a mierne posunutá čiara skóre znižujú', () => {
    expect(evaluate(arc(1, 0, 1, 600, 0.08), circle, LEVEL3)!.score).toBeLessThan(95);
    expect(evaluate(arc(1.03), circle, LEVEL3)!.score).toBeLessThan(95);
    expect(evaluate(arc(1.03), circle, LEVEL3)!.score).toBeGreaterThan(85);
  });

  it('kruh o 15 % menší má okolo 57 bodov (veľký tvar)', () => {
    const s = evaluate(arc(0.85), circle, LEVEL3)!.score;
    expect(s).toBeGreaterThanOrEqual(52);
    expect(s).toBeLessThanOrEqual(62);
  });

  it('medzera v obryse skóre znižuje úmerne pokrytiu', () => {
    const r = evaluate(arc(1, 0, 0.8), circle, LEVEL3)!;
    expect(r.score).toBe(Math.round(100 * r.coverage));
    expect(r.score).toBeLessThan(90);
  });
});

describe('veľkosť kresby', () => {
  it('meria sa voči samotnému tvaru, nie voči pevnej jednotke', () => {
    expect(evaluate(arc(1.03), circle, LEVEL3)!.size).toBeCloseTo(1.03, 2);
    expect(sizeLabel(1.03)).toBe('o 3 % väčšia než tvar');
    expect(sizeLabel(evaluate(arc(0.85), circle, LEVEL3)!.size)).toBe('o 15 % menšia než tvar');
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

  it('záznamy zo zhovievavého hodnotenia (takmer vždy 100) sa do štatistík nepočítajú', () => {
    const p = summarize([
      { t: 1, kind: 'drawing', shape: 'circle', level: 3, score: 72, accuracy: 0.8, coverage: 0.9 },
      { t: 2, kind: 'drawing', shape: 'circle', level: 3, score: 100, accuracy: 1, coverage: 0.95, scoring: 'normal' },
      { t: 3, kind: 'drawing', shape: 'circle', level: 3, score: 64, accuracy: 0.7, coverage: 0.92, scoring: 'hard' },
    ]);
    expect(p.drawing.count).toBe(2);
    expect(p.drawing.best).toBe(72);
  });
});
