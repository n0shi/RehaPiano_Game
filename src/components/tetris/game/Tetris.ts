// ==================== TETRIS GAME LOGIC ====================
// Hlavná herná logika pre Tetris

import { Piece } from './Piece';
import { COLS, ROWS, TETROMINOES } from './constants';

export class Tetris {
  board: (string | null)[][];
  // indices of rows cleared by the last place/hardDrop (for UI animation)
  lastClearedRows: number[];
  // snapshot of the cleared rows' cell colors (array per row)
  lastClearedRowsData: (string | null)[][];
  active: Piece | null;
  score: number;
  placedCount: number;
  availableColors: string[];
  activeColor: string | null;
  nextQueue: { kind: string; color: string }[];

  constructor(colors: string[]) {
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.active = null;
    this.score = 0;
    this.placedCount = 0;
    this.availableColors = colors;
    this.activeColor = null;
    this.nextQueue = [];
    this.lastClearedRows = [];
    this.lastClearedRowsData = [];
    // Generate initial queue (two upcoming pieces)
    this.generateNextPiece();
    this.generateNextPiece();
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < COLS && y >= 0 && y < ROWS;
  }

  generateNextPiece(): void {
    const keys = Object.keys(TETROMINOES);
    const kind = keys[Math.floor(Math.random() * keys.length)];
    const color = this.availableColors[Math.floor(Math.random() * this.availableColors.length)];
    this.nextQueue.push({ kind, color });
    // keep queue small (but allow external code to read more if needed)
    if (this.nextQueue.length > 3) this.nextQueue.shift();
  }

  collides(piece: Piece): boolean {
    for (const [x, y] of piece.blocks) {
      if (!this.inBounds(x, y)) return true;
      if (this.board[y] && this.board[y][x] !== null) return true;
    }
    return false;
  }

  spawn(kind?: string): boolean {
    if (this.active !== null) return false;

    // Use next piece from queue if available, otherwise random
    if (!kind && this.nextQueue.length > 0) {
      const np = this.nextQueue.shift()!;
      kind = np.kind;
      this.activeColor = np.color;
    } else if (!kind) {
      const keys = Object.keys(TETROMINOES);
      kind = keys[Math.floor(Math.random() * keys.length)];
      this.activeColor = this.availableColors[Math.floor(Math.random() * this.availableColors.length)];
    } else {
      this.activeColor = this.availableColors[Math.floor(Math.random() * this.availableColors.length)];
    }

    const p = new Piece(kind);
    if (this.collides(p)) return false;

    this.active = p;
    // Generate next piece to refill the queue
    this.generateNextPiece();
    return true;
  }

  // Expose helpers for UI: nextPiece (first in queue) and upcomingPieces (rest)
  get nextPiece() {
    return this.nextQueue.length > 0 ? this.nextQueue[0] : null;
  }

  get upcomingPieces() {
    return this.nextQueue.slice(1);
  }

  move(dx: number, dy: number): boolean {
    if (!this.active) return false;

    const p = new Piece(this.active.kind);
    p.x = this.active.x + dx;
    p.y = this.active.y + dy;
    p.rot = this.active.rot;

    if (!this.collides(p)) {
      this.active = p;
      return true;
    }
    return false;
  }

  rotate(): boolean {
    if (!this.active) return false;

    const newRot = this.active.rot + 1;

    let kicks: number[][] = [
      [0, 0],
      [-1, 0],
      [1, 0],
      [-2, 0],
      [2, 0],
      [0, -1],
    ];
    if (this.active.kind === 'I') {
      kicks = [
        [0, 0],
        [-1, 0],
        [1, 0],
        [-2, 0],
        [2, 0],
        [0, -1],
        [-3, 0],
        [3, 0],
      ];
    }

    for (const [dx, dy] of kicks) {
      const p = new Piece(this.active.kind);
      p.x = this.active.x + dx;
      p.y = this.active.y + dy;
      p.rot = newRot;

      if (!this.collides(p)) {
        this.active = p;
        return true;
      }
    }
    return false;
  }

  place(): boolean {
    if (!this.active || !this.activeColor) return false;

    for (const [x, y] of this.active.blocks) {
      if (this.inBounds(x, y)) {
        this.board[y][x] = this.activeColor;
      }
    }

    this.active = null;
    this.activeColor = null;
    this.placedCount++;
    this.clearLines();
    return true;
  }

  hardDrop(): boolean {
    if (!this.active) return false;

    let moved = false;
    const activeKind = this.active.kind;
    const activeRot = this.active.rot;

    while (this.active) {
      const p = new Piece(activeKind);
      p.x = this.active.x;
      p.y = this.active.y + 1;
      p.rot = activeRot;

      if (this.collides(p)) break;

      this.active = p;
      moved = true;
    }

    this.place();
    // Immediately spawn the next piece after a hard drop so there's no
    // visible delay in modes where gravity ticks control spawning (Level 2).
    this.spawn();
    return moved;
  }

  getGhostY(): number | null {
    if (!this.active) return null;

    let ghostY = this.active.y;
    const activeKind = this.active.kind;
    const activeRot = this.active.rot;
    const activeX = this.active.x;

    // Simulate dropping down until collision
    while (true) {
      const p = new Piece(activeKind);
      p.x = activeX;
      p.y = ghostY + 1;
      p.rot = activeRot;

      if (this.collides(p)) break;
      ghostY++;
    }

    return ghostY;
  }

  clearLines(): void {
    // determine which rows are full
    const fullRowIndices: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      const row = this.board[y];
      if (row.every((cell) => cell !== null)) fullRowIndices.push(y);
    }

    const newBoard = this.board.filter((row) => row.some((cell) => cell === null));
    const cleared = ROWS - newBoard.length;

    if (cleared > 0) {
      // snapshot the cleared rows' data for UI animation
      this.lastClearedRows = fullRowIndices.slice();
      this.lastClearedRowsData = fullRowIndices.map((idx) => this.board[idx].slice());

      for (let i = 0; i < cleared; i++) {
        newBoard.unshift(Array(COLS).fill(null));
      }
      this.board = newBoard;
      this.score += cleared * 100;
    } else {
      this.lastClearedRows = [];
      this.lastClearedRowsData = [];
    }
  }

  get activeCol(): number {
    return this.active ? this.active.x : 0;
  }
  get activeRow(): number {
    return this.active ? this.active.y : 0;
  }
  moveLeft(): boolean {
    return this.move(-1, 0);
  }
  moveRight(): boolean {
    return this.move(1, 0);
  }
  moveUp(): boolean {
    return this.move(0, -1);
  }
  moveDown(): boolean {
    return this.move(0, 1);
  }
}
