import { useState, useEffect, useCallback, useRef } from 'react';
import SingleIMUController, { TILT_ROTATION_RIGHT_DEG, SHEAR_UP_RIGHT_HAND, SHEAR_RIGHT_RIGHT_HAND } from '../utils/imuController';
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
  findNearestValidPosition,
  placePiece,
  removePiece,
  isLevelComplete,
  getCoverage,
} from '../utils/pentominoUtils';
import { FingerCalibration } from '../types/game';
import '../animations.css';
import { normalizeAdc, normalizeImuSample } from '../utils/imuNormalize';
import { fuseSigned, DUAL_LEFT_GYRO_SIGN } from '../utils/dualHands';
import { MOVE_START_CELLS, MOVE_STEP_MS, pieceStep } from '../utils/pieceMovement';

// Zmena aktívneho bloku zmachom ruky (flick-up = ďalší, flick-down = predchádzajúci)
const FLICK_SWITCH_ENABLED = true;

// TEST: plynulý 3D prevrat kúska pri flipe (false = pôvodné okamžité prevrátenie)
// Rotácia zápästím: kumulovaný uhol (gyro Z) sa zobrazuje plynulo, prichytenie na 90° po pustení/pauze.
const TWIST_DIFFICULTY = 1.5;       // ťažkosť: nakumulovaný uhol sa delí týmto číslom (väčšie = pomalšie otáčanie)
const TWIST_SAMPLE_MS = 100;      // akumuluj len raz za tento interval (nie každú vzorku)
const TWIST_COMMIT_IDLE_MS = 700;  // pauza v otáčaní zápästím (ms), po ktorej sa kúsok prichytí na 90°
// Flip = kyvnutie zápästia K SEBE / OD SEBA. Senzor je naklonený, takže sa to rozloží na gyro X a Y s OPAČNÝM znamienkom
// (namerané: x~92, y~101, korelácia -0.96, z~24). Flipová os je preto diagonála (gy - gx)/√2.
const FLIP_STEP_DEG = 70;         // flip až keď sa ruka okolo osi X reálne otočí o toľko stupňov (akumulácia, nie jednorazový prah)
const FLIP_DEADZONE_DPS = 50;     // gyro X pod touto rýchlosťou sa nezapočítava (šum má std ~5-6 °/s)
const FLIP_DOMINANCE = 1.6;       // |flipový gyro| musí byť aspoň toľkokrát väčší ako obe ostatné osi (inak je to iný pohyb)
const FLIP_IDLE_RESET_MS = 400;   // pauza v pohybe po ktorej sa nakumulovaný uhol zahodí
const HAND_POS_GAIN = 1.2;          // zosilenie náklonu ruky -> poloha (rovnako ako DRAW_GAIN v kreslení)
const TWIST_QUIET_MS = 350;       // po otočení zápästia (gyro Z) chvíľu ignoruj posun ruky spôsobený náklonom
const TWIST_DEADZONE_DPS = 100;   // ignoruj šum/drift gyra pod touto rýchlosťou (°/s); namerané: otočenie ~250-600, posun ruky max ~80
const TWIST_DOMINANCE = 2;        // |gyro Z| musí byť aspoň toľkokrát väčší ako gyro X aj Y (posun ruky/náklon dáva X,Y; otočenie Z)
const SMOOTH_FLIP_ENABLED = true;
const SMOOTH_FLIP_MS = 450;

// TEST: plynulá rotácia klávesom. Podržaný R = otáča doprava, E = doľava (po krokoch za snímku).
// Po pustení sa kúsok "prichytí" na najbližší násobok 90° (pod 45° späť, nad 45° na 90°).
// false = pôvodná rotácia o 90° naraz.
const SMOOTH_ROTATE_ENABLED = true;
const ROTATE_SPEED_DPS = 180;     // rýchlosť otáčania pri držaní (°/s; ~3° na snímku pri 60 fps)
const ROTATE_SETTLE_FACTOR = 2;   // o koľko rýchlejšie dobieha do cieľového uhla po pustení
const ROTATE_TAP_MS = 150;        // krátke ťuknutie kratšie ako toto = rovno celých 90° (0 = vypnúť)
const ROTATE_EASE_MS = 120;       // dorovnanie posunu stredu pri nepravidelných tvaroch

