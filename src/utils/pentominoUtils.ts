import { PentominoShape } from '../data/pentominoShapes';

export type PlacedPiece = {
  shapeId: string;
  grid: boolean[][];
  row: number;
  col: number;
  color: string;
  uid?: string; // optional unique id assigned by the UI
};

export type PentominoLevel = {
  id: number;
  name: string;
  description: string;
  gridWidth: number;
  gridHeight: number;
  targetShape: boolean[][];
  availablePieces: string[];
  startingPositions?: Array<{ row: number; col: number }>; // Voliteľné štartovacie pozície
};

// Kontrola kolízie: môže byť kúsok umiestnený na danú pozíciu?
export function canPlacePiece(
  grid: boolean[][],
  pieceGrid: boolean[][],
  row: number,
  col: number,
  targetShape: boolean[][],
  placedPieces: PlacedPiece[]
): boolean {
  const pieceRows = pieceGrid.length;
  const pieceCols = pieceGrid[0].length;
  const gridRows = grid.length;
  const gridCols = grid[0].length;

  for (let r = 0; r < pieceRows; r++) {
    for (let c = 0; c < pieceCols; c++) {
      if (!pieceGrid[r][c]) continue;

      const targetRow = row + r;
      const targetCol = col + c;

      // Mimo mriežky
      if (
        targetRow < 0 ||
        targetRow >= gridRows ||
        targetCol < 0 ||
        targetCol >= gridCols
      ) {
        return false;
      }

      // Mimo cieľového tvaru
      if (!targetShape[targetRow][targetCol]) {
        return false;
      }

      // Kolízia s už umiestneným kúskom
      if (grid[targetRow][targetCol]) {
        return false;
      }
    }
  }

  return true;
}

// Kontrola len hraníc mriežky a kolízií (bez cieľového tvaru)
export function fitsOnGrid(
  grid: boolean[][],
  pieceGrid: boolean[][],
  row: number,
  col: number
): boolean {
  const gridRows = grid.length;
  const gridCols = grid[0]?.length || 0;
  for (let r = 0; r < pieceGrid.length; r++) {
    for (let c = 0; c < pieceGrid[r].length; c++) {
      if (!pieceGrid[r][c]) continue;
      const tr = row + r;
      const tc = col + c;
      if (tr < 0 || tr >= gridRows || tc < 0 || tc >= gridCols) return false;
      if (grid[tr][tc]) return false;
    }
  }
  return true;
}

// Po rotácii/flipe nájde najbližšiu platnú pozíciu (pri okraji sa kúsok posunie dovnútra)
export function findNearestValidPosition(
  grid: boolean[][],
  pieceGrid: boolean[][],
  row: number,
  col: number,
  maxShift = 5
): { row: number; col: number } | null {
  if (fitsOnGrid(grid, pieceGrid, row, col)) return { row, col };

  let best: { row: number; col: number } | null = null;
  let bestDist = Infinity;
  for (let dr = -maxShift; dr <= maxShift; dr++) {
    for (let dc = -maxShift; dc <= maxShift; dc++) {
      const dist = dr * dr + dc * dc;
      if (dist >= bestDist) continue;
      if (fitsOnGrid(grid, pieceGrid, row + dr, col + dc)) {
        best = { row: row + dr, col: col + dc };
        bestDist = dist;
      }
    }
  }
  return best;
}

// Umiestnenie kúska na mriežku
export function placePiece(
  grid: boolean[][],
  pieceGrid: boolean[][],
  row: number,
  col: number,
  color: string
): boolean[][] {
  const newGrid = grid.map((r) => [...r]);
  const pieceRows = pieceGrid.length;
  const pieceCols = pieceGrid[0].length;

  for (let r = 0; r < pieceRows; r++) {
    for (let c = 0; c < pieceCols; c++) {
      if (pieceGrid[r][c]) {
        newGrid[row + r][col + c] = true;
      }
    }
  }

  return newGrid;
}

// Odstránenie kúska z mriežky
export function removePiece(
  grid: boolean[][],
  piece: PlacedPiece
): boolean[][] {
  const newGrid = grid.map((r) => [...r]);
  const pieceRows = piece.grid.length;
  const pieceCols = piece.grid[0].length;

  for (let r = 0; r < pieceRows; r++) {
    for (let c = 0; c < pieceCols; c++) {
      if (piece.grid[r][c]) {
        newGrid[piece.row + r][piece.col + c] = false;
      }
    }
  }

  return newGrid;
}

// Kontrola víťazstva: celý cieľový tvar je pokrytý
export function isLevelComplete(
  grid: boolean[][],
  targetShape: boolean[][]
): boolean {
  const rows = grid.length;
  const cols = grid[0].length;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Ak je cieľová bunka true, musí byť pokrytá
      if (targetShape[r][c] && !grid[r][c]) {
        return false;
      }
    }
  }

  return true;
}

// Vypočíta počet pokrytých buniek cieľového tvaru
export function getCoverage(
  grid: boolean[][],
  targetShape: boolean[][]
): { covered: number; total: number; percentage: number } {
  const rows = grid.length;
  const cols = grid[0].length;
  let covered = 0;
  let total = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (targetShape[r][c]) {
        total++;
        if (grid[r][c]) {
          covered++;
        }
      }
    }
  }

  const percentage = total > 0 ? Math.round((covered / total) * 100) : 0;

  return { covered, total, percentage };
}

// Normalizácia mriežky (odstránenie prázdnych okrajov)
export function normalizeGrid(grid: boolean[][]): boolean[][] {
  let minRow = grid.length;
  let maxRow = -1;
  let minCol = grid[0].length;
  let maxCol = -1;

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[0].length; c++) {
      if (grid[r][c]) {
        minRow = Math.min(minRow, r);
        maxRow = Math.max(maxRow, r);
        minCol = Math.min(minCol, c);
        maxCol = Math.max(maxCol, c);
      }
    }
  }

  if (maxRow === -1) return [[]]; // prázdna mriežka

  const normalized: boolean[][] = [];
  for (let r = minRow; r <= maxRow; r++) {
    const row: boolean[] = [];
    for (let c = minCol; c <= maxCol; c++) {
      row.push(grid[r][c]);
    }
    normalized.push(row);
  }

  return normalized;
}
