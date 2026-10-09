import { useState, useEffect, useCallback, useRef } from 'react';
import SingleIMUController from '../utils/imuController';
import { useConfig } from '../config/ConfigContext';
import { useCalibration } from '../context/CalibrationContext';
import { CalibrationModal } from './CalibrationModal';
import { ModalBackdrop } from './ModalBackdrop';
import { Shapes, Coffee, Undo2 } from 'lucide-react';
import {
  PENTOMINO_SHAPES,
  PentominoShape,
  rotatePentomino,
  flipPentomino,
} from '../data/pentominoShapes';
import levelsData from '../data/pentominoLevels.json';
import {
  PlacedPiece,
  PentominoLevel,
  canPlacePiece,
  placePiece,
  removePiece,
  isLevelComplete,
  getCoverage,
} from '../utils/pentominoUtils';
import { FingerCalibration } from '../types/game';
import '../animations.css';

type Props = {
  useLeftHand: boolean;
  fingerKeys: string[];
  fingerNames: string[];
  calibrations: FingerCalibration[];
  onBackToMenu: () => void;
  maxLevels?: number;
};

type DraggingPiece = {
  shape: PentominoShape;
  grid: boolean[][];
  offsetX: number;
  offsetY: number;
  originalUid?: string; // UID bloku pred dragovaním
};

