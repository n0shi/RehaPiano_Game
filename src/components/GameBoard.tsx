import { useEffect, useState, useRef } from 'react';
import { Image, Coffee } from 'lucide-react';
import SingleIMUController from '../utils/imuController';
import {
  Block,
  GameState,
  ShapeName,
  SHAPES,
  FingerCalibration,
} from '../types/game';
import {
  createBlock,
  getAbsoluteCells,
  rotateBlock,
  moveBlock,
  isBlockInBounds,
  blocksCollide,
  blocksMatch,
  findFarthestSpawnPosition,
} from '../utils/blockUtils';
import { ModalBackdrop } from './ModalBackdrop';
import { HandVisualization } from './HandVisualization';
import { useConfig } from '../config/ConfigContext';
import { useCalibration } from '../context/CalibrationContext';
import { CalibrationModal } from './CalibrationModal';
import type { AppConfig } from '../config/config';

interface GameBoardProps {
  useLeftHand: boolean;
  fingerKeys: string[];
  fingerNames: string[];
  calibrations: FingerCalibration[];
  onBackToMenu: () => void;
  maxLevels?: number;
}

interface PuzzlePiece {
  targetBlock: Block;
  color: string;
  isPlaced: boolean;
}

interface Puzzle {
  pieces: PuzzlePiece[];
  name: string;
}

function generatePuzzle(level: number, cfg: AppConfig): Puzzle {
  // Pomocná funkcia: zistí, či aspoň jedna bunka bloku je dosiahnuteľná z už položených blokov
  function isBlockReachable(
    blockCells: { x: number; y: number }[],
    occupied: Set<string>,
  ) {
    const visited = new Set<string>();
    const queue: { x: number; y: number }[] = [];
    // Začni BFS zo všetkých voľných buniek, ktoré susedia s už položenými
    for (let x = 0; x < gridWidth; x++) {
      for (let y = 0; y < gridHeight; y++) {
        const key = `${x},${y}`;
        if (!occupied.has(key)) {
          if (
            [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ].some(([dx, dy]) => occupied.has(`${x + dx},${y + dy}`))
          ) {
            queue.push({ x, y });
            visited.add(key);
          }
        }
      }
    }
    while (queue.length) {
      const { x, y } = queue.shift()!;
      if (blockCells.some((c) => c.x === x && c.y === y)) return true;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nx = x + dx,
          ny = y + dy;
        const nkey = `${nx},${ny}`;
        if (
          nx >= 0 &&
          nx < gridWidth &&
          ny >= 0 &&
          ny < gridHeight &&
          !occupied.has(nkey) &&
          !visited.has(nkey)
        ) {
          queue.push({ x: nx, y: ny });
          visited.add(nkey);
        }
      }
    }
    return false;
  }
  const gridWidth = cfg.GRID_WIDTH;
  const gridHeight = cfg.GRID_HEIGHT;
  let numBlocks = Math.min(level, cfg.MAX_PUZZLE_BLOCKS);
  const centerX = Math.floor(gridWidth / 2);
  const centerY = Math.floor(gridHeight / 2);

  const pieces: PuzzlePiece[] = [];
  // --- Logika sústredných kruhov ---
  // Pomocná funkcia: vráti všetky pozície mriežky v danej Manhattan vzdialenosti od stredu
  function getRingPositions(dist: number) {
    const positions: { x: number; y: number }[] = [];
    for (let x = 0; x < gridWidth; x++) {
      for (let y = 0; y < gridHeight; y++) {
        if (Math.abs(x - centerX) + Math.abs(y - centerY) === dist) {
          positions.push({ x, y });
        }
      }
    }
    return positions;
  }

  const shapeNames = Object.keys(SHAPES) as ShapeName[];
  const occupiedCells = new Set<string>();
  // Prvý blok umiestnený v strede
  const firstShape = shapeNames[Math.floor(Math.random() * shapeNames.length)];
  let firstBlock = createBlock(firstShape, centerX, centerY);
  pieces.push({
    targetBlock: firstBlock,
    color: (cfg.OUTLINE_COLORS && cfg.OUTLINE_COLORS[0]) || '#3B82F6',
    isPlaced: false,
  });
  getAbsoluteCells(firstBlock).forEach((cell) => {
    occupiedCells.add(`${cell.x},${cell.y}`);
  });

  let blocksPlaced = 1;
  let ring = 1;
  while (blocksPlaced < numBlocks) {
    const positions = getRingPositions(ring);
    for (const shape of shapeNames) {
      const possiblePositions: {
        pos: { x: number; y: number };
        block: Block;
      }[] = [];
      for (const pos of positions) {
        for (let rot = 0; rot < 4; rot++) {
          let block = createBlock(shape, pos.x, pos.y);
          for (let r = 0; r < rot; r++) block = rotateBlock(block, true);
          const blockCells = getAbsoluteCells(block);
          const noCollision = blockCells.every(
            (cell) => !occupiedCells.has(`${cell.x},${cell.y}`),
          );
          // Podmienka: blok musí susediť aspoň s dvoma už položenými bunkami
          let adjacentCount = 0;
          for (const cell of blockCells) {
            for (const [dx, dy] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ]) {
              if (occupiedCells.has(`${cell.x + dx},${cell.y + dy}`)) {
                adjacentCount++;
              }
            }
          }
          // Nová podmienka: blok musí byť dosiahnuteľný z už položených blokov
          const reachable = isBlockReachable(blockCells, occupiedCells);
          if (
            isBlockInBounds(block) &&
            noCollision &&
            adjacentCount >= 2 &&
            reachable
          ) {
            possiblePositions.push({ pos, block });
          }
        }
      }
      if (possiblePositions.length > 0 && blocksPlaced < numBlocks) {
        const pick =
          possiblePositions[
            Math.floor(Math.random() * possiblePositions.length)
          ];
        pieces.push({
          targetBlock: pick.block,
          color:
            (cfg.OUTLINE_COLORS &&
              cfg.OUTLINE_COLORS[blocksPlaced % cfg.OUTLINE_COLORS.length]) ||
            '#3B82F6',
          isPlaced: false,
        });
        getAbsoluteCells(pick.block).forEach((cell) => {
          occupiedCells.add(`${cell.x},${cell.y}`);
        });
        blocksPlaced++;
      }
      if (blocksPlaced >= numBlocks) break;
    }
    ring++;
  }

  return {
    name: `Úroveň ${level}`,
    pieces,
  };
}

