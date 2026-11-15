// Pentomino: otáčanie, ťahanie a dosadnutie bloku (PieceManipulator beží na falošných hodinách, bez prehliadača).
import { describe, it, expect } from 'vitest';
import { PieceManipulator, pivotOffset, rotateAboutPivot, type ManipSnapshot } from '../pieceManip';
import { PENTOMINO_SHAPES, flipPentomino, rotatePentomino } from '../../data/pentominoShapes';
import type { PlacedPiece } from '../pentominoUtils';

const ROWS = 20, COLS = 20;

function setup(pieces: PlacedPiece[]) {
  let t = 0;
  let queue: ((time: number) => void)[] = [];
  let selected: string | null = null;
  let snap: ManipSnapshot = { live: null, cursor: null, hoverUid: null };
  const commits: { uid: string; changed: boolean }[] = [];
  const manip = new PieceManipulator({
    rows: () => ROWS, cols: () => COLS, pieces: () => pieces,
    selected: () => selected, select: (uid) => { selected = uid; },
    commit: (info) => {
      const p = pieces.find((q) => q.uid === info.uid)!;
      p.grid = info.grid; p.row = info.row; p.col = info.col;
      commits.push({ uid: info.uid, changed: info.changed });
    },
    render: (s) => { snap = s; },
    stepMove: true,
  }, { request: (cb) => { queue.push(cb); return queue.length; }, cancel: () => { queue = []; }, now: () => t });
  /** Posunie hodiny o `ms` po snímkach 16 ms. */
  const run = (ms: number) => { const end = t + ms; while (t < end) { t += 16; const q = queue; queue = []; q.forEach((f) => f(t)); } };
  return {
    manip, run, commits,
    select: (uid: string) => { selected = uid; },
    snap: () => snap,
    tap: (k: 'r' | 'e') => { manip.keyDown(k); run(50); manip.keyUp(k); run(800); },
    hold: (k: 'r' | 'e', ms: number) => { manip.keyDown(k); run(ms); manip.keyUp(k); run(800); },
  };
}

const shape = (id: string) => PENTOMINO_SHAPES.find((s) => s.id === id)!.grid;
const piece = (uid: string, id: string, row: number, col: number, grid = shape(id)): PlacedPiece => ({ uid, shapeId: id, grid, row, col, color: '#000' });
/** Poloha kurzora (-1..1) pre bod v bunkách. */
const at = (col: number, row: number) => ({ x: (col - COLS / 2) / (COLS / 2), y: (row - ROWS / 2) / (ROWS / 2) });
const state = (p: PlacedPiece) => `${p.row},${p.col}:${JSON.stringify(p.grid)}`;
const cellsOf = (p: PlacedPiece) => p.grid.flatMap((r, i) => r.flatMap((v, j) => (v ? [`${p.row + i},${p.col + j}`] : [])));
const overlaps = (pieces: PlacedPiece[]) => { const all = pieces.flatMap(cellsOf); return new Set(all).size !== all.length; };

const variants = PENTOMINO_SHAPES.flatMap((s) => [
  { name: s.id, id: s.id, grid: s.grid },
  { name: `${s.id} (prevrátený)`, id: s.id, grid: flipPentomino(s.grid) },
]);

describe('otáčanie bloku neposúva (P a U sa predtým pri každom otočení posunuli o pol bunky)', () => {
  it.each(variants)('$name: R a potom E vráti blok na pôvodné miesto', ({ id, grid }) => {
    const pieces = [piece('a', id, 8, 8, grid)];
    const h = setup(pieces); h.select('a');
    const before = state(pieces[0]);
    h.tap('r'); h.tap('e');
    expect(state(pieces[0])).toBe(before);
  });

  it.each(variants)('$name: 4× R aj 4× E vráti blok na pôvodné miesto', ({ id, grid }) => {
    const pieces = [piece('a', id, 8, 8, grid)];
    const h = setup(pieces); h.select('a');
    const before = state(pieces[0]);
    for (let i = 0; i < 4; i++) h.tap('r');
    expect(state(pieces[0])).toBe(before);
    for (let i = 0; i < 4; i++) h.tap('e');
    expect(state(pieces[0])).toBe(before);
  });

  it.each(variants)('$name: dve otočenia o 180° (podržaný kláves) vrátia blok späť', ({ id, grid }) => {
    const pieces = [piece('a', id, 8, 8, grid)];
    const h = setup(pieces); h.select('a');
    const before = state(pieces[0]);
    h.hold('r', 1000); h.hold('r', 1000);
    expect(state(pieces[0])).toBe(before);
  });

  it('jedno ťuknutie R otočí blok o 90° a ostane na celých bunkách v poli', () => {
    const pieces = [piece('a', 'P', 8, 8)];
    const h = setup(pieces); h.select('a');
    h.tap('r');
    expect(pieces[0].grid).toEqual(rotatePentomino(shape('P')));
    expect(Number.isInteger(pieces[0].row) && Number.isInteger(pieces[0].col)).toBe(true);
    expect(h.commits).toEqual([{ uid: 'a', changed: true }]);
  });

  it('os otáčania je stred bunky alebo roh bunky a otáča sa spolu s blokom', () => {
    for (const { grid } of variants) {
      let g = grid;
      for (let i = 0; i < 4; i++) {
        const o = pivotOffset(g), hgt = g.length, w = g[0].length;
        // stred obdĺžnika + posun musí byť v oboch osiach na rovnakom type bodu (oba celé alebo oba polovičné)
        expect(((w / 2 + o.x) * 2) % 2).toBe(((hgt / 2 + o.y) * 2) % 2);
        const r = rotateAboutPivot(g, 8 + w / 2, 8 + hgt / 2, 1); // blok s ľavým horným rohom na bunke (8, 8)
        expect(Number.isInteger(r.cx - r.grid[0].length / 2) && Number.isInteger(r.cy - r.grid.length / 2)).toBe(true);
        g = r.grid;
      }
    }
  });
});

