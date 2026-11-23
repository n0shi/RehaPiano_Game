// Tetris: presun bloku rukou ide k cieľu po bunkách (Tetris.moveToward). Prečo: predtým sa blok preniesol priamo na cieľovú
// bunku a kontrolovala sa len tá, takže pri rýchlom pohybe ruky "preskočil" cez stĺpec uložených blokov.
import { describe, it, expect } from 'vitest';
import { Tetris } from '../../components/tetris/game/Tetris';
import { Piece } from '../../components/tetris/game/Piece';
import { COLS, ROWS } from '../../components/tetris/game/constants';

const fresh = () => {
  const t = new Tetris(['#000']);
  const p = new Piece('O');
  p.x = 0; p.y = 5;
  t.active = p;
  return t;
};

describe('Tetris.moveToward', () => {
  it('dôjde na voľný cieľ', () => {
    const t = fresh();
    t.moveToward(4, 9);
    expect(t.active!.x).toBe(4);
    expect(t.active!.y).toBe(9);
  });

  it('nepreskočí cez stĺpec uložených blokov', () => {
    const t = fresh();
    for (let y = 0; y < ROWS; y++) t.board[y][5] = '#f00'; // stena v stĺpci 5 cez celú výšku
    const startX = t.active!.x;
    t.moveToward(COLS - 3, 5);
    const xs = t.active!.blocks.map(([x]) => x);
    expect(Math.max(...xs)).toBeLessThan(5);
    expect(t.active!.x).toBeGreaterThan(startX); // došiel až k stene
  });

  it('pri prekážke v jednej osi pokračuje v druhej', () => {
    const t = fresh();
    for (let y = 0; y < ROWS; y++) t.board[y][4] = '#f00';
    t.moveToward(8, 12);
    expect(t.active!.y).toBe(12);
  });
});
