// Pentomino: údaje levelov (src/data/pentominoLevels.json) musia dávať hrateľný a riešiteľný level.
import { describe, it, expect } from 'vitest';
import levelsData from '../../data/pentominoLevels.json';
import { PENTOMINO_SHAPES, rotatePentomino, flipPentomino } from '../../data/pentominoShapes';
import { findStartPosition, fitsOnGrid, placePiece, isLevelComplete, type PentominoLevel } from '../pentominoUtils';

const levels = levelsData as PentominoLevel[];
const SIZE = 20;
const shapeOf = (id: string) => PENTOMINO_SHAPES.find((s) => s.id === id);
const emptyGrid = () => Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
const cells = (g: boolean[][]) => g.flatMap((r, i) => r.flatMap((v, j) => (v ? [[i, j] as [number, number]] : [])));

/** Všetky orientácie bloku (otočenia a prevrátenia) ako zoznamy buniek. */
function orientations(grid: boolean[][]) {
  const seen = new Map<string, [number, number][]>();
  let g = grid;
  for (let f = 0; f < 2; f++) {
    for (let i = 0; i < 4; i++) { const c = cells(g); seen.set(JSON.stringify(c), c); g = rotatePentomino(g); }
    g = flipPentomino(g);
  }
  return [...seen.values()];
}

/** Dá sa cieľový tvar presne vyplniť blokmi levelu? (hľadanie s návratom) */
function solvable(level: PentominoLevel): boolean {
  const need = new Set(cells(level.targetShape).map(([r, c]) => r * 100 + c));
  const ids = level.availablePieces;
  const opts = ids.map((id) => orientations(shapeOf(id)!.grid));
  const used = ids.map(() => false);
  const solve = (): boolean => {
    if (need.size === 0) return true;
    const first = Math.min(...need), fr = Math.floor(first / 100), fc = first % 100;
    for (let p = 0; p < ids.length; p++) {
      if (used[p]) continue;
      if (ids.indexOf(ids[p]) < p && !used[ids.indexOf(ids[p])]) continue; // rovnaké bloky sú zameniteľné
      for (const o of opts[p]) {
        const [ar, ac] = o[0];
        const pos = o.map(([r, c]) => [fr + r - ar, fc + c - ac]);
        if (pos.some(([r, c]) => c < 0 || c >= SIZE || !need.has(r * 100 + c))) continue;
        pos.forEach(([r, c]) => need.delete(r * 100 + c)); used[p] = true;
        if (solve()) return true;
        used[p] = false; pos.forEach(([r, c]) => need.add(r * 100 + c));
      }
    }
    return false;
  };
  return solve();
}

describe('tvary pentomín', () => {
  it('je ich 12, každý má 5 buniek a žiadne dva nie sú rovnaké', () => {
    expect(PENTOMINO_SHAPES).toHaveLength(12);
    for (const s of PENTOMINO_SHAPES) expect(cells(s.grid)).toHaveLength(5);
    const canon = PENTOMINO_SHAPES.map((s) => orientations(s.grid).map((o) => JSON.stringify(o)).sort()[0]);
    expect(new Set(canon).size).toBe(12);
  });
  it('4 otočenia a 2 prevrátenia vrátia pôvodný tvar', () => {
    for (const s of PENTOMINO_SHAPES) {
      expect(rotatePentomino(rotatePentomino(rotatePentomino(rotatePentomino(s.grid))))).toEqual(s.grid);
      expect(flipPentomino(flipPentomino(s.grid))).toEqual(s.grid);
    }
  });
});

describe.each(levels.map((l) => ({ name: `level ${l.id} (${l.name})`, level: l })))('$name', ({ level }) => {
  it('má pole 20×20 a známe bloky', () => {
    expect(level.targetShape).toHaveLength(SIZE);
    for (const row of level.targetShape) expect(row).toHaveLength(SIZE);
    for (const id of level.availablePieces) expect(shapeOf(id), `blok ${id}`).toBeDefined();
  });

  it('plocha cieľa = 5 × počet blokov a dá sa presne vyplniť', () => {
    expect(cells(level.targetShape)).toHaveLength(level.availablePieces.length * 5);
    expect(solvable(level)).toBe(true);
  });

  it('štartovacie pozície sú v poli, neprekrývajú sa a level nezačína ako vyhraný', () => {
    let grid = emptyGrid();
    (level.startingPositions ?? []).forEach((pos, i) => {
      const g = shapeOf(level.availablePieces[i])!.grid;
      expect(fitsOnGrid(grid, g, pos.row, pos.col), `blok #${i} ${level.availablePieces[i]}`).toBe(true);
      grid = placePiece(grid, g, pos.row, pos.col, '');
    });
    expect((level.startingPositions ?? []).length).toBeLessThanOrEqual(level.availablePieces.length);
    expect(isLevelComplete(grid, level.targetShape)).toBe(false);
  });

  it('bez štartovacích pozícií dostane každý blok miesto mimo cieľa (level ostane hrateľný)', () => {
    let grid = emptyGrid();
    for (const id of level.availablePieces) {
      const g = shapeOf(id)!.grid;
      const pos = findStartPosition(grid, g, level.targetShape);
      expect(pos, `blok ${id}`).not.toBeNull();
      expect(fitsOnGrid(grid, g, pos!.row, pos!.col)).toBe(true);
      for (const [r, c] of cells(g)) expect(level.targetShape[pos!.row + r][pos!.col + c]).toBe(false);
      grid = placePiece(grid, g, pos!.row, pos!.col, '');
    }
  });
});

describe('findStartPosition', () => {
  it('na plnom poli vráti null a na takmer plnom nájde posledné voľné miesto', () => {
    const full = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(true));
    const none = emptyGrid();
    expect(findStartPosition(full, shapeOf('I')!.grid, none)).toBeNull();
    for (let r = 10; r < 15; r++) full[r][7] = false;
    expect(findStartPosition(full, shapeOf('I')!.grid, none)).toEqual({ row: 10, col: 7 });
  });
});