export function PentominoGame({
  useLeftHand,
  fingerKeys,
  fingerNames,
  calibrations,
  onBackToMenu,
  maxLevels = 6,
}: Props) {
  const cfg = useConfig();
  const CELL_SIZE = cfg?.CELL_SIZE ?? 48;

  // Generátor unikátnych ID pre uložené bloky
  const genUid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;


  // Povoliť štart na konkrétnom leveli pomocou URL query parametra `startLevel` (1-based).
  // Príklad: otvoriť aplikáciu s `?startLevel=11` pre preskočenie priamo na level 11.
  const initialLevelIndex = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = Number(params.get('startLevel') ?? NaN);
      if (!Number.isNaN(v) && v >= 1) {
        const idx = Math.max(0, Math.min(v - 1, Math.max(0, maxLevels - 1)));
        return idx;
      }
    } catch (e) {
      // ignorovať (napr. SSR alebo nesprávne URL)
    }
    return 0;
  })();
  const [currentLevelIndex, setCurrentLevelIndex] = useState(initialLevelIndex);
  const [grid, setGrid] = useState<boolean[][]>([]);
  const [placedPieces, setPlacedPieces] = useState<PlacedPiece[]>([]);
  const [availablePieces, setAvailablePieces] = useState<PentominoShape[]>([]); // Dostupné kúsky na umiestnenie
  const [draggingPiece, setDraggingPiece] = useState<DraggingPiece | null>(
    null
  );
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  // showRestPopup zobrazuje popup na oddych (káva)
  const [showRestPopup, setShowRestPopup] = useState(false);
  // Štatistiky a modal po ukončení hry
  const [showFinishedModal, setShowFinishedModal] = useState(false);
  const [timeTaken, setTimeTaken] = useState(0);
  const [movesCount, setMovesCount] = useState(0); // Počet pohybov (ťahov)
  const [totalPlacedCount, setTotalPlacedCount] = useState(0);
  const [levelPlacedCounts, setLevelPlacedCounts] = useState<number[]>([]);
  const [activePieceId, setActivePieceId] = useState<string | null>(null); // UID aktívneho kúska, null = žiadny
  const [originalPosition, setOriginalPosition] = useState<{row: number, col: number} | null>(null); // Pôvodná pozícia pri presúvaní
  const [reloadKey, setReloadKey] = useState<number>(0);
  // História pre funkciu undo - ukladá predchádzajúce stavy
  type HistoryState = {
    grid: boolean[][];
    placedPieces: PlacedPiece[];
    availablePieces: PentominoShape[];
    activePieceId: string | null;
  };
  const [historyStack, setHistoryStack] = useState<HistoryState[]>([]);
  const [scale, setScale] = useState<number>(1);
  const scaleRef = useRef<number>(1); // Ref pre scale - použité v mouse handleroch
  const contentRef = useRef<HTMLDivElement>(null);
  // IMU ovládač
  const imuCtrlRef = useRef<SingleIMUController | null>(null);
  const lastImuTsRef = useRef<number | null>(null);
  const lastGestureTimeRef = useRef<number>(0); // Samostatný timestamp pre gestá
  const lastPieceSwitchTimeRef = useRef<number>(0); // Timestamp pre zmenu blokov
  // === Relatívny pohyb bloku pri gripe ===
  const gripStartGridRef = useRef<{ x: number; y: number } | null>(null); // Pozícia ruky na začiatku gripu
  const gripStartPieceRef = useRef<{ row: number; col: number } | null>(null); // Pozícia bloku na začiatku gripu
  const wasGrippingRef = useRef<boolean>(false); // Predchádzajúci stav gripu
  const movementStartedRef = useRef<boolean>(false); // Či už začal pohyb (po uplynutí TAP_MAX_DURATION)
  const isRotatingRef = useRef<boolean>(false); // Či práve prebieha rotácia (blokuje pohyb)
  const flipDirectionRef = useRef<number>(0); // Smer prvého flipu v rámci gripu (1 alebo -1, 0 = žiadny)
  const wasThumbPressedRef = useRef<boolean>(false); // Predchádzajúci stav palca (pre rising edge detekciu)
  const gripStartTimeRef = useRef<number>(0); // Čas začiatku gripu pre rozlíšenie tap vs hold
  const lastTapTimeRef = useRef<number>(0); // Čas posledného tapnutia
  const tapCountRef = useRef<number>(0); // Počet tapnutí v sérii
  const tapTimeoutRef = useRef<number | null>(null); // ID timeoutu pre reset tap okna
  // Synchronizácia "dýchania" (fill-breathe) medzi všetkými bunkami aktívneho kusa
  const BREATH_MS = 2000; // zodpovedá `fill-breathe` 2s
  const breatheSyncOffsetRef = useRef<number>(Date.now() % BREATH_MS);
  const gridRef = useRef(grid);
  const availableRef = useRef(availablePieces);
  const draggingRef = useRef(draggingPiece);
  const placedPiecesRef = useRef(placedPieces);
  const activePieceIdRef = useRef(activePieceId);
  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => {
    return () => {
      if (tapTimeoutRef.current) {
        window.clearTimeout(tapTimeoutRef.current);
        tapTimeoutRef.current = null;
      }
    };
  }, []);
  useEffect(() => { availableRef.current = availablePieces; }, [availablePieces]);
  useEffect(() => { draggingRef.current = draggingPiece; }, [draggingPiece]);
  useEffect(() => { placedPiecesRef.current = placedPieces; }, [placedPieces]);
  useEffect(() => { activePieceIdRef.current = activePieceId; }, [activePieceId]);
  useEffect(() => { scaleRef.current = scale; }, [scale]); // Synchronizácia scaleRef
  // Stav debug overlay
  const [showImuDebug, setShowImuDebug] = useState<boolean>(false);
  const [imuDebug, setImuDebug] = useState<any>({});
  const { isCalibrated, neutralQuat, requestCalibration, showCalibrationModal } = useCalibration();
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [isGripping, setIsGripping] = useState<boolean>(false); // State pre IMU grip - použité v kontrole výhry
  const startTimeRef = useRef<number>(Date.now());
  const levelStartRef = useRef<number>(Date.now());
  const [levelDurations, setLevelDurations] = useState<number[]>([]);
  const [longestLevelIndex, setLongestLevelIndex] = useState<number | null>(null);
  const [longestLevelTime, setLongestLevelTime] = useState<number | null>(null);
  const initialPlacedCountRef = useRef<number>(0);
  const levelUserPlacedRef = useRef<Set<string>>(new Set());

  const levels: PentominoLevel[] = (levelsData as PentominoLevel[]).slice(0, maxLevels);
  const currentLevel = levels[currentLevelIndex];

  // Fixná veľkosť gridu (ako GameBoard)
  const GRID_WIDTH = 20;
  const GRID_HEIGHT = 20;

  // Ak config nie je načítaný, zobraz loading
  if (!cfg) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="text-2xl text-slate-600">Načítavam konfiguráciu...</div>
      </div>
    );
  }

  // Inicializácia levelu
  useEffect(() => {
    
    if (!currentLevel) {
      return;
    }

    // Vytvor fixný 20×20 grid
    let newGrid: boolean[][] = Array(GRID_HEIGHT)
      .fill(null)
      .map(() => Array(GRID_WIDTH).fill(false));

    const pieces = currentLevel.availablePieces.map((id) => {
      const shape = PENTOMINO_SHAPES.find((s) => s.id === id);
      if (!shape) {
        console.error('❌ Shape not found:', id);
        throw new Error(`Shape ${id} not found`);
      }
      return shape;
    });

    // Ak existujú štartovacie pozície, umiestni kúsky na grid
  const initialPlacedPieces: PlacedPiece[] = [];
    if (currentLevel.startingPositions && currentLevel.startingPositions.length > 0) {
      currentLevel.startingPositions.forEach((pos, index) => {
        if (index < pieces.length) {
          const shape = pieces[index];
          
          // Skontroluj či kúsok sa zmestí na pozíciu
          const pieceRows = shape.grid.length;
          const pieceCols = shape.grid[0] ? shape.grid[0].length : 0;
          
          if (pos.row < 0 || pos.col < 0 || 
              pos.row + pieceRows > GRID_HEIGHT || 
              pos.col + pieceCols > GRID_WIDTH) {
            return;
          }
          
          const piece: PlacedPiece = {
            shapeId: shape.id,
            grid: shape.grid,
            row: pos.row,
            col: pos.col,
            color: shape.color,
            uid: genUid(),
          };
          
          // Umiestni blok na grid
          try {
            newGrid = placePiece(newGrid, shape.grid, pos.row, pos.col, shape.color);
            initialPlacedPieces.push(piece);
          } catch (error) {
            console.error('❌ Failed to place piece:', shape.id, error);
          }
        }
      });
    }

  setGrid(newGrid);
  setPlacedPieces(initialPlacedPieces);
  // Zapamätaj koľko kúskov bolo predumiestnených v tomto leveli (aby sme ich nepočítali ako používateľské uloženia)
  initialPlacedCountRef.current = initialPlacedPieces.length;
  // Vyčisti množinu používateľom uložených kúskov pri načítaní levelu
  levelUserPlacedRef.current.clear();
  // Vyčisti históriu pri načítaní nového levelu
  setHistoryStack([]);
  setActivePieceId(initialPlacedPieces.length > 0 ? initialPlacedPieces[0].uid ?? null : null);
    
    // Dostupné kúsky sú len tie, ktoré ešte nie sú umiestnené
    const unusedPieces = currentLevel.startingPositions && currentLevel.startingPositions.length > 0
      ? []
      : pieces;
    setAvailablePieces(unusedPieces);
    setShowRestPopup(false);
    // Reset štatistík pri načítaní úrovne (ak začíname od prvého)
    if (currentLevelIndex === 0) {
      setMovesCount(0);
      setTimeTaken(0);
      setLevelDurations([]);
      setLongestLevelIndex(null);
      setLongestLevelTime(null);
      setTotalPlacedCount(0);
      setLevelPlacedCounts([]);
      startTimeRef.current = Date.now();
    }
    // Označ čas začiatku tohto levelu
    levelStartRef.current = Date.now();
  }, [currentLevel, reloadKey]);

  // Zmena vo WS stave
  useEffect(() => {
    // Skontroluj počiatočný stav z globálnej premennej (WS sa mohol pripojiť pred namontovaním komponentu)
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

  // Request calibration on mount if not calibrated and WS connected
  useEffect(() => {
    if (wsConnected && !isCalibrated) {
      requestCalibration();
    }
  }, [wsConnected, isCalibrated, requestCalibration]);

  // Globálna IMU kalibrácia
  useEffect(() => {
    if (imuCtrlRef.current && neutralQuat) {
      imuCtrlRef.current.calibrateNeutral(neutralQuat);
    }
  }, [neutralQuat]);

  // Spracovanie IMU: počúvaj 'imu-sample' udalosti odoslané z WebSocketStatus
  useEffect(() => {
    if (!imuCtrlRef.current) imuCtrlRef.current = new SingleIMUController();

    function onSample(ev: Event) {
      // Freeze game processing ak nie sme pripojení, nie sme kalibrovaní alebo je otvorený kalibračný modal
      if (wsConnected && !isCalibrated && showCalibrationModal) return;
      try {
        const detail = (ev as CustomEvent).detail;
        if (!detail) return;
        const sample = { imu: detail.imu || {}, adc: detail.adc || [], ts: Date.now() } as any;
        const adc: number[] = Array.isArray(detail.adc) ? detail.adc : [];
        
        const now = Date.now();
        const last = lastImuTsRef.current ?? now;
        const dt = Math.max(1, now - last) / 1000;
        lastImuTsRef.current = now;

        // === DETEKCIA STISKU (z GameBoard.tsx) ===
        // Pripravené prsty (adc[1..5] = malíček->palec)
        let fingersRaw = Array.isArray(adc)
          ? adc.slice(1, 6).map((v: any) => Number(v || 0))
          : [];
        const fingers = useLeftHand ? fingersRaw : fingersRaw.slice().reverse();

        const defaultRawThr = (cfg as any)?.TENSOMETER_RAW_THRESHOLD ?? 2000;
        const defaultNormThr = (cfg as any)?.TENSOMETER_NORM_THRESHOLD ?? 12;

        // Spočítať stlačené prsty – povoliť detekciu buď surovým (raw) alebo normalizovaným (norm) prahom
        let pressedCount = 0;
        const pressedFingers: boolean[] = [];
        for (let i = 0; i < fingers.length; i++) {
          const raw = Math.abs(fingers[i] ?? 0);
          const norm = raw / 128; // rovnaká normalizácia ako v debug overlay
          const isPressed = raw > defaultRawThr || norm > defaultNormThr;
          pressedFingers.push(isPressed);
          if (isPressed) pressedCount++;
        }
        const manualGrip = pressedCount === 5;
        setIsGripping(pressedCount > 0);
        
        // Ukazovák detekcia: pri ľavej ruke index 3 (malíček->palec), pri pravej ruke po reverze je ukazovák na indexe 1
        const indexFingerPressed = useLeftHand ? pressedFingers[3] : pressedFingers[1];
        // Palec detekcia: vždy na indexe 4 (posledný prst)
        const thumbPressed = pressedFingers[4];
        const singlePressed = !manualGrip && indexFingerPressed && pressedCount === 1;
        const noPress = pressedCount === 0;

        const out = imuCtrlRef.current!.update(sample, dt);

        // Normalizácia gyroskopu (delíme 16, aby sme dostali °/s)
        const gx = Number(sample.imu?.gyroX || 0) / 16.0;
        const gy = Number(sample.imu?.gyroY || 0) / 16.0;
        const gz = Number(sample.imu?.gyroZ || 0) / 16.0;

        // Pozícia na gride z IMU
        // Unified mapping copied from majo: X direct, Y inverted for left hand
        const gridX = out.grid.x;
        const gridY = useLeftHand ? (imuCtrlRef.current!.gridSize - 1 - out.grid.y) : out.grid.y;

        // === ROTÁCIA A FLIP PRI STLAČENOM UKAZOVÁKU ===
        const GYRO_ROTATION_THRESHOLD = 20; // °/s - zvýšené z 15 na 20
        const GYRO_FLIP_THRESHOLD = 22; // °/s - zvýšené z 18 na 22
        const GYRO_ROTATION_COOLDOWN_MS = 800; // ms - zvýšené z 650 na 800
        const MAX_SHIFT = 5; // Maximálny posun pre auto-shift

        // Helper: kontrola či sa blok zmestí na grid (bez kontroly targetShape)
        const canPlaceOnGrid = (
          grid: boolean[][],
          pieceGrid: boolean[][],
          row: number,
          col: number
        ): boolean => {
          const pieceRows = pieceGrid.length;
          const pieceCols = pieceGrid[0]?.length || 0;
          const gridRows = grid.length;
          const gridCols = grid[0]?.length || 0;
          
          for (let r = 0; r < pieceRows; r++) {
            for (let c = 0; c < pieceCols; c++) {
              if (!pieceGrid[r][c]) continue;
              
              const targetRow = row + r;
              const targetCol = col + c;
              
              // Mimo gridu
              if (targetRow < 0 || targetRow >= gridRows || targetCol < 0 || targetCol >= gridCols) {
                return false;
              }
              
              // Kolízia s iným blokom na gride
              if (grid[targetRow][targetCol]) {
                return false;
              }
            }
          }
          return true;
        };

        // Helper: nájdi validnú pozíciu pre transformovaný blok vo všetkých smeroch
        const findValidPosition = (
          tempGrid: boolean[][], 
          transformedPiece: boolean[][], 
          startRow: number, 
          startCol: number
        ): { row: number; col: number } | null => {
          
          // Prvý pokus: pôvodná pozícia
          if (canPlaceOnGrid(tempGrid, transformedPiece, startRow, startCol)) {
            return { row: startRow, col: startCol };
          }
          
          // Hľadaj vo všetkých smeroch (špirála okolo pôvodnej pozície)
          for (let dist = 1; dist <= MAX_SHIFT; dist++) {
            // Všetky offsety v danej vzdialenosti
            const offsets = [
              { dr: -dist, dc: 0 },    // hore
              { dr: dist, dc: 0 },     // dole
              { dr: 0, dc: -dist },    // doľava
              { dr: 0, dc: dist },     // doprava
              { dr: -dist, dc: -dist },// hore-doľava
              { dr: -dist, dc: dist }, // hore-doprava
              { dr: dist, dc: -dist }, // dole-doľava
              { dr: dist, dc: dist },  // dole-doprava
            ];
            
            for (const { dr, dc } of offsets) {
              const newRow = startRow + dr;
              const newCol = startCol + dc;
              if (canPlaceOnGrid(tempGrid, transformedPiece, newRow, newCol)) {
                return { row: newRow, col: newCol };
              }
            }
          }
          
          return null; // Nenašla sa žiadna validná pozícia
        };

        const currentActivePieceId = activePieceIdRef.current;
        
        // === EXKLUZIVITA AKCIÍ ===
        // Ak je stlačený palec (zmena blokov), NEVYKonávaj rotáciu ani flip
        const isThumbAction = thumbPressed && !manualGrip && !indexFingerPressed;
        
        // ROTÁCIA: keď je stlačený GRIP (všetky prsty) -> otáčaj podľa osi Z gyra
        // Použitie hysterézie: gyroskop musel byť pred tým uvoľnený
        if (manualGrip && currentActivePieceId && !draggingRef.current && !isThumbAction) {
          const currentPlacedPieces = placedPiecesRef.current;
          const activePiece = currentPlacedPieces.find((p) => p.uid === currentActivePieceId);
          
          if (activePiece && now - lastGestureTimeRef.current >= GYRO_ROTATION_COOLDOWN_MS) {
            const gyro = out.gyro || { x: 0, y: 0, z: 0 };
            
            // Určíme dominantnú os - rotácia (Z) alebo flip (X)
            const isRotationDominant = Math.abs(gyro.z) > Math.abs(gyro.x);
            
            // ROTÁCIA: gyro.z je dominantný, prekračuje threshold A bol predtym uvoľnený
            // ZMENA: Rotácia len v jednom smere (gyro.z > 0) a ignorovanie návratu (gyro.z < 0)
            if (isRotationDominant && gyro.z > GYRO_ROTATION_THRESHOLD && out.gyroZWasReleased) {
              // Rotácia - vždy rovnaký smer (90° doprava)
              const rotated = rotatePentomino(activePiece.grid);
              const tempGrid = removePiece(gridRef.current, activePiece);
              
              const validPos = findValidPosition(tempGrid, rotated, activePiece.row, activePiece.col);
              
              if (validPos) {
                // Uloženie stavu pre krok späť keď sa využíva IMU
                saveToHistory();
                const newGridState = placePiece(tempGrid, rotated, validPos.row, validPos.col, activePiece.color);
                setGrid(newGridState);
                setPlacedPieces((prev) => prev.map((p) => (p.uid === currentActivePieceId ? { ...p, grid: rotated, row: validPos.row, col: validPos.col } : p)));
                lastGestureTimeRef.current = now;
                // Označíme že gesto bolo vykonané - vyžaduje sa uvoľnenie pred ďalším
                imuCtrlRef.current?.consumeGyroZ();
                // Synchronizuj fázu dýchania aby všetky bunky zostali v rovnakom okamihu
                breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
                // Nastav flag že prebieha rotácia (blokuje pohyb)
                isRotatingRef.current = true;
              }
            }
            // FLIP: gyro.x je dominantný, prekračuje threshold A bol predtym uvoľnený
            else if (!isRotationDominant && Math.abs(gyro.x) > GYRO_FLIP_THRESHOLD && out.gyroXWasReleased) {
              const sign = Math.sign(gyro.x);
              // Povoliť flip len ak sme ešte neflipovali (0) alebo ak ideme rovnakým smerom
              // Tým sa zabráni nechcenému flipu pri návrate ruky (opačný smer)
              if (flipDirectionRef.current === 0 || flipDirectionRef.current === sign) {
                const flipped = flipPentomino(activePiece.grid);
                const tempGrid = removePiece(gridRef.current, activePiece);
                
                const validPos = findValidPosition(tempGrid, flipped, activePiece.row, activePiece.col);
                
                if (validPos) {
                  // Save prior state for undo when flipping an existing piece via IMU
                  saveToHistory();
                  const newGridState = placePiece(tempGrid, flipped, validPos.row, validPos.col, activePiece.color);
                  setGrid(newGridState);
                  setPlacedPieces((prev) => prev.map((p) => (p.uid === currentActivePieceId ? { ...p, grid: flipped, row: validPos.row, col: validPos.col } : p)));
                  lastGestureTimeRef.current = now;
                  // Označíme že gesto bolo vykonané - vyžaduje sa uvoľnenie pred ďalším
                  imuCtrlRef.current?.consumeGyroX();
                  // Synchronizuj fázu dýchania aby všetky bunky zostali v rovnakom okamihu
                  breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
                  // Nastav flag že prebieha rotácia (blokuje pohyb)
                  isRotatingRef.current = true;
                  flipDirectionRef.current = sign;
                }
              }
            }
          }
        }

        // === DETEKCIA TAP vs HOLD (Double Tap pre zmenu bloku) ===
        const TAP_MAX_DURATION = 200; // ms - maximálne trvanie pre tap
        const DOUBLE_TAP_WINDOW = 1000; // ms - okno pre double tap (informational)

        // Detekcia hrany gripu
        if (manualGrip && !wasGrippingRef.current) {
          // Začiatok gripu
          gripStartTimeRef.current = now;
          wasGrippingRef.current = true;
          movementStartedRef.current = false;
          isRotatingRef.current = false; // Reset flagu rotácie
          flipDirectionRef.current = 0; // Reset smeru flipu
          // Ešte nenastavujeme isGripping ani gripStartGridRef, čakáme či to bude tap alebo hold
        } else if (!manualGrip && wasGrippingRef.current) {
          // Koniec gripu
          wasGrippingRef.current = false;
          isRotatingRef.current = false; // Reset flagu rotácie
          
          if (movementStartedRef.current) {
            // Bol to pohyb (HOLD)
            setIsGripping(false); // Ukonči vizuálny grip
            movementStartedRef.current = false;
            gripStartGridRef.current = null;
            gripStartPieceRef.current = null;
          } else {
            // Bol to TAP (krátky stisk bez pohybu)
            const duration = now - gripStartTimeRef.current;
            if (duration < TAP_MAX_DURATION) {
              // Use a counter + timeout to implement a 1s double-tap window for piece switch
              if (tapCountRef.current === 0) {
                tapCountRef.current = 1;
                if (tapTimeoutRef.current) window.clearTimeout(tapTimeoutRef.current);
                tapTimeoutRef.current = window.setTimeout(() => {
                  tapCountRef.current = 0;
                  tapTimeoutRef.current = null;
                }, 1000);
              } else if (tapCountRef.current === 1) {
                // SECOND TAP within window -> perform double-tap only if hand was stable
                const currentPlacedPieces = placedPiecesRef.current;
                const activePieceIndex = currentPlacedPieces.findIndex(p => p.uid === currentActivePieceId);

                // Stabilization logic: allow a small cell movement OR a quick second tap
                const STABLE_CELL_THRESHOLD = 1; // allow up to 1 cell movement
                const STABILIZE_MS = 300; // allow quick double-tap within 300 ms regardless of tiny movement
                const startGrid = gripStartGridRef.current;
                const movedCells = startGrid ? Math.abs(gridX - startGrid.x) + Math.abs(gridY - startGrid.y) : 0;
                const timeSinceFirst = now - gripStartTimeRef.current;

                const allowDoubleTap = (movedCells <= STABLE_CELL_THRESHOLD) || (timeSinceFirst <= STABILIZE_MS);

                if (allowDoubleTap) {
                  if (activePieceIndex !== -1 && currentPlacedPieces.length > 1) {
                    const newIndex = (activePieceIndex + 1) % currentPlacedPieces.length;
                    const newActivePiece = currentPlacedPieces[newIndex];
                    if (newActivePiece && newActivePiece.uid) {
                      setActivePieceId(newActivePiece.uid);
                    }
                  }
                }

                // reset tap counter & timeout in any case
                tapCountRef.current = 0;
                if (tapTimeoutRef.current) {
                  window.clearTimeout(tapTimeoutRef.current);
                  tapTimeoutRef.current = null;
                }
              }
            }
          }
        }
        
        // Aktualizuj predchádzajúci stav palca (ponechané pre prípadné iné použitie)
        const thumbOnlyPressed = thumbPressed && pressedCount === 1;
        wasThumbPressedRef.current = thumbOnlyPressed;

        // === POHYB AKTÍVNEHO BLOKU (RELATÍVNY) ===
        // Pohyb sa aktivuje len ak grip trvá dlhšie ako TAP_MAX_DURATION (HOLD)
        // A ZÁROVEŇ neprebieha rotácia (isRotatingRef)
        const isHold = manualGrip && (now - gripStartTimeRef.current > TAP_MAX_DURATION) && !isRotatingRef.current;

        if (isHold && currentActivePieceId && !draggingRef.current) {
          const currentPlacedPieces = placedPiecesRef.current;
          const activePiece = currentPlacedPieces.find(p => p.uid === currentActivePieceId);
          if (activePiece) {
            // Ak práve začal HOLD (prechod z čakania na tap do pohybu)
            if (!movementStartedRef.current) {
              // Save prior state for undo when starting an IMU-driven move
              saveToHistory();
              movementStartedRef.current = true;
              gripStartGridRef.current = { x: gridX, y: gridY };
              gripStartPieceRef.current = { row: activePiece.row, col: activePiece.col };
              setIsGripping(true); // Aktivuj vizuálny grip a blokuj kontrolu výhry
            }
            
            // Vypočítaj relatívny posun od začiatku gripu
            const startGrid = gripStartGridRef.current;
            const startPiece = gripStartPieceRef.current;
            
            if (startGrid && startPiece) {
              const deltaX = gridX - startGrid.x;
              const deltaY = gridY - startGrid.y;
              
              // Nová pozícia bloku = počiatočná pozícia + posun
              const newCol = startPiece.col + deltaX;
              const newRow = startPiece.row + deltaY;
            
            // Skontroluj či sa pozícia zmenila
            if (newRow !== activePiece.row || newCol !== activePiece.col) {
              // Odstráň aktívny blok z gridu
              const tempGrid = removePiece(gridRef.current, activePiece);
              
              // Skontroluj či sa blok zmestí na novú pozíciu
              const pieceHeight = activePiece.grid.length;
              const pieceWidth = activePiece.grid[0]?.length || 0;
              const isInBounds = newRow >= 0 && newCol >= 0 && 
                                newRow + pieceHeight <= GRID_HEIGHT && 
                                newCol + pieceWidth <= GRID_WIDTH;
              
              if (isInBounds) {
                // Skontroluj kolíziu s inými blokami
                let hasCollision = false;
                const otherPieces = currentPlacedPieces.filter(p => p.uid !== currentActivePieceId);
                for (const other of otherPieces) {
                  for (let pr = 0; pr < other.grid.length; pr++) {
                    for (let pc = 0; pc < other.grid[pr].length; pc++) {
                      if (other.grid[pr][pc]) {
                        const otherRow = other.row + pr;
                        const otherCol = other.col + pc;
                        
                        for (let ar = 0; ar < activePiece.grid.length; ar++) {
                          for (let ac = 0; ac < activePiece.grid[ar].length; ac++) {
                            if (activePiece.grid[ar][ac]) {
                              if (newRow + ar === otherRow && newCol + ac === otherCol) {
                                hasCollision = true;
                                break;
                              }
                            }
                          }
                          if (hasCollision) break;
                        }
                      }
                      if (hasCollision) break;
                    }
                    if (hasCollision) break;
                  }
                  if (hasCollision) break;
                }
                
                // Ak nie je kolízia, presuň blok
                if (!hasCollision) {
                  const newGrid = placePiece(tempGrid, activePiece.grid, newRow, newCol, activePiece.color);
                  setGrid(newGrid);
                  setPlacedPieces(prev => prev.map(p => 
                    p.uid === currentActivePieceId 
                      ? { ...p, row: newRow, col: newCol }
                      : p
                  ));
                }
              }
            }
            }
          }
        }

        // Aktualizuj debug overlay stav
        setImuDebug({
          pitch: Math.round((sample.imu.pitch ?? 0) / 16 * 10) / 10,
          roll: Math.round((sample.imu.roll ?? 0) / 16 * 10) / 10,
          yaw: Math.round((sample.imu.yaw ?? 0) / 16 * 10) / 10,
          gyro: out.gyro,
          linAcc: { x: Math.round((sample.imu.linAccX ?? 0)/100*10)/10, y: Math.round((sample.imu.linAccY ?? 0)/100*10)/10 },
          adcMax: Math.max(0, ...((sample.adc || []) as number[]).slice(1,5).map((v: number) => Math.abs(v)/128)),
          grip: out.grip,
          quat: sample.imu.quatW !== undefined ? {
            w: sample.imu.quatW ?? 0,  // Už normalizované backendom!
            x: sample.imu.quatX ?? 0,
            y: sample.imu.quatY ?? 0,
            z: sample.imu.quatZ ?? 0,
          } : undefined,
        });

        // Zdvihnutie: ak je grip aktívny a ešte nepresúvame, začni presúvať prvý dostupný kúsok
        if (out.grip && !draggingRef.current) {
          const available = availableRef.current || [];
          if (available.length > 0) {
            const shape = available[0];
            setDraggingPiece({ shape, grid: shape.grid, offsetX: 0, offsetY: 0 });
          }
        }

        // Akcie založené na gyro pri stisnutí: otočenie zápästím (gyroZ) -> rotácia, dopredu/dozadu (gyroY) -> flip
        if (out.grip) {
          const gyro = out.gyro || { x: 0, y: 0, z: 0 };
          const nowMs = Date.now();
          // Krátky cooldown aby sa predišlo rýchlemu opakovaniu
          const cooldown = 300;
          const last = (window as any)._lastGyroActionTs || 0;
          const flipThresh = 10; // °/s pre flip
          const rotateThresh = 10; // °/s pre rotáciu
          if (nowMs - last > cooldown) {
            if (Math.abs(gyro.z) > rotateThresh) {
              // Rotácia
              try { handleRotateDragging(); } catch (e) {}
              (window as any)._lastGyroActionTs = nowMs;
            } else if (Math.abs(gyro.y) > flipThresh) {
              // Flip
              try { handleFlipDragging(); } catch (e) {}
              (window as any)._lastGyroActionTs = nowMs;
            }
          }
        }

        // Pustenie: ak je grip uvoľnený a máme presúvaný kúsok, skús ho umiestniť
        if (!out.grip && draggingRef.current) {
          const dp = draggingRef.current;
          // Použi najnovší grid z ref
          const curGrid = gridRef.current;
          // Umiestni podľa pozície gridu z IMU (vypočítané skôr)
          const row = gridY;
          const col = gridX;
          if (currentLevel && dp) {
            // Najprv skús umiestniť do cieľového tvaru, potom hocikam validné
            const canPlaceTarget = canPlacePiece(curGrid, dp.grid, row, col, currentLevel.targetShape, placedPieces);
            if (canPlaceTarget) {
              // Save prior state for undo when placing a newly picked piece
              if (!dp.originalUid) saveToHistory();
              const newGrid = placePiece(curGrid, dp.grid, row, col, dp.shape.color);
              const uid = genUid();
              const newPiece: PlacedPiece = { shapeId: dp.shape.id, grid: dp.grid, row, col, color: dp.shape.color, uid };
              setGrid(newGrid);
              setPlacedPieces((prev) => { const na = [...prev, newPiece]; setActivePieceId(uid); setMovesCount((m)=>m+1); levelUserPlacedRef.current.add(uid); return na; });
              setAvailablePieces((prev) => prev.filter((p) => p.id !== dp.shape.id));
            } else {
              // Ak sa nedá umiestniť do cieľa, skús všeobecné umiestnenie (hranice + kolízia)
              const pieceHeight = dp.grid.length;
              const pieceWidth = dp.grid[0]?.length || 0;
              const isInBounds = row >= 0 && col >= 0 && row + pieceHeight <= GRID_HEIGHT && col + pieceWidth <= GRID_WIDTH;
              let canPlaceAnywhere = false;
              if (isInBounds) {
                // Jednoduchá kontrola kolízie
                try {
                  canPlaceAnywhere = canPlacePiece(curGrid, dp.grid, row, col, null as any, placedPieces);
                } catch (e) { canPlaceAnywhere = false; }
              }
              if (canPlaceAnywhere) {
                // Save prior state for undo when placing a newly picked piece
                if (!dp.originalUid) saveToHistory();
                const newGrid = placePiece(curGrid, dp.grid, row, col, dp.shape.color);
                const uid = genUid();
                const newPiece: PlacedPiece = { shapeId: dp.shape.id, grid: dp.grid, row, col, color: dp.shape.color, uid };
                setGrid(newGrid);
                setPlacedPieces((prev) => { const na = [...prev, newPiece]; setActivePieceId(uid); setMovesCount((m)=>m+1); levelUserPlacedRef.current.add(uid); return na; });
                setAvailablePieces((prev) => prev.filter((p) => p.id !== dp.shape.id));
              }
            }
          }
          // Vyčisti presúvanie bez ohľadu na výsledok
          setDraggingPiece(null);
        }
      } catch (err) {
        // Ignoruj chybu
      }
    }

    const wrappedSample = (ev: Event) => {
      if ((window as any).__modalOpen) return;
      onSample(ev as any);
    };
    window.addEventListener('imu-sample', wrappedSample as EventListener);
    return () => window.removeEventListener('imu-sample', wrappedSample as EventListener);
  }, [currentLevel, placedPieces]);


  // Kontrola výhry
  // Level sa vyhodnotí až keď hráč PUSTÍ blok (nie počas držania)
  useEffect(() => {
    if (!currentLevel || placedPieces.length === 0) return;
    
    // Nespúšťaj kontrolu výhry ak je aktívny grip (hráč ešte drží blok)
    if (wasGrippingRef.current) return;
    // Nespúšťaj kontrolu výhry ak sa ťahá blok myšou
    if (draggingPiece) return;

    if (isLevelComplete(grid, currentLevel.targetShape)) {
      // Zobraz popup na oddych a potom automaticky prejdi na ďalší level
      setShowRestPopup(true);
      const timeout = setTimeout(() => {
        setShowRestPopup(false);
        // Zaznamenaj trvanie tohto dokončeného levelu
        const duration = Math.floor((Date.now() - levelStartRef.current) / 1000);
        // Pridaj do levelDurations atomicky
            setLevelDurations((prev) => {
          const newArr = [...prev, duration];
          // Ak toto bol posledný level, vypočítaj najdlhší a zobraz modal
          if (currentLevelIndex >= levels.length - 1) {
            if (newArr.length > 0) {
              let max = -1;
              let idx = 0;
              newArr.forEach((d, i) => {
                if (d > max) {
                  max = d;
                  idx = i;
                }
              });
              setLongestLevelIndex(idx);
              setLongestLevelTime(max);
            }
          }
          return newArr;
        });

            // Zaznamenaj koľko kúskov bolo uložených v tomto leveli (unikátne používateľské interakcie)
            setLevelPlacedCounts((prev) => {
              const userPlaced = levelUserPlacedRef.current.size;
              const newArr = [...prev, userPlaced];
              const total = newArr.reduce((a, b) => a + b, 0);
              setTotalPlacedCount(total);
              return newArr;
            });

        if (currentLevelIndex < levels.length - 1) {
          setCurrentLevelIndex((i) => i + 1);
        } else {
          // Posledný level -> zobraz modal so štatistikami, ale len ak hráč dosiahol aspoň level 2
          const reachedLevelTwo = currentLevelIndex >= 1; // index 1 == level 2
          if (reachedLevelTwo) {
            setTimeTaken(Math.floor((Date.now() - startTimeRef.current) / 1000));
            setShowFinishedModal(true);
          } else {
            // Nedosiahol level 2 — vráť sa do menu
            onBackToMenu();
          }
        }
      }, cfg?.COFFEE_BREAK ?? 1000);

      return () => clearTimeout(timeout);
    }
  }, [grid, currentLevel, placedPieces, isGripping, draggingPiece]);

  const handleNextLevel = () => {
    if (currentLevelIndex < levels.length - 1) {
      setCurrentLevelIndex(currentLevelIndex + 1);
      setShowRestPopup(false);
    } else {
      onBackToMenu();
    }
  };

  const handleRestart = () => {
    // Znovu načítaj aktuálny level zvýšením reloadKey, čo spustí inicializačný effect
    setReloadKey((k) => k + 1);
    setShowRestPopup(false);
    // Resetuj štatistiky pre tento level
    setMovesCount(0);
    setTimeTaken(0);
    setHistoryStack([]); // Vyčisti históriu pri reštarte
    startTimeRef.current = Date.now();
  };

  // Uloží aktuálny stav do histórie pred zmenou
  const saveToHistory = useCallback(() => {
    const currentState: HistoryState = {
      grid: grid.map(row => [...row]),
      placedPieces: placedPieces.map(p => ({ ...p, grid: p.grid.map(r => [...r]) })),
      availablePieces: [...availablePieces],
      activePieceId: activePieceId,
    };
    setHistoryStack(prev => [...prev, currentState]);
  }, [grid, placedPieces, availablePieces, activePieceId]);

  // Funkcia na vrátenie posledného ťahu (undo)
  const handleUndo = useCallback(() => {
    if (historyStack.length === 0) return;
    
    const previousState = historyStack[historyStack.length - 1];
    setHistoryStack(prev => prev.slice(0, -1));
    
    setGrid(previousState.grid);
    setPlacedPieces(previousState.placedPieces);
    setAvailablePieces(previousState.availablePieces);
    setActivePieceId(previousState.activePieceId);
    
    // Zníž počet ťahov
    setMovesCount(m => Math.max(0, m - 1));
  }, [historyStack]);

  const handlePieceMouseDown = (
    e: React.MouseEvent,
    shape: PentominoShape,
    pieceGrid: boolean[][]
  ) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    // Offset je v screen koordinátach (už vyškálovaný) - prepočítaj na pôvodné jednotky
    const currentScale = scaleRef.current || 1;
    const offsetX = (e.clientX - rect.left) / currentScale;
    const offsetY = (e.clientY - rect.top) / currentScale;

    setDraggingPiece({ shape, grid: pieceGrid, offsetX, offsetY });
    setDragPosition({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (draggingPiece) {
        setDragPosition({ x: e.clientX, y: e.clientY });
        
        // Vypočítaj preview pozíciu na gridu
        const gridElement = document.getElementById('pentomino-grid');
        if (gridElement) {
          const gridRect = gridElement.getBoundingClientRect();
          // Zohľadni scale - všetko je v screen koordinátach, offset je už v nevýškálovaných jednotkách
          const currentScale = scaleRef.current || 1;
          const scaledCellSize = CELL_SIZE * currentScale;
          const scaledPadding = 12 * currentScale;
          const scaledOffsetX = draggingPiece.offsetX * currentScale;
          const scaledOffsetY = draggingPiece.offsetY * currentScale;
          const x = e.clientX - gridRect.left - scaledPadding - scaledOffsetX;
          const y = e.clientY - gridRect.top - scaledPadding - scaledOffsetY;
          
          const col = Math.floor((x + scaledCellSize / 2) / scaledCellSize);
          const row = Math.floor((y + scaledCellSize / 2) / scaledCellSize);
        }
      }
    },
    [draggingPiece, CELL_SIZE]
  );

  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (!draggingPiece || !currentLevel) {
        setDraggingPiece(null);
        return;
      }

      // Zisti pozíciu v mriežke
      const gridElement = document.getElementById('pentomino-grid');
      if (!gridElement) {
        setDraggingPiece(null);
        return;
      }

      const gridRect = gridElement.getBoundingClientRect();
      // Zohľadni scale - všetko je v screen koordinátach, offset je už v nevýškálovaných jednotkách
      const currentScale = scaleRef.current || 1;
      const scaledCellSize = CELL_SIZE * currentScale;
      const scaledPadding = 12 * currentScale;
      const scaledOffsetX = draggingPiece.offsetX * currentScale;
      const scaledOffsetY = draggingPiece.offsetY * currentScale;
      const x = e.clientX - gridRect.left - scaledPadding - scaledOffsetX;
      const y = e.clientY - gridRect.top - scaledPadding - scaledOffsetY;

      // Použiť Math.floor namiesto Math.round pre plynulejšie umiestnenie
      const col = Math.floor((x + scaledCellSize / 2) / scaledCellSize);
      const row = Math.floor((y + scaledCellSize / 2) / scaledCellSize);

      // Ulož aktuálny stav pred zmenou (pre undo) - len ak nejde o presun z gridu
      // Pri presune z gridu sa saveToHistory volá už v onMouseDown
      if (!draggingPiece.originalUid) {
        saveToHistory();
      }

      // Najprv skús umiestniť kúsok do targetShape (preferovaná pozícia)
      if (
        canPlacePiece(
          grid,
          draggingPiece.grid,
          row,
          col,
          currentLevel.targetShape,
          placedPieces
        )
      ) {
        const newGrid = placePiece(
          grid,
          draggingPiece.grid,
          row,
          col,
          draggingPiece.shape.color
        );

        const uid = genUid();
        const newPiece: PlacedPiece = {
          shapeId: draggingPiece.shape.id,
          grid: draggingPiece.grid,
          row,
          col,
          color: draggingPiece.shape.color,
          uid,
        };

        setGrid(newGrid);
        setPlacedPieces((prev) => {
          const newArr = [...prev, newPiece];
          setActivePieceId(uid);
          setMovesCount((m) => m + 1);
          // Ak sa umiestni do targetShape, započítaj tento kúsok (aj pri presune)
          const uidToCount = draggingPiece?.originalUid || uid;
          levelUserPlacedRef.current.add(uidToCount);
          return newArr;
        });

        // Odstráň z dostupných kúskov
        setAvailablePieces((prev) => prev.filter((p) => p.id !== draggingPiece.shape.id));
        setOriginalPosition(null); // Reset pôvodnej pozície
      } else {
        // Ak nemôžeme umiestniť do targetShape, skús aspoň na grid (mimo obrysu)
        // Kontroluj len kolíziu s inými kúskami a že je v rámci gridu
        const pieceHeight = draggingPiece.grid.length;
        const pieceWidth = draggingPiece.grid[0]?.length || 0;
        
        const isInBounds = row >= 0 && col >= 0 && 
                          row + pieceHeight <= GRID_HEIGHT && 
                          col + pieceWidth <= GRID_WIDTH;
        
        // Skontroluj kolíziu s už umiestnenými kúskami
        let hasCollision = false;
        if (isInBounds) {
          for (const placed of placedPieces) {
            for (let pr = 0; pr < placed.grid.length; pr++) {
              for (let pc = 0; pc < placed.grid[pr].length; pc++) {
                if (placed.grid[pr][pc]) {
                  const placedRow = placed.row + pr;
                  const placedCol = placed.col + pc;
                  
                  for (let dr = 0; dr < draggingPiece.grid.length; dr++) {
                    for (let dc = 0; dc < draggingPiece.grid[dr].length; dc++) {
                      if (draggingPiece.grid[dr][dc]) {
                        const newRow = row + dr;
                        const newCol = col + dc;
                        if (newRow === placedRow && newCol === placedCol) {
                          hasCollision = true;
                          break;
                        }
                      }
                    }
                    if (hasCollision) break;
                  }
                }
                if (hasCollision) break;
              }
              if (hasCollision) break;
            }
            if (hasCollision) break;
          }
        }
        
  if (isInBounds && !hasCollision) {
          // Môžeme umiestniť mimo obrysu
          const newGrid = placePiece(
            grid,
            draggingPiece.grid,
            row,
            col,
            draggingPiece.shape.color
          );

          const uid = genUid();
          const newPiece: PlacedPiece = {
            shapeId: draggingPiece.shape.id,
            grid: draggingPiece.grid,
            row,
            col,
            color: draggingPiece.shape.color,
            uid,
          };

          setGrid(newGrid);
          setPlacedPieces(prev => {
            const newArr = [...prev, newPiece];
            setActivePieceId(uid);
            setMovesCount((m) => m + 1);
            // Umiestnenie MIMO targetShape sa nepočíta (dočasná pozícia)
            return newArr;
          });
          setOriginalPosition(null);
        } else if (originalPosition) {
          // Ak ani to nezabralo a máme pôvodnú pozíciu, vráť kúsok naspäť
          const newGrid = placePiece(
            grid,
            draggingPiece.grid,
            originalPosition.row,
            originalPosition.col,
            draggingPiece.shape.color
          );

          const uid = genUid();
          const restoredPiece: PlacedPiece = {
            shapeId: draggingPiece.shape.id,
            grid: draggingPiece.grid,
            row: originalPosition.row,
            col: originalPosition.col,
            color: draggingPiece.shape.color,
            uid,
          };

          setGrid(newGrid);
          setPlacedPieces((prev) => {
            const newArr = [...prev, restoredPiece];
            setActivePieceId(uid);
            setMovesCount((m) => m + 1);
            // Vrátenie kúska na pôvodnú pozíciu nie je nové uloženie
            return newArr;
          });
          setOriginalPosition(null);
        }
      }

      setDraggingPiece(null);
    },
    [draggingPiece, grid, currentLevel, placedPieces, CELL_SIZE, originalPosition, GRID_WIDTH, GRID_HEIGHT, saveToHistory]
  );

  useEffect(() => {
    if (draggingPiece) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingPiece, handleMouseMove, handleMouseUp]);

  // Rotácia aktuálne drženého alebo aktívneho kúska
  const handleRotateDragging = () => {
    if (draggingPiece) {
      const rotated = rotatePentomino(draggingPiece.grid);
      setDraggingPiece({ ...draggingPiece, grid: rotated });
      // keep breathing animation in sync
      breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
    } else if (placedPieces.length > 0) {
      // Rotuj aktívny kúsok priamo na gride
      const activePiece = activePieceId ? placedPieces.find(p => p.uid === activePieceId) ?? null : null;
      if (!activePiece) {
        return;
      }

      // Odstráň kúsok z gridu
      const tempGrid = removePiece(grid, activePiece);

      // Rotuj grid kúska
      const rotatedGrid = rotatePentomino(activePiece.grid);

      // Skús umiestniť rotovaný kúsok na rovnakú pozíciu
      if (canPlacePiece(tempGrid, rotatedGrid, activePiece.row, activePiece.col, currentLevel.targetShape, placedPieces.filter((p) => p.uid !== activePiece.uid))) {
        const newGrid = placePiece(tempGrid, rotatedGrid, activePiece.row, activePiece.col, activePiece.color);
        setGrid(newGrid);
        setPlacedPieces(prev => prev.map((p) => p.uid === activePiece.uid ? { ...p, grid: rotatedGrid } : p));
        breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
      } else {
        // Rotácia blokovaná kolíziou - nevykonaj zmenu
        setGrid(grid);
      }
    }
  };

  // Prevrátenie (flip) aktuálne drženého alebo aktívneho kúska
  const handleFlipDragging = () => {
    if (draggingPiece) {
      const flipped = flipPentomino(draggingPiece.grid);
      setDraggingPiece({ ...draggingPiece, grid: flipped });
      // keep breathing animation in sync
      breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
    } else if (placedPieces.length > 0) {
      // Flip aktívny kúsok priamo na gride
      const activePiece = activePieceId ? placedPieces.find(p => p.uid === activePieceId) ?? null : null;
      if (!activePiece) {
        return;
      }

      // Odstráň kúsok z gridu
      const tempGrid = removePiece(grid, activePiece);

      // Flip grid kúska
      const flippedGrid = flipPentomino(activePiece.grid);

      // Skús umiestniť flipped kúsok na rovnakú pozíciu
      if (canPlacePiece(tempGrid, flippedGrid, activePiece.row, activePiece.col, currentLevel.targetShape, placedPieces.filter((p) => p.uid !== activePiece.uid))) {
        const newGrid = placePiece(tempGrid, flippedGrid, activePiece.row, activePiece.col, activePiece.color);
        setGrid(newGrid);
        setPlacedPieces(prev => prev.map((p) => p.uid === activePiece.uid ? { ...p, grid: flippedGrid } : p));
        breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
      } else {
        // Flip blokovaný kolíziou - nevykonaj zmenu
        setGrid(grid);
      }
    }
  };

  // Škálovanie obsahu na menších obrazovkách
  useEffect(() => {
    function computeScale() {
      const gridW = GRID_WIDTH * CELL_SIZE + 24; // šírka kontajnera mriežky
      const sideW = 400; // sidebar width
      const gap = 24; // medzera (gap-6)
      const contentWidth = gridW + gap + sideW;

      const gridH = GRID_HEIGHT * CELL_SIZE + 24;
      const footerH = 140; // približná výška päty
      const contentHeight = gridH + footerH;

      const padding = 48; // bezpečnostné odsadenie
      const vw = Math.max(320, window.innerWidth - padding);
      const vh = Math.max(480, window.innerHeight - padding);

      // Zachovaj správanie konzistentné s GameBoard: aplikuj malý násobok
      // aby sme sa vyhli príliš agresívnemu zmenšovaniu na stredných obrazovkách.
      const s = Math.min(1, vw / contentWidth, vh / contentHeight) * 1.1;
      setScale(Number(s.toFixed(3)));
    }

    computeScale();
    window.addEventListener('resize', computeScale);
    return () => window.removeEventListener('resize', computeScale);
  }, [CELL_SIZE]);

  // Klávesové ovládanie (R = rotate, F = flip, šípky = prepínanie aktívneho kúska)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((window as any).__modalOpen) return;
      // Freeze keyboard controls during calibration only while the calibration modal is visible
      if (wsConnected && !isCalibrated && showCalibrationModal) return;
      // F10 = toggle IMU debug
      if (e.key === 'F10') {
        e.preventDefault();
        setShowImuDebug(s => !s);
        return;
      }
      
      if (e.key.toLowerCase() === 'r') {
        handleRotateDragging();
      } else if (e.key.toLowerCase() === 'f') {
        handleFlipDragging();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        // Predchádzajúci kúsok
        e.preventDefault();
        if (placedPieces.length === 0) return;
        
        const currentIdx = activePieceId ? placedPieces.findIndex(p => p.uid === activePieceId) : -1;
        let newIdx: number;
        
        if (currentIdx === -1) {
          // Žiadny aktívny - vyber posledný
          newIdx = placedPieces.length - 1;
        } else {
          // Predchádzajúci (s wraparoundom)
          newIdx = currentIdx > 0 ? currentIdx - 1 : placedPieces.length - 1;
        }
        
        const newPiece = placedPieces[newIdx];
        if (newPiece?.uid) {
          setActivePieceId(newPiece.uid);
        }
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        // Ďalší kúsok
        e.preventDefault();
        if (placedPieces.length === 0) return;
        
        const currentIdx = activePieceId ? placedPieces.findIndex(p => p.uid === activePieceId) : -1;
        let newIdx: number;
        
        if (currentIdx === -1) {
          // Žiadny aktívny - vyber prvý
          newIdx = 0;
        } else {
          // Ďalší (s wraparoundom)
          newIdx = currentIdx < placedPieces.length - 1 ? currentIdx + 1 : 0;
        }
        
        const newPiece = placedPieces[newIdx];
        if (newPiece?.uid) {
          setActivePieceId(newPiece.uid);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draggingPiece, placedPieces, activePieceId]);

  if (!currentLevel) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="text-2xl text-slate-600 mb-4">Načítavam levely...</div>
          <button
            onClick={onBackToMenu}
            className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-6 py-3 rounded-xl font-semibold transition-all"
          >
            ← Späť do menu
          </button>
        </div>
      </div>
    );
  }

  // Vypočítaj coverage len ak máme grid a targetShape
  const coverage = grid.length > 0 && currentLevel.targetShape 
    ? getCoverage(grid, currentLevel.targetShape)
    : { covered: 0, total: 0, percentage: 0 };

  // Modal pre ukončenie hry / štatistiky
  const GameFinishedModal: React.FC<{
    timeTaken: number;
    movesCount: number;
    placedCount: number;
    fingerName: string;
    onBackToMenu: () => void;
    onRestart: () => void;
  totalLevels: number;
    longestLevelIndex: number | null;
    longestLevelTime: number | null;
  }> = ({ timeTaken, movesCount, placedCount, fingerName, onBackToMenu, onRestart, totalLevels, longestLevelIndex, longestLevelTime }) => {
    const formatTime = (secs: number) => {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return `${m}m ${s}s`;
    };

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 backdrop-blur-lg"
        style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-2xl w-full">
          <div className="flex flex-col items-center text-center">
            <Shapes className="w-12 h-12 text-green-600 mb-4" />
            <h2 className="text-3xl font-extrabold mb-2">Dobrá práca!</h2>
            <p className="text-slate-600 mb-6">Hra bola ukončená. Tu sú Vaše výsledky</p>

            <div className="w-full grid grid-cols-3 gap-4 mb-6 text-center">
              <div className="bg-green-50 rounded-xl p-4">
                <p className="text-sm font-medium text-green-600">Čas</p>
                <p className="text-2xl font-bold text-green-800">{formatTime(timeTaken)}</p>
              </div>
              <div className="bg-green-50 rounded-xl p-4">
                <p className="text-sm font-medium text-green-600">Najdlhší level</p>
                {longestLevelIndex !== null && longestLevelTime !== null ? (
                  <>
                    <p className="text-lg font-semibold text-green-800">Úroveň {longestLevelIndex + 1}</p>
                    <p className="text-sm text-green-700">{formatTime(longestLevelTime)}</p>
                  </>
                ) : (
                  <p className="text-sm text-green-700">—</p>
                )}
              </div>
              <div className="bg-green-50 rounded-xl p-4">
                <p className="text-sm font-medium text-green-600">Položené bloky</p>
                <p className="text-2xl font-bold text-green-800">{placedCount}</p>
              </div>
            </div>

            <div className="w-full flex gap-4">
              <button
                onClick={onBackToMenu}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 w-full"
              >
                Späť na výber hry
              </button>
              <button
                onClick={onRestart}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 w-full"
              >
                Reštartovať hru
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 h-screen w-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 overflow-hidden">
      {showFinishedModal && (
        <ModalBackdrop>
          <GameFinishedModal
            timeTaken={timeTaken}
            movesCount={movesCount}
            placedCount={totalPlacedCount}
            fingerName={fingerNames[0] ?? ''}
            onBackToMenu={() => {
              setShowFinishedModal(false);
              onBackToMenu();
            }}
            onRestart={() => {
              // Reštartuj celú reláciu od prvého levelu
              setShowFinishedModal(false);
              setCurrentLevelIndex(0);
              setReloadKey((k) => k + 1);
              setPlacedPieces([]);
              setAvailablePieces([]);
              setMovesCount(0);
              setTimeTaken(0);
              setTotalPlacedCount(0);
              startTimeRef.current = Date.now();
            }}
            totalLevels={levels.length}
            longestLevelIndex={longestLevelIndex}
            longestLevelTime={longestLevelTime}
          />
        </ModalBackdrop>
      )}


      {/* Calibration Modal always present, but only visible if context says so */}
      <CalibrationModal useLeftHand={useLeftHand} />

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
        
        {/* IMU debug overlay - prepnutie cez F10 */}
        <div className="absolute top-4 right-4 z-40 flex flex-col items-end space-y-2">
          {showImuDebug && (
            <div className="bg-white/95 text-slate-800 rounded-lg p-3 shadow-lg w-56 text-xs">
              <div className="font-medium mb-2">IMU debug</div>
              {imuDebug.quat && (
                <div className="mb-2 text-[10px] text-slate-600">
                  <div>qw: {imuDebug.quat.w?.toFixed(3) ?? '—'}</div>
                  <div>qx: {imuDebug.quat.x?.toFixed(3) ?? '—'}</div>
                  <div>qy: {imuDebug.quat.y?.toFixed(3) ?? '—'}</div>
                  <div>qz: {imuDebug.quat.z?.toFixed(3) ?? '—'}</div>
                </div>
              )}
              <div>pitch: {imuDebug.pitch ?? '—'}°</div>
              <div>roll: {imuDebug.roll ?? '—'}°</div>
              <div>yaw: {imuDebug.yaw ?? '—'}°</div>
              <div className="mt-1">gyro x: {imuDebug.gyro?.x ? imuDebug.gyro.x.toFixed(1) : '—'} °/s</div>
              <div>gyro y: {imuDebug.gyro?.y ? imuDebug.gyro.y.toFixed(1) : '—'} °/s</div>
              <div>gyro z: {imuDebug.gyro?.z ? imuDebug.gyro.z.toFixed(1) : '—'} °/s</div>
              <div className="mt-1">linAcc x: {imuDebug.linAcc?.x ?? '—'} m/s²</div>
              <div>linAcc y: {imuDebug.linAcc?.y ?? '—'} m/s²</div>
              <div className="mt-1">adc max: {(imuDebug.adcMax ?? 0).toFixed(2)}</div>
              <div>grip: {imuDebug.grip ? 'ON' : 'off'}</div>
            </div>
          )}
        </div>
        {/* Herná plocha */}
        <div className="flex gap-6 items-start max-w-[1600px]">
          {/* Herná mriežka */}
          <div className="flex flex-col gap-4">
            <div
              id="pentomino-grid"
              className="relative bg-white rounded-2xl shadow-2xl p-3 transition-shadow duration-200"
              style={{
                width: GRID_WIDTH * CELL_SIZE + 24,
                height: GRID_HEIGHT * CELL_SIZE + 24,
                boxShadow: (isGripping || draggingPiece) 
                  ? '0 0 12px 12px rgba(252, 186, 3, 0.35), 0 0 24px 8px rgba(147, 51, 234, 0.15)' 
                  : undefined,
              }}
            >
              {/* Coffee popup - presne uprostred gridu */}
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
                  gridTemplateColumns: `repeat(${GRID_WIDTH}, ${CELL_SIZE}px)`,
                  gridTemplateRows: `repeat(${GRID_HEIGHT}, ${CELL_SIZE}px)`,
                }}
              >
                {Array.from({
                  length: GRID_WIDTH * GRID_HEIGHT,
                }).map((_, i) => (
                  <div key={i} className="border border-slate-200" />
                ))}
              </div>

              {/* Cieľový tvar (obrysy) */}
              {currentLevel.targetShape.map((row, r) =>
                row.map((cell, c) =>
                  cell ? (
                    <div
                      key={`target-${r}-${c}`}
                      className="absolute border-4 rounded pointer-events-none"
                      style={{
                        left: 12 + c * CELL_SIZE + 3,
                        top: 12 + r * CELL_SIZE + 3,
                        width: CELL_SIZE - 6,
                        height: CELL_SIZE - 6,
                        borderColor: '#94a3b8',
                        opacity: 0.4,
                      }}
                    />
                  ) : null
                )
              )}

              {/* Umiestnené kúsky */}
              {placedPieces.map((piece, index) => (
                <div
                  key={`placed-${piece.uid ?? index}`}
                  className={`absolute transition-all ${piece.uid === activePieceId ? 'cursor-move' : 'cursor-pointer'}`}
                  style={{
                    left: 12 + piece.col * CELL_SIZE,
                    top: 12 + piece.row * CELL_SIZE,
                  }}
                  onClick={() => {
                    // Kliknutím sa prepne na tento kúsok
                    setActivePieceId(piece.uid ?? null);
                  }}
                  onMouseDown={(e) => {
                    // Kliknutím sa vyberie kúsok, podržaním sa začne presúvanie
                    if (piece.uid !== activePieceId) {
                      setActivePieceId(piece.uid ?? null);
                      return;
                    }

                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    // Offset je v screen koordinátach (už vyškálovaný) - prepočítaj na pôvodné jednotky
                    const currentScale = scaleRef.current || 1;
                    const offsetX = (e.clientX - rect.left) / currentScale;
                    const offsetY = (e.clientY - rect.top) / currentScale;

                    // Ulož pôvodnú pozíciu pre prípad neúspešného umiestnenia
                    setOriginalPosition({ row: piece.row, col: piece.col });

                    // Ulož aktuálny stav do histórie PRED odstránením kúska (pre undo)
                    saveToHistory();

                    // Odstráň kúsok z gridu a začni presúvanie
                    const newGrid = removePiece(grid, piece);
                    setGrid(newGrid);
                    setPlacedPieces((prev) => prev.filter((p) => p.uid !== piece.uid));

                    setDraggingPiece({
                      shape: { ...PENTOMINO_SHAPES.find((s) => s.id === piece.shapeId)!, color: piece.color, id: piece.shapeId, name: piece.shapeId, grid: piece.grid },
                      grid: piece.grid,
                      offsetX,
                      offsetY,
                      originalUid: piece.uid, // Zapamätaj si UID
                    });
                    setDragPosition({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {piece.grid.map((row, r) =>
                    row.map((cell, c) =>
                      cell ? (
                          <div
                          key={`cell-${r}-${c}`}
                          className="absolute rounded transition-all duration-200 hover:opacity-90"
                          style={{
                            left: c * CELL_SIZE + 3,
                            top: r * CELL_SIZE + 3,
                            width: CELL_SIZE - 6,
                            height: CELL_SIZE - 6,
                          }}
                        >
                          {/* Výplň kúska. Ak je kúsok aktívny, zobrazíme LEN animovanú výplň */}
                          {piece.uid === activePieceId ? (
                            <div
                              className="absolute inset-0 rounded fill-breathe pointer-events-none" key={`breathe-${breatheSyncOffsetRef.current}`}
                              style={{ backgroundColor: piece.color, opacity: 1, animationDelay: `-${breatheSyncOffsetRef.current}ms` }}
                            />
                          ) : (
                            <div
                              className="w-full h-full rounded"
                              style={{ backgroundColor: piece.color, opacity: 1 }}
                            />
                          )}

                          {/* Farebný obrys */}
                          <div
                            className="absolute inset-0 rounded border-4 pointer-events-none"
                            style={{
                              borderColor: `color-mix(in srgb, ${piece.color} 30%, black)`,
                            }}
                          />
                        </div>
                      ) : null
                    )
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Bočný panel */}
          <div
            className="flex w-[400px] flex-col rounded-2xl bg-white p-6 shadow-2xl justify-between"
            style={{ height: GRID_HEIGHT * CELL_SIZE + 24 }}
          >
            <div className="flex-1 overflow-auto">
            {/* Level info */}
            <div className="mb-4 space-y-3">
              <div className="bg-purple-50 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Shapes className="w-6 h-6 text-purple-600" />
                  <p className="text-purple-900 text-lg font-bold">Pentomino</p>
                </div>
                <p className="text-purple-700">
                  Úroveň {currentLevel.id}: {currentLevel.name}
                </p>
              </div>
            </div>

            {/* Progress */}
            <div className="mb-4 rounded-xl bg-slate-50 p-4">
              <p className="mb-2 text-slate-600 text-lg font-bold">Pokrytie</p>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-600">
                  {coverage.covered} / {coverage.total} buniek
                </span>
                <span className="text-lg font-bold text-slate-800">
                  {coverage.percentage}%
                </span>
              </div>
              <div className="h-3 bg-slate-300 rounded-full overflow-hidden">
                <div
                  className="h-full bg-slate-800 transition-all duration-300"
                  style={{ width: `${coverage.percentage}%` }}
                />
              </div>
            </div>

            {/* Aktívny kúsok carousel */}
            {(placedPieces.length > 0 || draggingPiece) && (
              <div className="mb-4 bg-purple-50 rounded-xl p-4">
                <p className="mb-2 text-purple-700 text-lg font-bold text-center">
                  Aktívny blok ({(() => {
                    // Ak sa draguje, použi originalUid z draggingPiece
                    const effectiveActiveId = draggingPiece?.originalUid ?? activePieceId;
                    // Počítaj index vrátane dragovaného kúsku
                    const allPieces = draggingPiece
                      ? [...placedPieces, { uid: draggingPiece.originalUid, shapeId: draggingPiece.shape.id, grid: draggingPiece.grid, row: 0, col: 0, color: draggingPiece.shape.color }]
                      : placedPieces;
                    const idx = effectiveActiveId ? allPieces.findIndex(p => p.uid === effectiveActiveId) : -1;
                    return idx >= 0 ? idx + 1 : 1;
                  })()}/{draggingPiece ? placedPieces.length + 1 : placedPieces.length})
                </p>
                <div className="flex flex-col gap-1.5">
                  {/* (previous piece removed — show only current and next) */}

                  {/* Aktuálny kúsok */}
                  {(() => {
                    const effectiveActiveId = draggingPiece?.originalUid ?? activePieceId;
                    const allPieces = draggingPiece 
                      ? [...placedPieces, { uid: draggingPiece.originalUid, shapeId: draggingPiece.shape.id, grid: draggingPiece.grid, row: 0, col: 0, color: draggingPiece.shape.color }]
                      : placedPieces;
                    const active = effectiveActiveId ? allPieces.find(p => p.uid === effectiveActiveId) ?? allPieces[0] : allPieces[0];
                    if (!active) return null;
                    
                    // Vypočítaj skutočnú šírku a výšku bloku
                    const blockWidth = active.grid[0]?.length || 0;
                    const blockHeight = active.grid.length;
                    const cellSize = 14;
                    const offsetX = (90 - blockWidth * cellSize) / 2;
                    const offsetY = (60 - blockHeight * cellSize) / 2;
                    
                      return (
                      <div className="bg-white rounded-lg p-2 border-2 border-purple-400 shadow-md flex justify-center items-center">
                        <div className="relative" style={{ width: '90px', height: '60px' }}>
                          {active.grid.map((row, r) =>
                            row.map((cell, c) =>
                              cell ? (
                                <div
                                  key={`active-${r}-${c}`}
                                  className="absolute rounded"
                                  style={{
                                    left: offsetX + c * cellSize,
                                    top: offsetY + r * cellSize,
                                    width: cellSize,
                                    height: cellSize,
                                    backgroundColor: active.color,
                                  }}
                                />
                              ) : null
                            )
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Nasledujúci kúsok */}
                  {(() => {
                    const effectiveActiveId = draggingPiece?.originalUid ?? activePieceId;
                    const allPieces = draggingPiece 
                      ? [...placedPieces, { uid: draggingPiece.originalUid, shapeId: draggingPiece.shape.id, grid: draggingPiece.grid, row: 0, col: 0, color: draggingPiece.shape.color }]
                      : placedPieces;
                    const currentIdx = effectiveActiveId ? allPieces.findIndex(p => p.uid === effectiveActiveId) : 0;
                    const nextIdx = currentIdx < allPieces.length - 1 ? currentIdx + 1 : 0;
                    const nextPiece = allPieces[nextIdx];
                    if (!nextPiece || allPieces.length < 2) return null;
                    
                    // Vypočítaj skutočnú šírku a výšku bloku
                    const blockWidth = nextPiece.grid[0]?.length || 0;
                    const blockHeight = nextPiece.grid.length;
                    const cellSize = 10;
                    const offsetX = (70 - blockWidth * cellSize) / 2;
                    const offsetY = (40 - blockHeight * cellSize) / 2;
                    
                    return (
                      <div className="bg-white/50 rounded-lg p-1.5 opacity-60 flex justify-center items-center">
                        <div className="relative" style={{ width: '70px', height: '40px' }}>
                          {nextPiece.grid.map((row, r) =>
                            row.map((cell, c) =>
                              cell ? (
                                <div
                                  key={`next-${r}-${c}`}
                                  className="absolute rounded"
                                  style={{
                                    left: offsetX + c * cellSize,
                                    top: offsetY + r * cellSize,
                                    width: cellSize,
                                    height: cellSize,
                                    backgroundColor: nextPiece.color,
                                  }}
                                />
                              ) : null
                            )
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Inštrukcie pre ovládanie */}
            <div className="rounded-xl bg-blue-50 p-4">
                <h3 className="text-lg font-bold text-blue-900 mb-3 flex items-center gap-2">
                  Informácie
                </h3>
                <div className="space-y-2 text-md text-blue-700">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                    <p><span className="font-semibold">Ovládanie →</span> Stlačenie všetkých 5 prstov</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    <p><span className="font-semibold">Pohyb rukou →</span> Blok sa posúva</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                    <p><span className="font-semibold">Otočenie zápästia →</span> Otočenie bloku</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                    <p><span className="font-semibold">Ohýbanie zápästia →</span> Prevrátenie bloku</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <p><span className="font-semibold">Dvojité stlačenie →</span> Prepnutie bloku</p>
                  </div>
                </div>
              </div>


            </div>{/* end scrollable top */}

            {/* Tlačidlá */}
            <div className="flex flex-col gap-3 mt-4">
              {/* Tlačidlo Krok späť */}
              <button
                onClick={handleUndo}
                disabled={historyStack.length === 0}
                className={`flex items-center justify-center gap-2 rounded-xl py-3 px-6 transition-colors w-full ${
                  historyStack.length === 0
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                }`}
              >
                <Undo2 className="w-5 h-5" />
                Krok späť
              </button>
              <button
                onClick={() => {
                  const reachedLevelTwo = currentLevelIndex >= 1; // index 1 == level 2
                  if (reachedLevelTwo) {
                    // record current partial level duration
                    const duration = Math.floor((Date.now() - levelStartRef.current) / 1000);
                    setLevelDurations((prev) => {
                      const newArr = [...prev, duration];
                      if (newArr.length > 0) {
                        let max = -1;
                        let idx = 0;
                        newArr.forEach((d, i) => {
                          if (d > max) {
                            max = d;
                            idx = i;
                          }
                        });
                        setLongestLevelIndex(idx);
                        setLongestLevelTime(max);
                      }
                      return newArr;
                    });

                    // Zaznamenaj aj koľko kúskov bolo uložených v tomto leveli (unikátne používateľské interakcie)
                    setLevelPlacedCounts((prev) => {
                      const userPlaced = levelUserPlacedRef.current.size;
                      const newArr = [...prev, userPlaced];
                      const total = newArr.reduce((a, b) => a + b, 0);
                      setTotalPlacedCount(total);
                      return newArr;
                    });

                    setTimeTaken(Math.floor((Date.now() - startTimeRef.current) / 1000));
                    setShowFinishedModal(true);
                  } else {
                    onBackToMenu();
                  }
                }}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
              >
                Ukončiť hru
              </button>
              <button
                onClick={handleRestart}
                className="bg-slate-800 hover:bg-slate-700 text-white rounded-xl py-3 px-6 transition-colors w-full"
              >
                Reštartovať hru
              </button>
            </div>
          </div>
        </div>
      </div>
      {/* Koniec scaled containera */}

      {/* Dragging piece preview */}
      {draggingPiece && (
        <div
          className="fixed pointer-events-none z-50 opacity-80"
          style={{
            left: dragPosition.x - draggingPiece.offsetX,
            top: dragPosition.y - draggingPiece.offsetY,
          }}
        >
          {draggingPiece.grid.map((row, r) =>
            row.map((cell, c) =>
              cell ? (
                <div
                  key={`drag-${r}-${c}`}
                  className="absolute border-2 border-white rounded shadow-lg"
                  style={{
                    left: c * CELL_SIZE,
                    top: r * CELL_SIZE,
                    width: CELL_SIZE,
                    height: CELL_SIZE,
                    backgroundColor: draggingPiece.shape.color,
                  }}
                />
              ) : null
            )
          )}
        </div>
      )}
    </div>
  );
}
