// Pentomino tvary - každý definovaný ako 2D pole (5 buniek)
// true = bunka je súčasťou tvaru, false = prázdna bunka

export type PentominoShape = {
  id: string;
  name: string;
  grid: boolean[][]; // grid[row][col]
  color: string;
};

export const PENTOMINO_SHAPES: PentominoShape[] = [
  {
    id: 'F',
    name: 'F',
    grid: [
      [false, true, true],
      [true, true, false],
      [false, true, false],
    ],
    color: '#3b82f6', // modrá-500
  },
  {
    id: 'I',
    name: 'I',
    grid: [
      [true],
      [true],
      [true],
      [true],
      [true],
    ],
    color: '#ef4444', // červená-500
  },
  {
    id: 'L',
    name: 'L',
    grid: [
      [true, false],
      [true, false],
      [true, false],
      [true, true],
    ],
    color: '#f59e0b', // jantárová-500
  },
  {
    id: 'N',
    name: 'N',
    grid: [
      [false, true],
      [true, true],
      [true, false],
      [true, false],
    ],
    color: '#8b5cf6', // fialová-500
  },
  {
    id: 'P',
    name: 'P',
    grid: [
      [true, true],
      [true, true],
      [true, false],
    ],
    color: '#ec4899', // ružová-500
  },
  {
    id: 'T',
    name: 'T',
    grid: [
      [true, true, true],
      [false, true, false],
      [false, true, false],
    ],
    color: '#10b981', // smaragdová-500
  },
  {
    id: 'U',
    name: 'U',
    grid: [
      [true, false, true],
      [true, true, true],
    ],
    color: '#06b6d4', // tyrkysová-500
  },
  {
    id: 'V',
    name: 'V',
    grid: [
      [true, false, false],
      [true, false, false],
      [true, true, true],
    ],
    color: '#84cc16', // limetková-500
  },
  {
    id: 'W',
    name: 'W',
    grid: [
      [true, false, false],
      [true, true, false],
      [false, true, true],
    ],
    color: '#f97316', // oranžová-500
  },
  {
    id: 'X',
    name: 'X',
    grid: [
      [false, true, false],
      [true, true, true],
      [false, true, false],
    ],
    color: '#6366f1', // indigová-500
  },
  {
    id: 'Y',
    name: 'Y',
    grid: [
      [false, true],
      [true, true],
      [false, true],
      [false, true],
    ],
    color: '#14b8a6', // tyrkysová-500
  },
  {
    id: 'Z',
    name: 'Z',
    grid: [
      [true, true, false],
      [false, true, false],
      [false, true, true],
    ],
    color: '#a855f7', // purpurová-500
  },
];

// Pomocná funkcia: rotácia tvaru o 90° doprava
export function rotatePentomino(grid: boolean[][]): boolean[][] {
  const rows = grid.length;
  const cols = grid[0].length;
  const rotated: boolean[][] = Array(cols)
    .fill(null)
    .map(() => Array(rows).fill(false));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rotated[c][rows - 1 - r] = grid[r][c];
    }
  }
  return rotated;
}

// Pomocná funkcia: horizontálne prevrátenie (flip)
export function flipPentomino(grid: boolean[][]): boolean[][] {
  return grid.map((row) => [...row].reverse());
}
