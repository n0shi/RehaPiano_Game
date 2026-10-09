// ==================== TRIEDA BLOKU ====================

import { TETROMINOES, COLS } from './constants';

export class Piece {
  kind: string;
  rot: number;
  x: number;
  y: number;

  constructor(kind: string) {
    this.kind = kind;
    this.rot = 0;
    this.x = Math.floor(COLS / 2) - 2;
    this.y = 0;
  }

  get blocks(): [number, number][] {
    const shapes = TETROMINOES[this.kind];
    const shape = shapes[this.rot % shapes.length];
    return shape.map(
      ([dx, dy]) => [this.x + dx, this.y + dy] as [number, number]
    );
  }
}
