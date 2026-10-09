import { Block, Cell, SHAPES, ShapeName } from '../types/game';
import defaultConfig from '../config/config';

export function createBlock(shapeName: ShapeName, x: number, y: number): Block {
  return {
    shapeName,
    cells: SHAPES[shapeName].map((cell) => ({ ...cell })),
    x,
    y,
    rotation: 0,
  };
}

export function getAbsoluteCells(block: Block): Cell[] {
  return block.cells.map((cell) => ({
    x: block.x + cell.x,
    y: block.y + cell.y,
  }));
}

export function rotateBlock(block: Block, clockwise: boolean = true): Block {
  const newCells = block.cells.map((cell) => {
    if (clockwise) {
      return { x: -cell.y, y: cell.x };
    } else {
      return { x: cell.y, y: -cell.x };
    }
  });

  // Normalizovať súradnice k ľavému hornému rohu
  const minX = Math.min(...newCells.map((c) => c.x));
  const minY = Math.min(...newCells.map((c) => c.y));

  const normalizedCells = newCells.map((cell) => ({
    x: cell.x - minX,
    y: cell.y - minY,
  }));

  return {
    ...block,
    cells: normalizedCells,
    rotation: clockwise
      ? (block.rotation + 90) % 360
      : (block.rotation - 90 + 360) % 360,
  };
}

export function moveBlock(block: Block, dx: number, dy: number): Block {
  return {
    ...block,
    x: block.x + dx,
    y: block.y + dy,
  };
}

export function isBlockInBounds(block: Block): boolean {
  const cells = getAbsoluteCells(block);
  return cells.every(
    (cell) =>
      cell.x >= 0 &&
      cell.x < defaultConfig.GRID_WIDTH &&
      cell.y >= 0 &&
      cell.y < defaultConfig.GRID_HEIGHT,
  );
}

export function blocksCollide(block1: Block, block2: Block): boolean {
  const cells1 = new Set(getAbsoluteCells(block1).map((c) => `${c.x},${c.y}`));
  const cells2 = getAbsoluteCells(block2);

  return cells2.some((cell) => cells1.has(`${cell.x},${cell.y}`));
}

export function blocksMatch(block1: Block, block2: Block): boolean {
  const cells1 = new Set(getAbsoluteCells(block1).map((c) => `${c.x},${c.y}`));
  const cells2 = new Set(getAbsoluteCells(block2).map((c) => `${c.x},${c.y}`));

  if (cells1.size !== cells2.size) return false;

  for (const cell of cells1) {
    if (!cells2.has(cell)) return false;
  }

  return true;
}

export function findFarthestSpawnPosition(
  shapeName: ShapeName,
  targetBlock: Block,
  placedBlocks: Block[],
): { x: number; y: number } {
  const targetCells = getAbsoluteCells(targetBlock);
  const targetCenterX =
    targetCells.reduce((sum, c) => sum + c.x, 0) / targetCells.length;
  const targetCenterY =
    targetCells.reduce((sum, c) => sum + c.y, 0) / targetCells.length;

  let bestPos = { x: 0, y: 0 };
  let bestDistance = 0;

  for (let attempt = 0; attempt < 20; attempt++) {
    const x = Math.floor(Math.random() * (defaultConfig.GRID_WIDTH - 4));
    const y = Math.floor(Math.random() * (defaultConfig.GRID_HEIGHT - 4));

    const testBlock = createBlock(shapeName, x, y);

    // Skontrolovať, či nekoliduje s už položenými blokmi
    const collides = placedBlocks.some((placed) =>
      blocksCollide(testBlock, placed),
    );

    if (!collides && isBlockInBounds(testBlock)) {
      // Vypočítať vzdialenosť od stredu cieľa
      const blockCenterX = x + 1.5;
      const blockCenterY = y + 1.5;
      const distance = Math.sqrt(
        Math.pow(blockCenterX - targetCenterX, 2) +
          Math.pow(blockCenterY - targetCenterY, 2),
      );

      if (distance > bestDistance) {
        bestDistance = distance;
        bestPos = { x, y };
      }
    }
  }

  return bestPos;
}

export function areCellsAdjacent(
  cells: Cell[],
  occupiedCells: Set<string>,
): boolean {
  for (const cell of cells) {
    const neighbors = [
      { x: cell.x - 1, y: cell.y },
      { x: cell.x + 1, y: cell.y },
      { x: cell.x, y: cell.y - 1 },
      { x: cell.x, y: cell.y + 1 },
    ];

    for (const neighbor of neighbors) {
      if (occupiedCells.has(`${neighbor.x},${neighbor.y}`)) {
        return true;
      }
    }
  }

  return false;
}