// Aritmetická postupnosť pre počítanie celkového počtu položených blokov
function arithSum(a1: number, d: number, n: number): number {
  if (n <= 0) return 0;
  return Math.floor((n * (2 * a1 + (n - 1) * d)) / 2);
}

// Modálne okno po dokončení hry
interface GameFinishedModalProps {
  timeTaken: number;
  movesCount: number;
  placedCount: number;
  fingerName: string;
  onBackToMenu: () => void;
  onRestart: () => void;
  totalBlocks: number;
}

const GameFinishedModal: React.FC<GameFinishedModalProps> = ({
  timeTaken,
  movesCount,
  placedCount,
  fingerName,
  onBackToMenu,
  onRestart,
  totalBlocks,
}) => {
  // Pomocná funkcia pre formátovanie času
  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  return (
    // Vonkajší kontajner pre blur na pozadí - FIXED pre pokrytie celej obrazovky
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 backdrop-blur-lg"
      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      {/* Vnútorný kontajner modálu */}
      <div
        className="bg-white rounded-3xl shadow-2xl p-12 transform transition-all scale-100 animate-fadeinup"
        style={{ maxWidth: '800px', borderRadius: '24px', overflow: 'hidden' }}
      >
        <div className="flex flex-col items-center text-center">
          <Image className="w-12 h-12 text-green-600 mb-4" />
          <h2 className="text-4xl font-extrabold mb-3">
            Gratulujeme!
          </h2>
          <p className="text-xl text-slate-700 mb-8">
            Úspešne ste dokončili celú hru. Skvelá práca s prstami!
          </p>

          {/* Štatistiky */}
          <div className="w-full grid grid-cols-3 gap-4 mb-10 text-center">
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">Celkový čas</p>
              <p className="text-2xl font-bold text-green-800">
                {formatTime(timeTaken)}
              </p>
            </div>
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">Pohybov</p>
              <p className="text-2xl font-bold text-green-800">{movesCount}</p>
            </div>
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">
                Položených blokov
              </p>
              <p className="text-2xl font-bold text-green-800">
                {arithSum(1, 1, placedCount)}
              </p>
            </div>
          </div>

          {/* Tlačidlá v päte */}
          <div className="flex gap-4 w-full">
            <button
              onClick={onBackToMenu}
              className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
            >
              Späť na výber hry
            </button>

            <button
              onClick={onRestart}
              className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
            >
              Reštartovať hru
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export function GameBoard({
  useLeftHand,
  fingerKeys,
  fingerNames,
  calibrations,
  onBackToMenu,
  maxLevels,
}: GameBoardProps) {
  const cfg = useConfig();
  const effectiveMax =
    typeof maxLevels === 'number' ? maxLevels : cfg.MAX_PUZZLE_BLOCKS;
  const [currentBlock, setCurrentBlock] = useState<Block | null>(null);
  const [currentPieceIndex, setCurrentPieceIndex] = useState<number>(0);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [placedBlocks, setPlacedBlocks] = useState<Block[]>([]);
  const [gameState, setGameState] = useState<GameState>(GameState.IDLE);
  const [level, setLevel] = useState(1);
  const [leftPressed, setLeftPressed] = useState(false);
  const [currentFingerIndex, setCurrentFingerIndex] = useState(0);
  const [currentFingerPressed, setCurrentFingerPressed] = useState(false);
  // Referencie držia najnovšie hodnoty pre obsluhu IMU (zabraňujú zastaraným uzáverom)
  const currentBlockRef = useRef<Block | null>(null);
  const placedBlocksRef = useRef<Block[]>([]);
  const currentFingerIndexRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>(GameState.IDLE);
  const lastRotationTimeRef = useRef<number>(0);
  const [showRestPopup, setShowRestPopup] = useState(false);
  const [blockControlsAfterSpawn, setBlockControlsAfterSpawn] = useState(false);
  // Keď sa uloží posledný blok úrovne: najprv zobrazíme čierny obrys,
  // po krátkom oneskorení (200ms) zobrazíme popup "Oddychnite si".
  const [showSavedOutline, setShowSavedOutline] = useState(false);
  const savedOutlineTimerRef = useRef<number | null>(null);
  const restPopupTimerRef = useRef<number | null>(null);

  // --- STAVY PRE KONIEC HRY ---
  const [isGameFinished, setIsGameFinished] = useState(false);
  const [showHandModal, setShowHandModal] = useState(false);
  const [timeTaken, setTimeTaken] = useState(0);
  const [movesCount, setMovesCount] = useState(0);
  const [placedCorrectCount, setPlacedCorrectCount] = useState(0);

  const gridRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const moveCooldown = useRef(0);
  const pulseRef = useRef(0);
  const startTimeRef = useRef(Date.now()); // Pre sledovanie času
  const [scale, setScale] = useState<number>(1);
  
  // IMU controller
  const imuCtrlRef = useRef<SingleIMUController | null>(null);
  const lastImuTsRef = useRef<number | null>(null);
  const { isCalibrated, neutralQuat, requestCalibration } = useCalibration();
  const [imuDebug, setImuDebug] = useState<any>({});
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  // Allow player to pass through placed blocks when enabled (helps finish stuck levels)
  const [passThroughEnabled, setPassThroughEnabled] = useState<boolean>(false);
  const passThroughRef = useRef<boolean>(passThroughEnabled);
  useEffect(() => {
    passThroughRef.current = passThroughEnabled;
  }, [passThroughEnabled]);
  
  // === Relatívny pohyb bloku pri stlačení prsta ===
  const gripStartGridRef = useRef<{ x: number; y: number } | null>(null); // Pozícia ruky na začiatku
  const gripStartBlockRef = useRef<{ x: number; y: number } | null>(null); // Pozícia bloku na začiatku
  const wasPressingRef = useRef<boolean>(false); // Predchádzajúci stav stlačenia

  // Funkcia pre reštart celej hry
  function restartGame() {
    setLevel(1);
    spawnNewPuzzle(1);
    setIsGameFinished(false);
    setGameState(GameState.IDLE);
  }

  useEffect(() => {
    spawnNewPuzzle(1);
  }, []);

  // Request calibration on mount if not calibrated and WS connected
  useEffect(() => {
    if (wsConnected && !isCalibrated) {
      requestCalibration();
    }
  }, [wsConnected, isCalibrated, requestCalibration]);

  // Apply neutral quaternion from global calibration to IMU controller
  useEffect(() => {
    if (imuCtrlRef.current && neutralQuat) {
      imuCtrlRef.current.calibrateNeutral(neutralQuat);
    }
  }, [neutralQuat]);

  // Sledovanie zmien stavu WebSocket pripojenia
  useEffect(() => {
    // Skontroluj počiatočný stav z globálnej premennej (WS sa mohol pripojiť pred mountnutím tohto komponentu)
    if ((window as any).__wsConnected) {
      setWsConnected(true);
    }
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      setWsConnected(detail?.connected ?? false);
    };
    window.addEventListener('ws-connection-change', handler);
    return () => window.removeEventListener('ws-connection-change', handler);
  }, []);

  // Pulzujúca animačka použitá na jemné pulzovanie aktívnych/rotujúcich obrysov
  useEffect(() => {
    const interval = setInterval(() => {
      pulseRef.current = (pulseRef.current + 0.05) % (Math.PI * 2);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  function spawnNewPuzzle(levelNum: number, keepFingerIndex: boolean = false) {
    // Použiť upravený config tak, aby generatePuzzle rešpektoval zvolený maximálny počet úrovní
    const localCfg = { ...cfg, MAX_PUZZLE_BLOCKS: effectiveMax } as AppConfig;
    const newPuzzle = generatePuzzle(levelNum, localCfg);
    setPuzzle(newPuzzle);
    setPlacedBlocks([]);
    setCurrentPieceIndex(0);
    const fingerIndex = keepFingerIndex ? currentFingerIndex : 0;
    if (!keepFingerIndex) setCurrentFingerIndex(0);
    spawnNextPiece(newPuzzle, 0, [], fingerIndex);

    // --- Reset času a štatistík pri štarte prvej úrovne ---
    if (levelNum === 1 && !keepFingerIndex) {
      setIsGameFinished(false);
      setTimeTaken(0);
      setMovesCount(0);
      setPlacedCorrectCount(0);
      startTimeRef.current = Date.now();
    }
  }

  function spawnNextPiece(
    currentPuzzle: Puzzle,
    pieceIndex: number,
    placed: Block[],
    fingerIndex: number,
  ) {
    if (pieceIndex >= currentPuzzle.pieces.length) return;

    const targetBlock = currentPuzzle.pieces[pieceIndex].targetBlock;
    const position = findFarthestSpawnPosition(
      targetBlock.shapeName,
      targetBlock,
      placed,
    );
    const current = createBlock(targetBlock.shapeName, position.x, position.y);

    setCurrentBlock(current);
    setGameState(GameState.IDLE);
    setCurrentFingerIndex(fingerIndex);
  }

  // Synchronizovať referencie so stavom tak, aby event handlery používali aktuálne hodnoty
  useEffect(() => {
    currentBlockRef.current = currentBlock;
  }, [currentBlock]);
  useEffect(() => {
    placedBlocksRef.current = placedBlocks;
  }, [placedBlocks]);
  useEffect(() => {
    currentFingerIndexRef.current = currentFingerIndex;
  }, [currentFingerIndex]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Vypočíta mierku tak, aby sa celé horizontálne rozloženie zmestilo do viewportu na malých obrazovkách
  useEffect(() => {
    function computeScale() {
      const gridW = cfg.GRID_WIDTH * cfg.CELL_SIZE + 24; // šírka kontajnera mriežky
      const sideW = 400; // sidebar width
      const gap = 24; // medzera (gap-6)
      const contentWidth = gridW + gap + sideW;

      const gridH = cfg.GRID_HEIGHT * cfg.CELL_SIZE + 24;
      const footerH = 140; // približná výška päty
      const contentHeight = gridH + footerH;

      const padding = 48; // bezpečnostné odsadenie
      const vw = Math.max(320, window.innerWidth - padding);
      const vh = Math.max(480, window.innerHeight - padding);

      const s = Math.min(1, vw / contentWidth, vh / contentHeight) * 1.1;
      setScale(Number(s.toFixed(3)));
    }

    computeScale();
    window.addEventListener('resize', computeScale);
    return () => window.removeEventListener('resize', computeScale);
  }, []);

  function nextPuzzle() {
    if (puzzle && currentBlock) {
      const newPlacedBlocks = [...placedBlocks, currentBlock];
      setPlacedBlocks(newPlacedBlocks);

      const nextIndex = currentPieceIndex + 1;
      setCurrentPieceIndex(nextIndex);

      const nextFingerIndex = (currentFingerIndex + 1) % 5;

      if (nextIndex >= puzzle.pieces.length) {
        const nextLevel = level + 1;
        setLevel(nextLevel);
        setCurrentFingerIndex(nextFingerIndex);

        // --- Kontrola konca hry ---
        if (nextLevel > effectiveMax) {
          setIsGameFinished(true);
          setTimeTaken(Math.floor((Date.now() - startTimeRef.current) / 1000));
        } else {
          spawnNewPuzzle(nextLevel, true);
        }
      } else {
        spawnNextPiece(puzzle, nextIndex, newPlacedBlocks, nextFingerIndex);
      }
      
      // Reset gameState späť na IDLE aby sme mohli pokračovať
      setGameState(GameState.IDLE);
    }
  }

  // Obsluha klávesnice
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((window as any).__modalOpen) return;
      if (showRestPopup || blockControlsAfterSpawn) return; // Blokovať počas coffee break a po spawne
      const key = e.key.toLowerCase();
      if (key === fingerKeys[currentFingerIndex]) setCurrentFingerPressed(true);
      if (key === 'n') {
        if (!isGameFinished) nextPuzzle();
        else restartGame();
      }
      if (key === 'm') onBackToMenu();
      if (key === 'backspace') {
        restartGame();
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      if ((window as any).__modalOpen) return;
      if (showRestPopup || blockControlsAfterSpawn) return; // Blokovať počas coffee break a po spawne
      if (e.key.toLowerCase() === fingerKeys[currentFingerIndex])
        setCurrentFingerPressed(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [currentFingerIndex, fingerKeys, isGameFinished, showRestPopup, blockControlsAfterSpawn]);

  // Obsluha myši
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        if (showRestPopup || blockControlsAfterSpawn) return; // Blokovať počas coffee break a po spawne
        setLeftPressed(true);
        if (!isGameFinished) setGameState(GameState.GRABBED);
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        if (showRestPopup || blockControlsAfterSpawn) return; // Blokovať počas coffee break a po spawne
        setLeftPressed(false);
        if (!isGameFinished && gameState !== GameState.PLACED)
          setGameState(GameState.IDLE);
      }
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [gameState, isGameFinished, showRestPopup, blockControlsAfterSpawn]);

  function handleWheel(e: React.WheelEvent) {
    if (!currentBlock || !leftPressed || isGameFinished || showRestPopup || blockControlsAfterSpawn) return;

    e.preventDefault();
    const clockwise = e.deltaY < 0;
    let rotatedBlock = rotateBlock(currentBlock, clockwise);
    const collision = !passThroughRef.current && placedBlocks.some((p) => blocksCollide(rotatedBlock, p));
    if (isBlockInBounds(rotatedBlock) && !collision) {
      setCurrentBlock(rotatedBlock);
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (
      !currentFingerPressed ||
      leftPressed ||
      !currentBlock ||
      !gridRef.current ||
      isGameFinished ||
      showRestPopup ||
      blockControlsAfterSpawn
    )
      return;
    const now = Date.now();
    if (now - moveCooldown.current < 80) return;

    const rect = gridRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const gridX = Math.floor(mouseX / cfg.CELL_SIZE);
    const gridY = Math.floor(mouseY / cfg.CELL_SIZE);

    let newBlock = { ...currentBlock };

    // --- Zaznamenávanie pohybov ---
    if (gridX !== newBlock.x || gridY !== newBlock.y) {
      setMovesCount((m) => m + 1);
    }

      if (gridX > currentBlock.x) {
      newBlock = moveBlock(newBlock, 1, 0);
      if (
        !isBlockInBounds(newBlock) ||
        (!passThroughRef.current && placedBlocks.some((p) => blocksCollide(newBlock, p)))
      ) {
        newBlock = moveBlock(newBlock, -1, 0);
      }
    } else if (gridX < currentBlock.x) {
      newBlock = moveBlock(newBlock, -1, 0);
      if (
        !isBlockInBounds(newBlock) ||
        (!passThroughRef.current && placedBlocks.some((p) => blocksCollide(newBlock, p)))
      ) {
        newBlock = moveBlock(newBlock, 1, 0);
      }
    }

    if (gridY > newBlock.y) {
      newBlock = moveBlock(newBlock, 0, 1);
      if (
        !isBlockInBounds(newBlock) ||
        (!passThroughRef.current && placedBlocks.some((p) => blocksCollide(newBlock, p)))
      ) {
        newBlock = moveBlock(newBlock, 0, -1);
      }
    } else if (gridY < newBlock.y) {
      newBlock = moveBlock(newBlock, 0, -1);
      if (
        !isBlockInBounds(newBlock) ||
        (!passThroughRef.current && placedBlocks.some((p) => blocksCollide(newBlock, p)))
      ) {
        newBlock = moveBlock(newBlock, 0, 1);
      }
    }

    setCurrentBlock(newBlock);
    lastMousePos.current = { x: mouseX, y: mouseY };
    moveCooldown.current = now;
  }

  // ------------------ Integrácia IMU / tensometra ------------------
  useEffect(() => {
    if (!imuCtrlRef.current) {
      imuCtrlRef.current = new SingleIMUController();
      // Nastavenie grid size podľa konfigurácie (use GRID_WIDTH to reduce lateral sensitivity)
      imuCtrlRef.current.gridSize = cfg.GRID_WIDTH;
      // Tuning to reduce perceived movement speed / make smoothing stronger
      imuCtrlRef.current.gridSmoothAlpha = 0.06; // smoother, slower-to-react
      imuCtrlRef.current.gridChangeThreshold = 0.85; // require closer to target before snapping
      imuCtrlRef.current.posAlpha = 0.18; // slower pos response
      imuCtrlRef.current.precisionScale = 1.2; // reduce precision amplification when gripping
    }

    function onSample(ev: Event) {
      if ((window as any).__modalOpen) return;
      if (isGameFinished || showRestPopup || blockControlsAfterSpawn || gameStateRef.current === GameState.PLACED) return;
      try {
        const detail: any = (ev as CustomEvent).detail;
        if (!detail) return;
        
        const now = Date.now();
        const last = lastImuTsRef.current ?? now;
        const dt = Math.max(1, now - last) / 1000;
        lastImuTsRef.current = now;

        // Priprav sample pre IMU controller
        const sample = { 
          imu: detail.imu || {}, 
          adc: detail.adc || [], 
          ts: now 
        } as any;

        // Spracovanie pomocou IMU controllera
        const out = imuCtrlRef.current!.update(sample, dt);

        // Aktualizácia debug dát pre kalibráciu
        setImuDebug({
          pitch: Math.round((sample.imu.pitch ?? 0) / 16 * 10) / 10,
          roll: Math.round((sample.imu.roll ?? 0) / 16 * 10) / 10,
          yaw: Math.round((sample.imu.yaw ?? 0) / 16 * 10) / 10,
          gyro: out.gyro,
          grip: out.grip,
          quat: sample.imu.quatW !== undefined ? {
            w: sample.imu.quatW ?? 0,
            x: sample.imu.quatX ?? 0,
            y: sample.imu.quatY ?? 0,
            z: sample.imu.quatZ ?? 0,
          } : undefined,
        });

        // GRIP DETEKCIA - správne spracovanie ADC dát
        const adcArray: number[] = Array.isArray(detail.adc) ? detail.adc : [];
        const fingersRaw = adcArray.length >= 6
          ? adcArray.slice(1, 6).map((v: any) => Number(v || 0))
          : [0, 0, 0, 0, 0];
        const fingers = useLeftHand ? fingersRaw : fingersRaw.slice().reverse();

        const defaultRawThr = (cfg as any).TENSOMETER_RAW_THRESHOLD ?? 2000;
        const defaultNormThr = (cfg as any).TENSOMETER_NORM_THRESHOLD ?? 12;

        // Spočítať stlačené prsty
        let pressedCount = 0;
        for (let i = 0; i < fingers.length; i++) {
          const thr =
            calibrations && calibrations[i] && calibrations[i].threshold
              ? calibrations[i].threshold
              : defaultRawThr;
          const raw = Math.abs(fingers[i] ?? 0);
          const norm = raw / 128;
          const isPressed = raw > thr || norm > defaultNormThr;
          if (isPressed) pressedCount++;
        }
        const grab = pressedCount === 5;

        // Index aktívneho prsta
        const activeIdx = currentFingerIndexRef.current ?? 0;
        const activeVal = fingers[activeIdx] ?? 0;
        const activeThr =
          calibrations &&
          calibrations[activeIdx] &&
          calibrations[activeIdx].threshold
            ? calibrations[activeIdx].threshold
            : defaultRawThr;
        const activeRaw = Math.abs(activeVal);
        const activeNorm = activeRaw / 128;
        const singlePressed = !grab && (activeRaw > activeThr || activeNorm > defaultNormThr);

        // Aktualizovať UI stavy
        setLeftPressed(grab);
        setCurrentFingerPressed(singlePressed);

        // POHYB BLOKU (RELATÍVNY): keď je stlačený jeden prst -> pohýbaj relatívne od začiatku stlačenia
        if (singlePressed && currentBlockRef.current) {
          // Use unified mapping: X direct, Y inverted for left hand (consistent with Pentomino/Tetris)
          const gridX = out.grid.x;
          const gridY = useLeftHand ? (imuCtrlRef.current!.gridSize - 1 - out.grid.y) : out.grid.y;

          // Ak začíname nové stlačenie, uložíme počiatočné pozície
          if (!wasPressingRef.current) {
            gripStartGridRef.current = { x: gridX, y: gridY };
            gripStartBlockRef.current = { x: currentBlockRef.current.x, y: currentBlockRef.current.y };
            wasPressingRef.current = true;
          }

          // Vypočítaj relatívny posun od začiatku stlačenia
          const startGrid = gripStartGridRef.current;
          const startBlock = gripStartBlockRef.current;

          if (startGrid && startBlock) {
            const deltaX = gridX - startGrid.x;
            const deltaY = gridY - startGrid.y;
            
            // Nová pozícia bloku = počiatočná pozícia + posun
            const targetX = Math.max(0, Math.min(cfg.GRID_WIDTH - 1, startBlock.x + deltaX));
            const targetY = Math.max(0, Math.min(cfg.GRID_HEIGHT - 1, startBlock.y + deltaY));

            // Ak sa pozícia zmenila, skús premiestniť blok
            if (targetX !== currentBlockRef.current.x || targetY !== currentBlockRef.current.y) {
              let newBlock = { ...currentBlockRef.current, x: targetX, y: targetY };
              
              // Kontrola hraníc a kolízií (respektuj pass-through režim)
              if (
                isBlockInBounds(newBlock) &&
                (passThroughRef.current || !placedBlocksRef.current.some((p) => blocksCollide(newBlock, p)))
              ) {
                setCurrentBlock(newBlock);
                setMovesCount((m) => m + 1);
              }
            }
          }
        } else {
          // Prst bol uvoľnený - resetuj počiatočné pozície
          if (wasPressingRef.current) {
            wasPressingRef.current = false;
            gripStartGridRef.current = null;
            gripStartBlockRef.current = null;
          }
        }

        // ROTÁCIA: keď je 'grab' (všetky prsty) -> otáčaj podľa osi Z gyra
        const GYRO_ROTATION_THRESHOLD = 50; // deg/s
        const GYRO_ROTATION_COOLDOWN_MS = 300; // ms
        
        if (grab && currentBlockRef.current) {
          if (now - lastRotationTimeRef.current >= GYRO_ROTATION_COOLDOWN_MS) {
            const gyro = out.gyro || { x: 0, y: 0, z: 0 };
            
            if (gyro.z > GYRO_ROTATION_THRESHOLD) {
              const rotated = rotateBlock(currentBlockRef.current, true);
              if (
                isBlockInBounds(rotated) &&
                (passThroughRef.current || !placedBlocksRef.current.some((p) => blocksCollide(rotated, p)))
              ) {
                setCurrentBlock(rotated);
                lastRotationTimeRef.current = now;
              }
            } else if (gyro.z < -GYRO_ROTATION_THRESHOLD) {
              const rotated = rotateBlock(currentBlockRef.current, false);
              if (
                isBlockInBounds(rotated) &&
                (passThroughRef.current || !placedBlocksRef.current.some((p) => blocksCollide(rotated, p)))
              ) {
                setCurrentBlock(rotated);
                lastRotationTimeRef.current = now;
              }
            }
          }
        }
      } catch (e) {
        // Nekritická chyba — ignorovať neplatné alebo poškodené vzorky
      }
    }

    const wrappedImu = (ev: Event) => {
      if ((window as any).__modalOpen) return;
      onSample(ev as any);
    };
    window.addEventListener('imu-sample', wrappedImu as EventListener);
    return () =>
      window.removeEventListener('imu-sample', wrappedImu as EventListener);
  }, [cfg, isGameFinished, showRestPopup, blockControlsAfterSpawn]);

  // Skontrolovať zhodu blokov
  useEffect(() => {
    if (
      !leftPressed &&
      !currentFingerPressed &&
      gameState !== GameState.PLACED &&
      currentBlock &&
      puzzle
    ) {
      const currentPiece = puzzle.pieces[currentPieceIndex];
      if (currentPiece && blocksMatch(currentBlock, currentPiece.targetBlock)) {
        setGameState(GameState.PLACED);
        const updatedPuzzle = {
          ...puzzle,
          pieces: puzzle.pieces.map((p, i) =>
            i === currentPieceIndex ? { ...p, isPlaced: true } : p,
          ),
        };
        setPuzzle(updatedPuzzle);
        // Aktualizácia počtu správne umiestnených blokov
        setPlacedCorrectCount(
          updatedPuzzle.pieces.filter((p) => p.isPlaced).length,
        );
      }
    }
  }, [
    leftPressed,
    currentFingerPressed,
    currentBlock,
    puzzle,
    currentPieceIndex,
    gameState,
  ]);

  // Logika po umiestnení bloku (a po dokončení levelu)
  useEffect(() => {
    if (gameState === GameState.PLACED && currentBlock && puzzle) {
      const allPlaced = puzzle.pieces.every((p) => p.isPlaced);
      if (allPlaced) {
        const nextLevel = level + 1;
        // Koniec hry — okamžite ukonči
        if (nextLevel > effectiveMax) {
          // očisti prípadné timery
          if (savedOutlineTimerRef.current) {
            clearTimeout(savedOutlineTimerRef.current);
            savedOutlineTimerRef.current = null;
          }
          if (restPopupTimerRef.current) {
            clearTimeout(restPopupTimerRef.current);
            restPopupTimerRef.current = null;
          }
          setShowSavedOutline(false);
          setShowRestPopup(false);
          setIsGameFinished(true);
          setTimeTaken(Math.floor((Date.now() - startTimeRef.current) / 1000));
        } else {
          // Najprv explicitne zobrazíme čierny obrys uloženého bloku
          setShowSavedOutline(true);

          // Po ~200ms zobrazíme popup "Oddychnite si" a po cfg.COFFEE_BREAK prejdeme ďalej
          if (savedOutlineTimerRef.current) {
            clearTimeout(savedOutlineTimerRef.current);
            savedOutlineTimerRef.current = null;
          }
          savedOutlineTimerRef.current = window.setTimeout(() => {
            setShowRestPopup(true);

            if (restPopupTimerRef.current) {
              clearTimeout(restPopupTimerRef.current);
              restPopupTimerRef.current = null;
            }
            restPopupTimerRef.current = window.setTimeout(() => {
              setShowRestPopup(false);
              setShowSavedOutline(false);
              nextPuzzle();
              setBlockControlsAfterSpawn(true);
              setTimeout(() => {
                setBlockControlsAfterSpawn(false);
              }, 500);
            }, cfg.COFFEE_BREAK);
          }, 200);
        }
      } else {
        nextPuzzle();
      }
    }

    return () => {
      if (savedOutlineTimerRef.current) {
        clearTimeout(savedOutlineTimerRef.current);
        savedOutlineTimerRef.current = null;
      }
      if (restPopupTimerRef.current) {
        clearTimeout(restPopupTimerRef.current);
        restPopupTimerRef.current = null;
      }
    };
  }, [
    gameState,
    currentBlock,
    puzzle,
    level,
    cfg.COFFEE_BREAK,
    effectiveMax,
    nextPuzzle,
  ]);

  useEffect(() => {
    if (leftPressed) setGameState(GameState.GRABBED);
    else if (currentFingerPressed && !leftPressed)
      setGameState(GameState.MOVING);
    else if (gameState !== GameState.PLACED && !isGameFinished)
      setGameState(GameState.IDLE);
    else if (isGameFinished) setGameState(GameState.IDLE);
  }, [leftPressed, currentFingerPressed, isGameFinished]);

  return (
    <div className="fixed inset-0 h-screen w-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 overflow-hidden">

      {/* Calibration Modal always present, but only visible if context says so */}
      <CalibrationModal useLeftHand={useLeftHand} />
      
      {/* Modal mimo škálovaného kontajnera */}
      {(isGameFinished || showHandModal) && (
        <ModalBackdrop>
          <GameFinishedModal
            timeTaken={
              isGameFinished
                ? timeTaken
                : Math.floor((Date.now() - startTimeRef.current) / 1000)
            }
            movesCount={movesCount}
            placedCount={
              isGameFinished ? placedCorrectCount : placedCorrectCount // alebo placedBlocks.length ak treba
            }
            fingerName={fingerNames[currentFingerIndex]}
            onBackToMenu={() => {
              setShowHandModal(false);
              onBackToMenu();
            }}
            onRestart={() => {
              setShowHandModal(false);
              restartGame();
            }}
            totalBlocks={puzzle ? puzzle.pieces.length : 0}
          />
        </ModalBackdrop>
      )}

      {/* Vertikálne centrovať hernú plochu a bočný panel */}
      <div
        ref={contentRef}
        className="mx-auto flex flex-col items-center justify-center h-full"
        style={{
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: scale < 1 ? 'center center' : undefined,
          position: 'relative',
          minHeight: '80vh',
        }}
      >
        {/* Herná plocha - bez blur efektu (modal má vlastný backdrop blur) */}
        <div className="flex gap-6 items-start max-w-[1600px] transition-filter duration-500">
          {/* Herná mriežka */}
          <div className="flex flex-col gap-4">
            <div
              ref={gridRef}
              className="relative bg-white rounded-2xl shadow-2xl p-3 transition-shadow duration-200"
              style={{
                width: cfg.GRID_WIDTH * cfg.CELL_SIZE + 24,
                height: cfg.GRID_HEIGHT * cfg.CELL_SIZE + 24,
                boxShadow: gameState === GameState.GRABBED
                  ? '0 0 12px 12px rgba(252, 186, 3, 0.35), 0 0 24px 8px rgba(147, 51, 234, 0.15)'
                  : gameState === GameState.MOVING
                    ? '0 0 12px 12px rgba(34, 197, 94, 0.4), 0 0 24px 8px rgba(22, 163, 74, 0.2)'
                    : undefined,
              }}
              onWheel={handleWheel}
              onMouseMove={handleMouseMove}
              onContextMenu={(e) => e.preventDefault()}
            >
              {/* Popup na oddych - presne uprostred mriežky */}
              {showRestPopup && (
                <div className="absolute top-6 left-1/2 z-[100] flex items-center justify-center gap-4 px-8 py-5 rounded-2xl popup-green-glass opacity-0 animate-fade-in-only" style={{ transform: 'translateX(-50%)' }}>
                  <Coffee className="w-8 h-8 text-green-600 drop-shadow" />
                  <span className="text-2xl font-bold tracking-wide text-green-900">
                    Oddychnite si
                  </span>
                </div>
              )}

              {/* Čiary mriežky */}
              <div
                className="absolute inset-3 grid"
                style={{
                  gridTemplateColumns: `repeat(${cfg.GRID_WIDTH}, ${cfg.CELL_SIZE}px)`,
                  gridTemplateRows: `repeat(${cfg.GRID_HEIGHT}, ${cfg.CELL_SIZE}px)`,
                }}
              >
                {Array.from({ length: cfg.GRID_WIDTH * cfg.GRID_HEIGHT }).map(
                  (_, i) => (
                    <div key={i} className="border border-slate-200" />
                  ),
                )}
              </div>

              {/* Obrysy cieľových blokov */}
              {puzzle &&
                puzzle.pieces.map((piece, pieceIdx) => {
                  const isActive =
                    pieceIdx === currentPieceIndex && !piece.isPlaced; // Aktivny len ak je na rade a nie je este umiestneny
                  const isPast = pieceIdx < currentPieceIndex;
                  const isFuture = pieceIdx > currentPieceIndex;

                  const pieceColor = piece.color;

                  const pulse = (Math.sin(pulseRef.current) + 1) / 2;
                  const activeOpacity = 0.6 + 0.3 * pulse;

                  return getAbsoluteCells(piece.targetBlock).map(
                    (cell, cellIdx) => (
                      <div
                        key={`target-cell-container-${pieceIdx}-${cellIdx}`}
                        className="absolute transition-all"
                        style={{
                          left: 12 + cell.x * cfg.CELL_SIZE + 3,
                          top: 12 + cell.y * cfg.CELL_SIZE + 3,
                          width: cfg.CELL_SIZE - 6,
                          height: cfg.CELL_SIZE - 6,
                          opacity: isPast
                            ? 0.25
                            : isActive
                              ? activeOpacity
                              : isFuture
                                ? 0.6
                                : 0.8,
                        }}
                      >
                        {/* Výplň s animáciou pre aktívny blok */}
                        {isActive && (
                          <div
                            className="absolute inset-0 rounded-sm fill-breathe"
                            style={{
                              backgroundColor: pieceColor,
                            }}
                          />
                        )}

                        {/* Obrys */}
                        <div
                          key={`target-outline-${pieceIdx}-${cellIdx}`}
                          className="absolute inset-0 border-4 rounded pointer-events-none"
                          style={{
                            borderColor: pieceColor,
                            opacity: isPast
                              ? 0.3
                              : isActive
                                ? 1
                                : isFuture
                                  ? 0.6
                                  : 0.8,
                          }}
                        />
                      </div>
                    ),
                  );
                })}

              {/* Položené bloky */}
              {placedBlocks.map((block, blockIdx) =>
                getAbsoluteCells(block).map((cell, cellIdx) => {
                  const color =
                    puzzle?.pieces[blockIdx]?.color ||
                    (cfg.OUTLINE_COLORS && cfg.OUTLINE_COLORS[0]) ||
                    '#3B82F6';
                  return (
                    <div
                      key={`placed-${blockIdx}-${cellIdx}`}
                      className="absolute rounded border-4"
                      style={{
                        left: 12 + cell.x * cfg.CELL_SIZE + 3,
                        top: 12 + cell.y * cfg.CELL_SIZE + 3,
                        width: cfg.CELL_SIZE - 6,
                        height: cfg.CELL_SIZE - 6,
                        backgroundColor: color,
                        borderColor: `color-mix(in srgb, ${color} 30%, black)`,
                        opacity: passThroughEnabled ? 0.45 : 1,
                        filter: passThroughEnabled ? 'grayscale(40%)' : undefined,
                      }}
                    />
                  );
                }),
              )}

              {/* Overlay: keď uložíme posledný blok, ukážeme ho hneď s čiernym obrysom */}
              {showSavedOutline && currentBlock &&
                getAbsoluteCells(currentBlock).map((cell, idx) => {
                  const color =
                    puzzle?.pieces[currentPieceIndex]?.color ||
                    (cfg.OUTLINE_COLORS && cfg.OUTLINE_COLORS[0]) ||
                    '#3B82F6';
                  return (
                    <div
                      key={`saved-outline-${idx}`}
                      className="absolute rounded border-4 pointer-events-none"
                      style={{
                        left: 12 + cell.x * cfg.CELL_SIZE + 3,
                        top: 12 + cell.y * cfg.CELL_SIZE + 3,
                        width: cfg.CELL_SIZE - 6,
                        height: cfg.CELL_SIZE - 6,
                        backgroundColor: color,
                        borderColor: 'black',
                        zIndex: 90,
                      }}
                    />
                  );
                })}

              {/* Aktuálny blok */}
              {currentBlock &&
                puzzle &&
                getAbsoluteCells(currentBlock).map((cell, i) => {
                  const targetColor = puzzle.pieces[currentPieceIndex]?.color;

                  return (
                    <div
                      key={`current-${i}`}
                      className="absolute rounded-lg shadow-lg transition-all"
                      style={{
                        left: 12 + cell.x * cfg.CELL_SIZE + 3,
                        top: 12 + cell.y * cfg.CELL_SIZE + 3,
                        width: cfg.CELL_SIZE - 6,
                        height: cfg.CELL_SIZE - 6,
                      }}
                    >
                      <div
                        className="w-full h-full rounded shadow-lg"
                        style={{
                          backgroundColor:
                            targetColor ||
                            (cfg.OUTLINE_COLORS && cfg.OUTLINE_COLORS[0]) ||
                            '#3B82F6',
                        }}
                      />
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Bočný panel */}
          <div
            className="flex w-[400px] flex-col rounded-2xl bg-white p-6 shadow-2xl justify-between"
            style={{ height: 20 * cfg.CELL_SIZE + 24 }}
          >
            <div className="flex-1 overflow-auto">
            {/* Úroveň */}
            {puzzle && (
              <div className="mb-3 space-y-3">
                <div className="bg-purple-50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Image className="w-6 h-6 text-purple-600" />
                    <p className="text-purple-900 text-lg font-bold">Presúvanie blokov</p>
                  </div>
                  <p className="text-purple-700">{puzzle.name}</p>
                </div>
              </div>
            )}

            {/* Vizualizácia ruky */}
            <div className="mt-3 rounded-xl bg-slate-50 p-6 mb-4">
              <div className="mb-3 rounded-lg border border-slate-200 bg-white px-4 py-3 relative">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500 absolute left-4 top-1/2 -translate-y-1/2">
                  Stav
                </span>

                <div className="flex items-center justify-center">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: isGameFinished
                          ? '#10b981'
                          : gameState === GameState.IDLE
                            ? '#94a3b8'
                            : gameState === GameState.GRABBED
                              ? '#f59e0b'
                              : gameState === GameState.MOVING
                                ? '#22c55e'
                                : '#64748b',
                      }}
                    />
                    <span
                      className="text-sm font-medium"
                      style={{
                        color: isGameFinished
                          ? '#059669'
                          : gameState === GameState.IDLE
                            ? '#64748b'
                            : gameState === GameState.GRABBED
                              ? '#d97706'
                              : gameState === GameState.MOVING
                                ? '#22c55e'
                                : '#374151',
                      }}
                    >
                      {isGameFinished
                        ? 'Hra Ukončená'
                        : gameState === GameState.IDLE
                          ? 'Čaká sa'
                          : gameState === GameState.GRABBED
                            ? 'Rotovanie'
                            : gameState === GameState.MOVING
                              ? 'Presúvanie'
                              : 'Neznámy stav'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="w-64 mx-auto">
                <HandVisualization
                  activeFingerIndex={
                    useLeftHand ? 4 - currentFingerIndex : currentFingerIndex
                  }
                  isFingerPressed={currentFingerPressed}
                  useLeftHand={useLeftHand}
                />
              </div>
            </div>

            {/* Inštrukcie pre ovládanie */}
            <div className="rounded-xl bg-blue-50 p-4">
                <h3 className="text-lg font-bold text-blue-900 mb-3 flex items-center gap-2">
                  Informácie
                </h3>
                <div className="space-y-2 text-md text-blue-700">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-2 rounded-full bg-blue-500"></div>
                    <p><span className="font-semibold">Stlačenie konkrétneho prsta + pohyb rukou →</span> Blok sa posúva</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-2 rounded-full bg-green-500"></div>
                    <p><span className="font-semibold">Stlačenie všetkých prstov + otočenie zápästia →</span> Otočenie bloku</p>
                  </div>
                </div>
              </div>

            </div>{/* end scrollable top */}

            {/* Tlačidlá na výber ruky a reštart */}
            <div className="flex flex-col gap-3 mt-2">
              <button
                onClick={() => setPassThroughEnabled(!passThroughEnabled)}
                className={`w-full rounded-xl py-3 px-6 transition-colors font-medium border-0 focus:outline-none focus:ring-0 ${passThroughEnabled ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-800'}`}
              >
                {passThroughEnabled ? 'Presun cez bloky' : 'Presun cez bloky'}
              </button>

              <button
                onClick={() => {
                  if (placedCorrectCount > 0) {
                    setShowHandModal(true);
                  } else {
                    onBackToMenu();
                  }
                }}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
              >
                Ukončiť hru
              </button>
              <button
                onClick={restartGame}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
              >
                Reštartovať hru
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