type Props = {
  dualHands?: boolean; // ovládanie OBOMA rukami naraz (ľavá + pravá), obe robia ten istý pohyb spolu
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
  dualHands = false,
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
  // Animácia prevratu: uid kúska + čítač, ktorý reštartuje CSS animáciu
  const [flipAnim, setFlipAnim] = useState<{ uid: string; n: number } | null>(null);
  const triggerFlipAnim = (uid?: string) => {
    if (!SMOOTH_FLIP_ENABLED || !uid) return;
    setFlipAnim((prev) => ({ uid, n: (prev?.n ?? 0) + 1 }));
  };
  // Vizuálny stav plynulej rotácie (uhol v stupňoch + doladenie posunu v px)
  const [rotVisual, setRotVisual] = useState<{ uid: string; angle: number; tx: number; ty: number; ease: boolean } | null>(null);
  useEffect(() => {
    if (!flipAnim) return;
    const t = setTimeout(() => setFlipAnim(null), SMOOTH_FLIP_MS);
    return () => clearTimeout(t);
  }, [flipAnim]);
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
  const imuCtrlRef = useRef<SingleIMUController | null>(null); // jedna ruka / v režime dvoch rúk PRAVÁ (hlavná)
  const imuCtrlLRef = useRef<SingleIMUController | null>(null); // režim dvoch rúk: ĽAVÁ
  // Režim dvoch rúk: posledné vzorky/výstupy kontrolérov z oboch rúk
  const dualRef = useRef<{ left: { sample: any; out: any; ts: number } | null; lastLeftTs: number; rightTs: number }>({ left: null, lastLeftTs: 0, rightTs: 0 });
  const [dualMissing, setDualMissing] = useState<string | null>(null); // ktorá ruka nedodáva dáta
  const lastImuTsRef = useRef<number | null>(null);
  const lastGestureTimeRef = useRef<number>(0); // Samostatný timestamp pre gestá
  const lastPieceSwitchTimeRef = useRef<number>(0); // Timestamp pre zmenu blokov
  // === Relatívny pohyb bloku pri gripe ===
  const gripStartGridRef = useRef<{ x: number; y: number } | null>(null); // Pozícia ruky na začiatku gripu
  const gripStartPieceRef = useRef<{ row: number; col: number } | null>(null); // Pozícia bloku na začiatku gripu
  const wasGrippingRef = useRef<boolean>(false); // Predchádzajúci stav gripu
  const moveLastStepRef = useRef<number>(0); // čas posledného kroku bloku (ms)
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
  const twistLastTsRef = useRef<number>(0);
  const twistQuietUntilRef = useRef<number>(0);
  const twistActiveTsRef = useRef<number>(0);
  const flipAccRef = useRef<number>(0);
  const flipActiveTsRef = useRef<number>(0);
  const flipLastTsRef = useRef<number>(0);
  const twistShowingRef = useRef<boolean>(false);
  const rotSettlingFnRef = useRef<(() => boolean) | null>(null);
  const twistAccRef = useRef<number>(0); // Akumulované otočenie zápästia (°) počas gripu
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
  const { isCalibrated, neutralQuat, neutralQuats, requestCalibration, showCalibrationModal } = useCalibration();
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

  // Vytvor IMU kontroléry (jedna ruka = 1, dve ruky = 2)
  const ensureCtrls = () => {
    if (!imuCtrlRef.current) {
      imuCtrlRef.current = new SingleIMUController();
      imuCtrlRef.current.gyroDivisor = 1; // streamer posiela gyro už v °/s
      // Rovnaké snímanie polohy ako v "Skúške kreslenia": izotropný lineárny náklon z uhla, bez zosilnenia pri stisku
      imuCtrlRef.current.linearTilt = true;
      imuCtrlRef.current.angleTilt = true;
      imuCtrlRef.current.precisionScale = 1;
      imuCtrlRef.current.posGain = HAND_POS_GAIN;
      // Rýchlejšia odozva bez chvenia: menej vyhladzovania polohy, väčšia hysterézia hranice bunky (presnosť)
      imuCtrlRef.current.posAlpha = 0.4;
      imuCtrlRef.current.gridSmoothAlpha = 0.25;
      imuCtrlRef.current.cellHysteresis = 0.3;
    }
    if (dualHands && !imuCtrlLRef.current) {
      imuCtrlLRef.current = new SingleIMUController();
      imuCtrlLRef.current.gyroDivisor = 1;
    }
  };

  // Globálna IMU kalibrácia
  useEffect(() => {
    ensureCtrls();
    if (dualHands) {
      if (neutralQuats.right) imuCtrlRef.current?.calibrateNeutral(neutralQuats.right);
      if (neutralQuats.left) imuCtrlLRef.current?.calibrateNeutral(neutralQuats.left);
    } else if (imuCtrlRef.current && neutralQuat) {
      imuCtrlRef.current.calibrateNeutral(neutralQuat);
    }
  }, [neutralQuat, neutralQuats, dualHands]);

  // Režim dvoch rúk: upozorni, ak jedno zariadenie nedodáva dáta
  useEffect(() => {
    if (!dualHands) { setDualMissing(null); return; }
    const id = window.setInterval(() => {
      const t = Date.now();
      const leftOk = !!dualRef.current.left && t - dualRef.current.left.ts < 1500;
      const rightOk = t - dualRef.current.rightTs < 1500;
      setDualMissing(!leftOk && !rightOk ? 'obe ruky' : !leftOk ? 'ľavá ruka' : !rightOk ? 'pravá ruka' : null);
    }, 700);
    return () => window.clearInterval(id);
  }, [dualHands]);

  // Spracovanie IMU: počúvaj 'imu-sample' udalosti odoslané z WebSocketStatus
  useEffect(() => {
    ensureCtrls();

    function onSample(ev: Event) {
      // Freeze game processing ak nie sme pripojení, nie sme kalibrovaní alebo je otvorený kalibračný modal
      if (wsConnected && !isCalibrated && showCalibrationModal) return;
      try {
        const detail = (ev as CustomEvent).detail;
        if (!detail) return;
        const sample = { imu: detail.imu || {}, adc: detail.adc || [], ts: Date.now() } as any;
        const adc: number[] = Array.isArray(detail.adc) ? detail.adc : [];

        // === REŽIM DVOCH RÚK ===
        // Ľavá ruka len aktualizuje svoj kontrolér; celá logika hry beží na vzorkách pravej ruky
        // a pracuje so zlúčenými hodnotami (obe ruky musia robiť pohyb spolu).
        let dualL: { sample: any; out: any; ts: number } | null = null;
        if (dualHands) {
          const h = detail.hand;
          if (h !== 'left' && h !== 'right') return;
          const tN = Date.now();
          if (h === 'left') {
            const ctrlL = imuCtrlLRef.current;
            if (!ctrlL) return;
            const dtL = Math.max(1, tN - (dualRef.current.lastLeftTs || tN)) / 1000;
            dualRef.current.lastLeftTs = tN;
            dualRef.current.left = { sample, out: ctrlL.update(sample, dtL), ts: tN };
            return;
          }
          dualRef.current.rightTs = tN;
          dualL = dualRef.current.left;
          if (!dualL || tN - dualL.ts > 1000) return; // čakáme na obe zariadenia
        }

        const now = Date.now();
        const last = lastImuTsRef.current ?? now;
        const dt = Math.max(1, now - last) / 1000;
        lastImuTsRef.current = now;

        // === DETEKCIA STISKU (z GameBoard.tsx) ===
        const defaultRawThr = (cfg as any)?.TENSOMETER_RAW_THRESHOLD ?? 2000;
        const defaultNormThr = (cfg as any)?.TENSOMETER_NORM_THRESHOLD ?? 12;
        // Prsty jednej ruky (adc[1..5] = malíček->palec; pri pravej po reverze)
        const analyzeHand = (adcArr: number[], leftHand: boolean) => {
          const raw5 = Array.isArray(adcArr) ? adcArr.slice(1, 6).map((v: any) => Number(v || 0)) : [];
          const f = leftHand ? raw5 : raw5.slice().reverse();
          const pressed = f.map((v) => {
            const raw = Math.abs(v ?? 0);
            return raw > defaultRawThr || normalizeAdc(raw) > defaultNormThr; // surový alebo normalizovaný prah
          });
          return {
            count: pressed.filter(Boolean).length,
            // Ukazovák: pri ľavej ruke index 3, pri pravej po reverze index 1; palec vždy index 4
            index: leftHand ? pressed[3] : pressed[1],
            thumb: pressed[4],
          };
        };
        const anaMain = analyzeHand(adc, dualHands ? false : useLeftHand);
        const anaLeft = dualHands && dualL ? analyzeHand(dualL.sample.adc, true) : null;
        // Dve ruky: grip a prsty platia len keď ich stláčajú OBE ruky (min / AND)
        const pressedCount = anaLeft ? Math.min(anaMain.count, anaLeft.count) : anaMain.count;
        const manualGrip = pressedCount === 5;
        setIsGripping(pressedCount > 0);

        const indexFingerPressed = anaLeft ? anaMain.index && anaLeft.index : anaMain.index;
        const thumbPressed = anaLeft ? anaMain.thumb && anaLeft.thumb : anaMain.thumb;
        const singlePressed = !manualGrip && indexFingerPressed && pressedCount === 1;
        const noPress = pressedCount === 0;

        const rightCorr = dualHands || !useLeftHand;
        imuCtrlRef.current!.tiltRotationDeg = rightCorr ? TILT_ROTATION_RIGHT_DEG : 0;
        imuCtrlRef.current!.shearUp = rightCorr ? SHEAR_UP_RIGHT_HAND : 0;
        imuCtrlRef.current!.shearRight = rightCorr ? SHEAR_RIGHT_RIGHT_HAND : 0;
        const outMain = imuCtrlRef.current!.update(sample, dt);
        // Dve ruky: sensitívny grip len keď oba, flick z ktorejkoľvek ruky
        const out = dualL
          ? { ...outMain, grip: outMain.grip && dualL.out.grip, gesture: outMain.gesture ?? dualL.out.gesture ?? null }
          : outMain;

        // Normalizácia gyroskopu (streamer posiela °/s)
        const nMain = normalizeImuSample(sample.imu, 1);
        const nLeft = dualL ? normalizeImuSample(dualL.sample.imu, 1) : null;
        const imuN = nMain;
        // Dve ruky: gyro sa započíta len keď sa obe ruky hýbu rovnakým smerom (menšia z rýchlostí)
        const gx = nLeft ? fuseSigned(nMain.gyroX_dps, nLeft.gyroX_dps, 1, DUAL_LEFT_GYRO_SIGN.x) : nMain.gyroX_dps;
        const gy = nLeft ? fuseSigned(nMain.gyroY_dps, nLeft.gyroY_dps, 1, DUAL_LEFT_GYRO_SIGN.y) : nMain.gyroY_dps;
        const gz = nLeft ? fuseSigned(nMain.gyroZ_dps, nLeft.gyroZ_dps, 1, DUAL_LEFT_GYRO_SIGN.z) : nMain.gyroZ_dps;

        // Otočenie zápästia = gyro Z dominantné nad X,Y a nad mŕtvou zónou; posun ruky sa tak nezamení s otočením.
        // Znamienko: otočenie kisti doprava (v smere hodinových ručičiek) = kladné gyro Z = kúsok doprava.
        const gzTwist = Math.abs(gz) > TWIST_DEADZONE_DPS && Math.abs(gz) > TWIST_DOMINANCE * Math.max(Math.abs(gx), Math.abs(gy)) ? gz : 0;

        // Pozícia na gride z IMU
        // Unified mapping copied from majo: X direct, Y inverted for left hand
        // Pravá ruka: os X je zrkadlovo obrátená (ťah doprava = blok doprava), ľavá ostáva priama
        const gridSz = imuCtrlRef.current!.gridSize;
        let gridX: number;
        let gridY: number;
        if (dualL) {
          // Dve ruky: priemer polôh oboch rúk (každá s mapovaním svojej strany) -> blok ide tam, kam idú obe
          gridX = Math.round(((gridSz - 1 - outMain.grid.x) + dualL.out.grid.x) / 2);
          gridY = Math.round((outMain.grid.y + (gridSz - 1 - dualL.out.grid.y)) / 2);
        } else {
          gridX = useLeftHand ? out.grid.x : (gridSz - 1 - out.grid.x);
          gridY = useLeftHand ? (gridSz - 1 - out.grid.y) : out.grid.y;
        }

        // === ROTÁCIA A FLIP PRI STLAČENOM UKAZOVÁKU ===
        const GYRO_ROTATION_THRESHOLD = 20; // °/s - zvýšené z 15 na 20
        const GYRO_FLIP_THRESHOLD = 22; // °/s - zvýšené z 18 na 22
        const GYRO_ROTATION_COOLDOWN_MS = 800; // ms - zvýšené z 650 na 800
        const MAX_SHIFT = 5; // Maximálny posun pre auto-shift

        // Helper: nájdi najbližšiu validnú pozíciu pre transformovaný blok
        const findValidPosition = (
          tempGrid: boolean[][],
          transformedPiece: boolean[][],
          startRow: number,
          startCol: number
        ) => findNearestValidPosition(tempGrid, transformedPiece, startRow, startCol, MAX_SHIFT);

        const currentActivePieceId = activePieceIdRef.current;
        
        // === ZDIEĽANÁ ZMENA AKTÍVNEHO BLOKU (double-tap aj flick) ===
        // direction: 1 = ďalší, -1 = predchádzajúci; zdieľaný cooldown zabráni dvojitému prepnutiu
        const PIECE_SWITCH_COOLDOWN_MS = 500;
        const switchActivePiece = (direction: 1 | -1): boolean => {
          if (now - lastPieceSwitchTimeRef.current < PIECE_SWITCH_COOLDOWN_MS) return false;
          const pieces = placedPiecesRef.current;
          const idx = pieces.findIndex(p => p.uid === currentActivePieceId);
          if (idx === -1 || pieces.length <= 1) return false;
          const next = pieces[(idx + direction + pieces.length) % pieces.length];
          if (!next || !next.uid) return false;
          setActivePieceId(next.uid);
          lastPieceSwitchTimeRef.current = now;
          return true;
        };
        
        // === EXKLUZIVITA AKCIÍ ===
        // Ak je stlačený palec (zmena blokov), NEVYKonávaj rotáciu ani flip
        const isThumbAction = thumbPressed && !manualGrip && !indexFingerPressed;
        
        // PLYNULÁ ROTÁCIA ZÁPÄSTÍM (rovnaká logika ako klávesy R/E): pri stisnutom gripe sa nakumulovaný
        // uhol zápästia (gyro Z) priebežne zobrazuje na kúsku; po pustení gripu alebo po pauze sa
        // kúsok prichytí na najbližší násobok 90° (pod 45° späť, nad 45° na 90°).
        // Kým sa blok presúva (movementStartedRef), sa neotáča – akumulátor sa vtedy ukončí.
        const sendTwist = (detail: { uid?: string; angle?: number; release?: boolean }) =>
          window.dispatchEvent(new CustomEvent('piece-twist', { detail }));
        const rotSettling = !!rotSettlingFnRef.current?.();
        if (manualGrip && currentActivePieceId && !draggingRef.current && !isThumbAction) {
          if (rotSettling) {
            twistAccRef.current = 0; // počas dorovnávania (prichytenia) nič nenaberaj
            twistLastTsRef.current = 0;
          } else if (now - twistLastTsRef.current >= TWIST_SAMPLE_MS) {
            const twistDt = Math.min(0.25, (now - twistLastTsRef.current) / 1000);
            if (twistLastTsRef.current > 0 && gzTwist !== 0) {
              twistAccRef.current = Math.max(-270, Math.min(270, twistAccRef.current + (gzTwist * twistDt) / TWIST_DIFFICULTY));
              twistActiveTsRef.current = now;
            }
            twistLastTsRef.current = now;
            if (twistAccRef.current !== 0) {
              twistShowingRef.current = true;
              sendTwist({ uid: currentActivePieceId, angle: twistAccRef.current });
              // Pauza v otáčaní -> prichyť na najbližších 90° a pokračuj odznova
              if (now - twistActiveTsRef.current > TWIST_COMMIT_IDLE_MS) {
                sendTwist({ release: true });
                twistShowingRef.current = false;
                twistAccRef.current = 0;
              }
            }
          }
        } else {
          if (twistShowingRef.current) {
            sendTwist({ release: true }); // grip pustený / začal presun -> prichyť
            twistShowingRef.current = false;
          }
          twistAccRef.current = 0;
          twistLastTsRef.current = 0;
        }

        // FLIP AKUMULÁCIOU: kumulujeme otočenie okolo osi X len keď je X jasne dominantná os,
        // je nad mŕtvou zónou, grip je plný a blok sa nepresúva ani sa práve neotáča zápästím.
        // Jednorazová špička (šum, mávnutie, náklon pri ťahu) sa tak nikdy nepremení na flip.
        const flipGateOpen = manualGrip && !!currentActivePieceId && !draggingRef.current && !isThumbAction &&
          !movementStartedRef.current && Math.abs(twistAccRef.current) < 20;
        if (flipGateOpen) {
          const fdt = flipLastTsRef.current > 0 ? Math.min(0.1, (now - flipLastTsRef.current) / 1000) : 0;
          flipLastTsRef.current = now;
          const gf = (gy - gx) / Math.SQRT2;                 // flipová os (diagonála X/Y)
          const gPerp = (gy + gx) / Math.SQRT2;              // kolmá zložka v rovine X/Y (pri kyvnutí ~0)
          const dominant = Math.abs(gf) > FLIP_DOMINANCE * Math.abs(gPerp) && Math.abs(gf) > FLIP_DOMINANCE * Math.abs(gz);
          if (dominant && Math.abs(gf) > FLIP_DEADZONE_DPS) {
            // opačný smer (návrat ruky) akumulátor skôr zruší, než by sa nabil
            if (flipAccRef.current !== 0 && Math.sign(gf) !== Math.sign(flipAccRef.current)) flipAccRef.current = 0;
            flipAccRef.current += gf * fdt;
            flipActiveTsRef.current = now;
          } else if (now - flipActiveTsRef.current > FLIP_IDLE_RESET_MS) {
            flipAccRef.current = 0;
          }
        } else {
          flipAccRef.current = 0;
          flipLastTsRef.current = 0;
        }

        // ROTÁCIA: keď je stlačený GRIP (všetky prsty) -> otáčaj podľa osi Z gyra
        // Použitie hysterézie: gyroskop musel byť pred tým uvoľnený
        if (manualGrip && currentActivePieceId && !draggingRef.current && !isThumbAction && !movementStartedRef.current) {
          const currentPlacedPieces = placedPiecesRef.current;
          const activePiece = currentPlacedPieces.find((p) => p.uid === currentActivePieceId);
          
          if (activePiece && now - lastGestureTimeRef.current >= GYRO_ROTATION_COOLDOWN_MS) {
            const gyro = out.gyro || { x: 0, y: 0, z: 0 };
            
            // FLIP: nakumulovaný uhol okolo X dosiahol FLIP_STEP_DEG (viď akumulácia vyššie)
            if (Math.abs(flipAccRef.current) >= FLIP_STEP_DEG) {
              const sign = Math.sign(flipAccRef.current);
              flipAccRef.current = 0;
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
                  triggerFlipAnim(currentActivePieceId);
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
          // Pri stlačení všetkých prstov nastav aktuálnu polohu ruky ako novú kalibrovanú nulu
          // a vynuluj akumulovaný uhol, aby sa náklon/otočenie nenabaľovalo medzi gripmi.
          imuCtrlRef.current?.recenter(sample.imu);
          if (dualL) imuCtrlLRef.current?.recenter(dualL.sample.imu);
          gripStartGridRef.current = null;
          gripStartPieceRef.current = null;
          twistQuietUntilRef.current = 0;
          twistActiveTsRef.current = 0;
          twistAccRef.current = 0;
          twistLastTsRef.current = 0;
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
                  switchActivePiece(1);
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
        
        // === FLICK GESTO: zmena aktívneho bloku (alternatíva k double-tap) ===
        // flick-up = ďalší blok, flick-down = predchádzajúci; left/right sa ignorujú.
        // Prijaté len v pokojnom stave (bez gripu, bez prstov, bez presúvania), aby sa
        // nezamenilo s pohybom ruky pri nesení bloku.
        if (
          FLICK_SWITCH_ENABLED &&
          out.gesture &&
          pressedCount === 0 &&
          !wasGrippingRef.current &&
          !movementStartedRef.current &&
          !draggingRef.current
        ) {
          if (out.gesture === 'flick-up') switchActivePiece(1);
          else if (out.gesture === 'flick-down') switchActivePiece(-1);
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
            // Otáčanie zápästím nakláňa ruku a posúva kurzor – kým trvá (a chvíľu po ňom) sa blok nehýbe:
            // prebázuj východiskový bod ruky aj bloku, aby po otočení nenastal skok ani zbytočný presun.
            if (gzTwist !== 0 || twistAccRef.current !== 0) twistQuietUntilRef.current = now + TWIST_QUIET_MS;
            if (movementStartedRef.current && now < twistQuietUntilRef.current) {
              gripStartGridRef.current = { x: gridX, y: gridY };
              gripStartPieceRef.current = { row: activePiece.row, col: activePiece.col };
            }
            // Ak práve začal HOLD (prechod z čakania na tap do pohybu)
            if (!movementStartedRef.current) {
              const base = gripStartGridRef.current;
              if (!base || now < twistQuietUntilRef.current) {
                gripStartGridRef.current = { x: gridX, y: gridY };
              } else if (!rotSettling && Math.max(Math.abs(gridX - base.x), Math.abs(gridY - base.y)) >= MOVE_START_CELLS) {
                // Ruka sa naozaj posunula -> začni presun od aktuálnej polohy (bez skoku)
                saveToHistory(); // pre undo
                movementStartedRef.current = true;
                gripStartGridRef.current = { x: gridX, y: gridY };
                gripStartPieceRef.current = { row: activePiece.row, col: activePiece.col };
                setIsGripping(true); // Aktivuj vizuálny grip a blokuj kontrolu výhry
              }
            }
            
            // Vypočítaj relatívny posun od začiatku gripu
            const startGrid = gripStartGridRef.current;
            const startPiece = gripStartPieceRef.current;
            
            if (startGrid && startPiece) {
              const deltaX = gridX - startGrid.x;
              const deltaY = gridY - startGrid.y;
              
              // Cieľová pozícia bloku = počiatočná pozícia + posun ruky; blok k nej ide
              // najviac o 1 bunku na os za tik (žiadne preskakovanie ani "teleport")
              const targetCol = startPiece.col + deltaX;
              const targetRow = startPiece.row + deltaY;
              // Jedna bunka za MOVE_STEP_MS; len dominantná os (druhá až keď je dostatočne veľká) -> žiadne uhlopriečky
              const dCol = targetCol - activePiece.col;
              const dRow = targetRow - activePiece.row;
              const step = pieceStep(dCol, dRow, now - moveLastStepRef.current >= MOVE_STEP_MS);
              const newCol = activePiece.col + step.dc;
              const newRow = activePiece.row + step.dr;
            
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
                  moveLastStepRef.current = now;
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
          pitch: Math.round(imuN.pitchDeg * 10) / 10,
          roll: Math.round(imuN.rollDeg * 10) / 10,
          yaw: Math.round(imuN.yawDeg * 10) / 10,
          gyro: out.gyro,
          linAcc: { x: Math.round(imuN.linAccX*10)/10, y: Math.round(imuN.linAccY*10)/10 },
          adcMax: Math.max(0, ...((sample.adc || []) as number[]).slice(1,5).map((v: number) => normalizeAdc(v))),
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
        // Len pre držaný (novo zdvihnutý) kúsok a len pri skutočnom gripe (všetkých 5 prstov).
        // Rotáciu/flip umiestnených kúskov riešia bloky vyššie (twist akumulácia a flip),
        // inak `out.grip` (veľmi citlivý) + prah 10 °/s točil kúsok každých 300 ms.
        if (out.grip && manualGrip && draggingRef.current) {
          const gyro = out.gyro || { x: 0, y: 0, z: 0 };
          const nowMs = Date.now();
          // Cooldown aby sa predišlo rýchlemu opakovaniu
          const cooldown = 700;
          const last = (window as any)._lastGyroActionTs || 0;
          const flipThresh = 60; // °/s pre flip
          const rotateThresh = 60; // °/s pre rotáciu
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
  }, [currentLevel, placedPieces, wsConnected, isCalibrated, showCalibrationModal, useLeftHand, dualHands]);


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
      // Pri okraji poľa sa kúsok po otočení posunie na najbližšiu platnú pozíciu
      const pos = findNearestValidPosition(tempGrid, rotatedGrid, activePiece.row, activePiece.col);
      if (pos) {
        const newGrid = placePiece(tempGrid, rotatedGrid, pos.row, pos.col, activePiece.color);
        setGrid(newGrid);
        setPlacedPieces(prev => prev.map((p) => p.uid === activePiece.uid ? { ...p, grid: rotatedGrid, row: pos.row, col: pos.col } : p));
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
      // Pri okraji poľa sa kúsok po otočení posunie na najbližšiu platnú pozíciu
      const pos = findNearestValidPosition(tempGrid, flippedGrid, activePiece.row, activePiece.col);
      if (pos) {
        const newGrid = placePiece(tempGrid, flippedGrid, pos.row, pos.col, activePiece.color);
        setGrid(newGrid);
        setPlacedPieces(prev => prev.map((p) => p.uid === activePiece.uid ? { ...p, grid: flippedGrid, row: pos.row, col: pos.col } : p));
        triggerFlipAnim(activePiece.uid);
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
      // F10 alebo D = toggle IMU debug
      if (e.key === 'F10' || (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'd')) {
        e.preventDefault();
        setShowImuDebug(s => !s);
        return;
      }
      
      // Plynulú rotáciu (R/E) rieši samostatný effect, ak nedržíme kúsok myšou
      if (SMOOTH_ROTATE_ENABLED && !draggingPiece && (e.key.toLowerCase() === 'r' || e.key.toLowerCase() === 'e')) return;

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

  // === PLYNULÁ ROTÁCIA KLÁVESOM (R = doprava, E = doľava) ===
  const saveToHistoryRef = useRef(saveToHistory);
  useEffect(() => { saveToHistoryRef.current = saveToHistory; }, [saveToHistory]);

  useEffect(() => {
    if (!SMOOTH_ROTATE_ENABLED) return;

    type Plan = { grid: boolean[][]; row: number; col: number; idealRow: number; idealCol: number };
    type Rot = {
      uid: string; angle: number; dir: 1 | -1; heldKey: string; startedAt: number;
      phase: 'hold' | 'settle'; target: number; plan: Plan | null;
    };
    let rot: Rot | null = null;
    let raf = 0;
    let lastT = 0;
    const timers: number[] = [];

    const commit = () => {
      const r = rot;
      rot = null;
      if (r && r.plan) {
        const plan = r.plan;
        const piece = placedPiecesRef.current.find((p) => p.uid === r.uid);
        if (piece) {
          saveToHistoryRef.current();
          const tmp = removePiece(gridRef.current, piece);
          setGrid(placePiece(tmp, plan.grid, plan.row, plan.col, piece.color));
          setPlacedPieces((prev) => prev.map((p) => (p.uid === r.uid ? { ...p, grid: plan.grid, row: plan.row, col: plan.col } : p)));
          breatheSyncOffsetRef.current = Date.now() % BREATH_MS;
          // Nový tvar má stred o kúsok inde (celé bunky) – zjemni skok krátkym dorovnaním
          const tx = (plan.idealCol - plan.col) * CELL_SIZE;
          const ty = (plan.idealRow - plan.row) * CELL_SIZE;
          setRotVisual({ uid: r.uid, angle: 0, tx, ty, ease: false });
          timers.push(window.setTimeout(() => setRotVisual((v) => (v && v.uid === r.uid ? { ...v, tx: 0, ty: 0, ease: true } : v)), 30));
          timers.push(window.setTimeout(() => setRotVisual(null), 30 + ROTATE_EASE_MS + 30));
          return;
        }
      }
      setRotVisual(null);
    };

    const frame = (t: number) => {
      if (!rot) return;
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      let done = false;
      if (rot.phase === 'hold') {
        if (rot.heldKey !== 'wrist') rot.angle = Math.max(-270, Math.min(270, rot.angle + rot.dir * ROTATE_SPEED_DPS * dt));
      } else {
        const diff = rot.target - rot.angle;
        const step = ROTATE_SPEED_DPS * ROTATE_SETTLE_FACTOR * dt;
        if (Math.abs(diff) <= step) { rot.angle = rot.target; done = true; }
        else rot.angle += Math.sign(diff) * step;
      }
      setRotVisual({ uid: rot.uid, angle: rot.angle, tx: 0, ty: 0, ease: false });
      if (done) commit();
      else raf = requestAnimationFrame(frame);
    };

    const release = () => {
      if (!rot || rot.phase !== 'hold') return;
      const piece = placedPiecesRef.current.find((p) => p.uid === rot!.uid);
      if (!piece) { rot = null; setRotVisual(null); cancelAnimationFrame(raf); return; }

      // Najbližší násobok 90° (±45° je hranica); veľmi krátke ťuknutie = celý krok
      let steps = Math.round(rot.angle / 90);
      if (steps === 0 && ROTATE_TAP_MS > 0 && performance.now() - rot.startedAt < ROTATE_TAP_MS) steps = rot.dir;
      const quarter = ((steps % 4) + 4) % 4;
      let target = steps * 90;
      let plan: Plan | null = null;

      if (quarter !== 0) {
        let g = piece.grid;
        for (let i = 0; i < quarter; i++) g = rotatePentomino(g);
        const tmp = removePiece(gridRef.current, piece);
        const idealRow = piece.row + (piece.grid.length - g.length) / 2;
        const idealCol = piece.col + (piece.grid[0].length - g[0].length) / 2;
        const pos = findNearestValidPosition(tmp, g, Math.round(idealRow), Math.round(idealCol));
        if (pos) plan = { grid: g, row: pos.row, col: pos.col, idealRow, idealCol };
        else target = 0; // nikde sa nezmestí – vráť späť
      }
      rot.phase = 'settle';
      rot.target = target;
      rot.plan = plan;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k !== 'r' && k !== 'e') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if ((window as any).__modalOpen) return;
      if (wsConnected && !isCalibrated && showCalibrationModal) return;
      if (draggingRef.current || rot) return; // držaný kúsok rieši pôvodný handler
      const uid = activePieceIdRef.current;
      if (!uid || !placedPiecesRef.current.some((p) => p.uid === uid)) return;
      rot = { uid, angle: 0, dir: k === 'r' ? 1 : -1, heldKey: k, startedAt: performance.now(), phase: 'hold', target: 0, plan: null };
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    };
    // Zápästie (IMU) riadi tú istú rotáciu ako klávesy: 'piece-twist' {uid, angle} / {release}
    rotSettlingFnRef.current = () => !!rot && rot.phase === 'settle';
    const onTwist = (ev: Event) => {
      const d = (ev as CustomEvent).detail || {};
      if (d.release) {
        if (rot && rot.heldKey === 'wrist' && rot.phase === 'hold') {
          release();
          lastT = performance.now();
          raf = requestAnimationFrame(frame);
        }
        return;
      }
      if (draggingRef.current || typeof d.angle !== 'number' || !d.uid) return;
      if (rot && (rot.heldKey !== 'wrist' || rot.phase !== 'hold')) return; // klávesy majú prednosť
      if (!rot) {
        if (!placedPiecesRef.current.some((p) => p.uid === d.uid)) return;
        rot = { uid: d.uid, angle: d.angle, dir: d.angle >= 0 ? 1 : -1, heldKey: 'wrist', startedAt: -1e9, phase: 'hold', target: 0, plan: null };
      } else {
        rot.angle = d.angle;
        rot.dir = d.angle >= 0 ? 1 : -1;
      }
      setRotVisual({ uid: rot.uid, angle: rot.angle, tx: 0, ty: 0, ease: false });
    };
    window.addEventListener('piece-twist', onTwist);

    const onKeyUp = (e: KeyboardEvent) => {
      if (rot && e.key.toLowerCase() === rot.heldKey) release();
    };
    const onBlur = () => release();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('piece-twist', onTwist);
      rotSettlingFnRef.current = null;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
      rot = null;
      setRotVisual(null);
    };
  }, [wsConnected, isCalibrated, showCalibrationModal, CELL_SIZE]);

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
      {dualHands && dualMissing && wsConnected && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-xl bg-amber-100 text-amber-900 shadow-lg text-sm font-medium">
          Režim dvoch rúk: nedostávam dáta z {dualMissing === 'obe ruky' ? 'oboch zariadení' : `zariadenia (${dualMissing})`}. Skontrolujte pripojenie.
        </div>
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
                  key={`placed-${piece.uid ?? index}${flipAnim && flipAnim.uid === piece.uid ? `-f${flipAnim.n}` : ''}`}
                  className={`absolute transition-all ${piece.uid === activePieceId ? 'cursor-move' : 'cursor-pointer'}`}
                  style={{
                    left: 12 + piece.col * CELL_SIZE,
                    top: 12 + piece.row * CELL_SIZE,
                    // Plynulé kĺzanie po bunkách pri presúvaní (namiesto skokov)
                    transition: 'left 90ms linear, top 90ms linear', // plynulý posun medzi bunkami (krok bloku je MOVE_STEP_MS)
                    ...(rotVisual && rotVisual.uid === piece.uid
                      ? {
                          width: (piece.grid[0]?.length ?? 0) * CELL_SIZE,
                          height: piece.grid.length * CELL_SIZE,
                          transformOrigin: '50% 50%',
                          transform: `translate(${rotVisual.tx}px, ${rotVisual.ty}px) rotate(${rotVisual.angle}deg)`,
                          transition: rotVisual.ease ? `transform ${ROTATE_EASE_MS}ms ease-out` : 'none',
                        }
                      : {}),
                    // Rozmery len počas animácie (transform-origin = stred kúska); inak by prázdne rohy boli klikateľné
                    ...(flipAnim && flipAnim.uid === piece.uid
                      ? {
                          width: (piece.grid[0]?.length ?? 0) * CELL_SIZE,
                          height: piece.grid.length * CELL_SIZE,
                          animation: `piece-flip ${SMOOTH_FLIP_MS}ms ease-in-out`,
                        }
                      : {}),
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