describe('ťahanie bloku rukou', () => {
  const wall = () => [piece('w1', 'I', 8, 6), piece('w2', 'I', 8, 7), piece('w3', 'I', 8, 8)]; // stena hrubá 3 bunky

  it('držaný blok prejde ponad iné bloky (nezasekne sa a nepreskakuje)', () => {
    const pieces = [piece('a', 'I', 8, 2), ...wall()];
    const h = setup(pieces);
    expect(h.manip.begin(at(2.5, 10.5))).toBe(true);
    for (let hand = 2.5; hand <= 12.5; hand += 0.05) { h.manip.move(at(hand, 10.5)); h.run(16); }
    h.run(200);
    h.manip.finish(); h.run(500);
    expect(pieces[0].col).toBe(12); // za stenou: ruka prešla 10 buniek, blok tiež
    expect(overlaps(pieces)).toBe(false);
  });

  it('blok pustený na iný blok dosadne na najbližšie voľné miesto, ktoré vopred ukazuje náhľad', () => {
    const pieces = [piece('a', 'I', 8, 2), ...wall()];
    const h = setup(pieces);
    h.manip.begin(at(2.5, 10.5));
    for (let hand = 2.5; hand <= 7.5; hand += 0.05) { h.manip.move(at(hand, 10.5)); h.run(16); }
    h.run(200);
    const ghost = h.snap().live!.ghost!;
    h.manip.finish(); h.run(500);
    expect({ row: pieces[0].row, col: pieces[0].col }).toEqual({ row: ghost.row, col: ghost.col });
    expect(overlaps(pieces)).toBe(false);
    expect(Math.abs(pieces[0].col - 7)).toBeLessThanOrEqual(3); // najviac DROP_MAX_SHIFT od miesta pustenia
  });

  it('pri okraji poľa sa posun ruky nehromadí: po obrátení smeru sa blok pohne do 1,5 bunky', () => {
    const pieces = [piece('a', 'I', 8, 10)];
    const h = setup(pieces);
    const cx = () => (h.manip as any).session.cx - 0.5;
    h.manip.begin(at(10.5, 10.5));
    let hand = 10.5;
    for (let i = 0; i < 600; i++) { hand += 0.05; h.manip.move(at(hand, 10.5)); h.run(16); } // 30 buniek "do steny"
    expect(cx()).toBe(19);
    let back = 0;
    while (cx() === 19 && back < 40) { hand -= 0.05; back += 0.05; h.manip.move(at(hand, 10.5)); h.run(16); }
    expect(back).toBeLessThanOrEqual(1.5);
  });

  it('blok nikdy neopustí pole', () => {
    const pieces = [piece('a', 'L', 8, 8)];
    const h = setup(pieces);
    h.manip.begin(at(8.5, 8.5));
    for (const [c, r] of [[-30, -30], [50, -30], [50, 50], [-30, 50]]) {
      for (let i = 0; i < 200; i++) { h.manip.move(at(c, r)); h.run(16); }
      const s = (h.manip as any).session;
      const top = s.cy - s.grid.length / 2, left = s.cx - s.grid[0].length / 2;
      expect(top).toBeGreaterThanOrEqual(0); expect(left).toBeGreaterThanOrEqual(0);
      expect(top + s.grid.length).toBeLessThanOrEqual(ROWS); expect(left + s.grid[0].length).toBeLessThanOrEqual(COLS);
    }
  });

  it('stisk mimo blokov nič nechytí; stisk bez pohybu blok nezmení', () => {
    const pieces = [piece('a', 'T', 8, 8)];
    const h = setup(pieces);
    expect(h.manip.begin(at(2.5, 2.5))).toBe(false);
    const before = state(pieces[0]);
    expect(h.manip.begin(at(9.5, 8.5))).toBe(true);
    h.run(300); h.manip.finish(); h.run(500);
    expect(state(pieces[0])).toBe(before);
    expect(h.commits).toEqual([{ uid: 'a', changed: false }]);
  });

  it('prevrátenie: súmerný blok (I, X) sa neprevráti, nesúmerný áno', () => {
    for (const [id, expected] of [['I', false], ['X', false], ['F', true], ['L', true]] as const) {
      const pieces = [piece('a', id, 8, 8)];
      const h = setup(pieces); h.select('a');
      expect(h.manip.flipSelected()).toBe(expected);
      h.run(800);
      expect(pieces[0].grid).toEqual(expected ? flipPentomino(shape(id)) : shape(id));
    }
  });
});
