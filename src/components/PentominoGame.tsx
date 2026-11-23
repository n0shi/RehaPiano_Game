import { useState, useEffect, useCallback, useRef } from 'react';
import { sampleDt } from '../utils/sampleClock';
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
  findStartPosition,
  fitsOnGrid,
  placePiece,
  removePiece,
  isLevelComplete,
  getCoverage,
} from '../utils/pentominoUtils';
import { FingerCalibration } from '../types/game';
import '../animations.css';
import { normalizeAdc, normalizeImuSample } from '../utils/imuNormalize';
import { gripOf } from '../utils/fingerCalibration';
import { currentCursorModel } from '../utils/cursorModel';
import { useAuth } from '../context/AuthContext';
import { SessionRecorder } from '../utils/sessionRecorder';
import { addResult } from '../utils/results';
import { GloveCursor } from '../utils/gloveCursor';
import { CursorGripInput } from '../utils/cursorInput';
import { PieceManipulator, type ManipSnapshot, type CommitInfo } from '../utils/pieceManip';

// Ovládanie rukavicou je kurzorové (port z Tangram): otvorená dlaň hýbe kurzorom, plný stisk > 200 ms zachytí blok pod
// kurzorom, otočenie zápästia (gyro Z) ho plynulo otáča, kývnutie zápästia ho prevráti, uvoľnenie prstov ho prichytí na mriežku.
// Gestá sú v utils/cursorInput.ts, správanie bloku (ťahanie, otáčanie, prevrat, prichytenie) v utils/pieceManip.ts.
// Pohyb ruky -> kurzor (náklon, zosilnenia, zmrazenie pri stisku a uvoľnení, vynulovanie, 3 s držanie = nový nulový bod) je
// v utils/gloveCursor.ts – rovnaký pre Pentomino, Tetris a presúvanie blokov.
const SHOW_GLOVE_CURSOR = true; // kurzor rukavice: stisk všetkých prstov nad blokom ho zachytí (pozri PieceManipulator.begin)
// Blok ide za rukou plynulo (desatinné bunky) a na mriežku sa prichytí až po pustení. Ťahanie po bunkách (PIECE_STEP_MOVE = true)
// blok počas držania "priťahovalo" k bunkám a spolu so zámkom osi kurzora brzdilo šikmý pohyb (hore a do strany): bočná zložka
// sa zahadzovala, kým nedosiahla 70–80 % hlavnej, takže blok chvíľami stál. Zámok osi kurzora je preto zrušený.
const PIECE_STEP_MOVE = false;
// Farby hracieho poľa
const BOARD_FRAME = '#e2e8f0';      // okraj okolo mriežky
const BOARD_CELL = '#f1f5f9';       // bunky mimo cieľa
const BOARD_LINE = '#b8c4d4';       // čiary buniek
const BOARD_LINE_MAJOR = '#8a9bb2'; // každá 5. čiara
const TARGET_FILL = 'rgba(253, 230, 138, 0.55)'; // cieľová plocha (jemná žltá), čierny obrys ostáva
const SAMPLE_TIMEOUT_MS = 2000;     // (stream sa každých ~40 s na ~1 s preruší, preto nie menej)  bez vzoriek dlhšie ako toto sa gesto preruší a pred ďalším treba uvoľniť prsty
const EMPTY_SNAPSHOT: ManipSnapshot = { live: null, cursor: null, hoverUid: null };
// Zmenilo sa niečo, čo kreslí React (všetko okrem kurzora)?
function sameSnap(a: ManipSnapshot, b: ManipSnapshot): boolean {
  if (a.hoverUid !== b.hoverUid) return false;
  const x = a.live, y = b.live;
  if (!x || !y) return x === y;
  return x.uid === y.uid && x.grid === y.grid && x.cx === y.cx && x.cy === y.cy && x.angle === y.angle &&
    x.flipScale === y.flipScale && x.grabbed === y.grabbed && x.ghost === y.ghost;
}
const SELECTED_OUTLINE = '#17647d'; // obrys vybraného bloku (rovnaká farba ako v Tangrame)

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
  // Snímka stavu z PieceManipulator: kurzor, držaný/otáčaný blok, náhľad dosadnutia (prekresľuje sa po snímkach)
  const [snap, setSnap] = useState<ManipSnapshot>(EMPTY_SNAPSHOT);
  const snapRef = useRef<ManipSnapshot>(EMPTY_SNAPSHOT);
  const cursorElRef = useRef<HTMLDivElement | null>(null);
  const cursorShownRef = useRef({ x: NaN, y: NaN, grip: false, vis: false });
  const cellSizeRef = useRef(CELL_SIZE);
  cellSizeRef.current = CELL_SIZE;
  const drawCursor = (c: ManipSnapshot['cursor']) => {
    const el = cursorElRef.current;
    if (!el) return;
    const st = cursorShownRef.current;
    const vis = SHOW_GLOVE_CURSOR && !!c;
    if (vis !== st.vis) { el.style.display = vis ? 'block' : 'none'; st.vis = vis; }
    if (!c) return;
    const cs = cellSizeRef.current, x = 12 + c.col * cs, y = 12 + c.row * cs;
    if (x !== st.x || y !== st.y) { el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; st.x = x; st.y = y; }
    if (c.grip !== st.grip) { el.dataset.grip = c.grip ? 'true' : 'false'; st.grip = c.grip; }
  };
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
  const lastSampleAtRef = useRef<number>(0); // čas poslednej vzorky (strážca straty dát)
  const gridRef = useRef(grid);
  const availableRef = useRef(availablePieces);
  const draggingRef = useRef(draggingPiece);
  const placedPiecesRef = useRef(placedPieces);
  const activePieceIdRef = useRef(activePieceId);
  const grabbedRef = useRef(false); // blok drží ruka – kontrola výhry počká na uvoľnenie
  const manipRef = useRef<PieceManipulator | null>(null);
  const inputRef = useRef<CursorGripInput | null>(null);
  const commitPieceRef = useRef<(info: CommitInfo) => void>(() => {});
  const playableRef = useRef(true);
  const wonKeyRef = useRef<string | null>(null);        // level (index:reload), ktorého výhra sa už zaznamenala
  const finishLevelRef = useRef<() => void>(() => {});
  const showImuDebugRef = useRef(false);
  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => { availableRef.current = availablePieces; }, [availablePieces]);
  useEffect(() => { draggingRef.current = draggingPiece; }, [draggingPiece]);
  useEffect(() => { placedPiecesRef.current = placedPieces; }, [placedPieces]);
  useEffect(() => { activePieceIdRef.current = activePieceId; }, [activePieceId]);
  useEffect(() => { scaleRef.current = scale; }, [scale]); // Synchronizácia scaleRef
  // Stav debug overlay
  const [showImuDebug, setShowImuDebug] = useState<boolean>(false);
  showImuDebugRef.current = showImuDebug;
  const [imuDebug, setImuDebug] = useState<any>({});
  const { isCalibrated, neutralQuat, neutralQuats, requestCalibration, showCalibrationModal } = useCalibration();
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [handRolled, setHandRolled] = useState<boolean>(false); // rukavica rozpoznaná ako otočená (vstavané osi pre otočenú polohu)
  // Kotva kurzora (ako v menu a v "Skúške kreslenia"): poloha = kotva + náklon. Pri okraji sa kotva posúva s kurzorom, aby sa nenahromadil náklon
  // a kurzor sa dal vždy odtiahnuť od steny; po vynulovaní náklonu v kontroléri (rozpoznaná otočená ruka) ostane kurzor na mieste.
  const gloveRef = useRef<GloveCursor | null>(null);
  const calibProgRef = useRef(0);
  const [calibProg, setCalibProg] = useState(0);
  const handRolledRef = useRef<boolean>(false);
  const [isGripping, setIsGripping] = useState<boolean>(false); // State pre IMU grip - použité v kontrole výhry
  const startTimeRef = useRef<number>(Date.now());
  const levelStartRef = useRef<number>(Date.now());
  const levelSecondsRef = useRef<number | null>(null); // trvanie levelu v okamihu dokončenia (bez prestávky "Oddýchnite si")
  const [levelDurations, setLevelDurations] = useState<number[]>([]);
  const [longestLevelIndex, setLongestLevelIndex] = useState<number | null>(null);
  const [longestLevelTime, setLongestLevelTime] = useState<number | null>(null);
  const initialPlacedCountRef = useRef<number>(0);
  const levelUserPlacedRef = useRef<Set<string>>(new Set());

  const levels: PentominoLevel[] = (levelsData as PentominoLevel[]).slice(0, maxLevels);
  const currentLevel = levels[currentLevelIndex];

  // Záznam dát z rukavice počas hry (len so súhlasom prihláseného používateľa; pozri utils/sessionRecorder.ts)
  const { user: authUser, recordConsent } = useAuth();
  const recRef = useRef<SessionRecorder | null>(null);
  const recUserId = authUser?.id;
  useEffect(() => {
    if (!recUserId || !recordConsent) return;
    const rec = new SessionRecorder(recUserId, 'pentomino', {
      hand: dualHands ? 'both' : useLeftHand ? 'left' : 'right', cursorModel: currentCursorModel(),
    });
    recRef.current = rec;
    return () => { recRef.current = null; void rec.stop(); };
  }, [recUserId, recordConsent, dualHands, useLeftHand]);
  useEffect(() => {
    recRef.current?.event({ type: 'level', index: currentLevelIndex });
  }, [currentLevelIndex, recUserId, recordConsent]);

  // Fixná veľkosť gridu (ako GameBoard)
  const GRID_WIDTH = 20;
  const GRID_HEIGHT = 20;

  // (useConfig konfiguráciu vždy má – bez nej vyhodí chybu –, preto tu nie je predčasný return pred hookmi nižšie)

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

    // Všetky bloky levelu ležia od začiatku na poli (zásobník blokov mimo poľa hra nemá). Blok so štartovacou pozíciou
    // z levelu ide na ňu; blok bez pozície, s pozíciou mimo poľa alebo cez iný blok dostane voľné miesto mimo cieľového tvaru
    // (predtým sa taký blok potichu zahodil a level sa nedal dokončiť).
    const initialPlacedPieces: PlacedPiece[] = [];
    const place = (shape: PentominoShape, row: number, col: number) => {
      newGrid = placePiece(newGrid, shape.grid, row, col, shape.color);
      initialPlacedPieces.push({ shapeId: shape.id, grid: shape.grid, row, col, color: shape.color, uid: genUid() });
    };
    const withoutPosition: PentominoShape[] = [];
    pieces.forEach((shape, index) => {
      const pos = currentLevel.startingPositions?.[index];
      if (pos && Number.isInteger(pos.row) && Number.isInteger(pos.col) && fitsOnGrid(newGrid, shape.grid, pos.row, pos.col)) {
        place(shape, pos.row, pos.col);
      } else {
        if (pos) console.warn(`Pentomino level ${currentLevel.id}: štartovacia pozícia bloku ${shape.id} (#${index}) je mimo poľa alebo cez iný blok, vyberám voľné miesto`);
        withoutPosition.push(shape);
      }
    });
    // až po blokoch s pevnou pozíciou, aby im automaticky umiestnený blok nezabral miesto
    withoutPosition.forEach((shape) => {
      const pos = findStartPosition(newGrid, shape.grid, currentLevel.targetShape);
      if (pos) place(shape, pos.row, pos.col);
      else console.error(`Pentomino level ${currentLevel.id}: pre blok ${shape.id} nie je na poli voľné miesto`);
    });

  setGrid(newGrid);
  setPlacedPieces(initialPlacedPieces);
  // Zapamätaj koľko kúskov bolo predumiestnených v tomto leveli (aby sme ich nepočítali ako používateľské uloženia)
  initialPlacedCountRef.current = initialPlacedPieces.length;
  // Vyčisti množinu používateľom uložených kúskov pri načítaní levelu
  levelUserPlacedRef.current.clear();
  // Vyčisti históriu pri načítaní nového levelu
  setHistoryStack([]);
  // Na začiatku nie je vybraný žiadny blok: hráč si ho vyberie sám kurzorom (stisk nad blokom); šípky na klávesnici vyberú prvý
  setActivePieceId(null);
  // Nový level / reštart: zahoď rozpracované gesto a nový stav hneď sprístupni gestám (refy sa inak synchronizujú až po prekreslení)
  gridRef.current = newGrid;
  placedPiecesRef.current = initialPlacedPieces;
  activePieceIdRef.current = null;
  manipRef.current?.reset();
  inputRef.current?.reset();
    
    setAvailablePieces([]); // všetky bloky sú na poli (pozri vyššie)
    wonKeyRef.current = null;
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
      if (!detail?.connected) inputRef.current?.cancel(); // odpojenie preruší rozpracované gesto
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
    if (!gloveRef.current) {
      // Vrstva pohybu ruky -> kurzor (utils/gloveCursor.ts). Pentomino-špecifické: pri uvoľnení ostane kurzor na bloku, vynulovanie
      // po stisku len kým sa blok nepohol/neotočil a 3 s stisk mimo blokov = nový nulový bod.
      gloveRef.current = new GloveCursor({
        heldCursor: () => manipRef.current?.heldCursor() ?? null,
        onHeldRelease: () => inputRef.current?.clearOffset(),
        canGripRecenter: () => !manipRef.current?.hasMoved() && !inputRef.current?.transformed,
        canCalibrate: () => {
          const input = inputRef.current, manip = manipRef.current;
          return !!input && !!manip && !input.moving && !manip.hasMoved() && !input.transformed && !draggingRef.current && playableRef.current;
        },
      });
    }
    imuCtrlRef.current = gloveRef.current.ctrl;
    if (dualHands) imuCtrlLRef.current = gloveRef.current.ensureLeft();
  };

  // Manipulátor bloku + gestá kurzora. Vytvoria sa raz; stav hry čítajú cez refy, zmeny hlásia cez commit/select/render.
  const ensureManip = () => {
    if (manipRef.current) return;
    const manip = new PieceManipulator({
      rows: () => GRID_HEIGHT,
      cols: () => GRID_WIDTH,
      pieces: () => placedPiecesRef.current,
      selected: () => activePieceIdRef.current,
      select: (uid) => { activePieceIdRef.current = uid; setActivePieceId(uid); },
      commit: (info) => commitPieceRef.current(info),
      render: (s) => {
        // Kurzor sa kreslí priamo do DOM (bez Reactu): predtým každý pohyb kurzora (60×/s) prekreslil celú hru = lag.
        // React sa prekreslí len keď sa zmení blok (poloha, uhol, náhľad dosadnutia) alebo zvýraznenie.
        drawCursor(s.cursor);
        if (!sameSnap(snapRef.current, s)) { snapRef.current = s; setSnap(s); }
        const grabbed = !!s.live?.grabbed;
        if (grabbed !== grabbedRef.current) { grabbedRef.current = grabbed; setIsGripping(grabbed); }
      },
      playing: () => playableRef.current,
      stepMove: PIECE_STEP_MOVE,
    });
    manipRef.current = manip;
    inputRef.current = new CursorGripInput(manip, cfg as any);
  };

  // Globálna IMU kalibrácia (po novej kalibrácii treba pred ďalším stiskom uvoľniť prsty)
  useEffect(() => {
    ensureCtrls();
    ensureManip();
    if (dualHands) {
      if (neutralQuats.right) imuCtrlRef.current?.calibrateNeutral(neutralQuats.right);
      if (neutralQuats.left) imuCtrlLRef.current?.calibrateNeutral(neutralQuats.left);
    } else if (imuCtrlRef.current && neutralQuat) {
      imuCtrlRef.current.calibrateNeutral(neutralQuat);
    }
    gloveRef.current?.reset();
    manipRef.current?.reset();
    inputRef.current?.reset();
  }, [neutralQuat, neutralQuats, dualHands, useLeftHand]);

  useEffect(() => () => manipRef.current?.dispose(), []);

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

  // Strata dát: po sekunde bez vzorky sa gesto preruší (blok sa pustí na mriežku), kurzor zmizne a treba uvoľniť prsty
  useEffect(() => {
    const id = window.setInterval(() => {
      const last = lastSampleAtRef.current;
      if (last && performance.now() - last > SAMPLE_TIMEOUT_MS) {
        lastSampleAtRef.current = 0;
        inputRef.current?.cancel();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Spracovanie IMU: počúvaj 'imu-sample' udalosti odoslané z WebSocketStatus
  useEffect(() => {
    ensureCtrls();
    ensureManip();

    // === DETEKCIA STISKU (z GameBoard.tsx) ===
    // Prsty jednej ruky (adc[1..5] = malíček->palec): kalibrované prahy z detail.fingers (WebSocketStatus), inak pôvodný pevný prah

    function onSample(ev: Event) {
      // Počas kalibrácie sa hra nehýbe a rozpracované gesto sa ruší
      if (wsConnected && !isCalibrated && showCalibrationModal) { inputRef.current?.cancel(); return; }
      const input = inputRef.current, manip = manipRef.current;
      if (!input || !manip) return;
      try {
        const detail = (ev as CustomEvent).detail;
        if (!detail) return;
        const sample = { imu: detail.imu || {}, adc: detail.adc || [], fingers: detail.fingers, ts: Date.now() } as any;

        // === REŽIM DVOCH RÚK ===
        // Ľavá ruka len aktualizuje svoj kontrolér; celá logika hry beží na vzorkách pravej ruky
        // a pracuje so zlúčenými hodnotami (obe ruky musia robiť pohyb spolu).
        let dualL: { sample: any; out: any; ts: number } | null = null;
        if (dualHands) {
          const h = detail.hand;
          if (h !== 'left' && h !== 'right') return;
          const tN = Date.now();
          if (h === 'left') {
            const glove = gloveRef.current;
            if (!glove || !imuCtrlLRef.current) return;
            const dtL = sampleDt(detail, tN - (dualRef.current.lastLeftTs || tN));
            dualRef.current.lastLeftTs = tN;
            dualRef.current.left = { sample, out: glove.feedLeft(sample, dtL), ts: tN }; // feedLeft: nastavenia a korekcia osí ľavej ruky
            return;
          }
          dualRef.current.rightTs = tN;
          dualL = dualRef.current.left;
          if (!dualL || tN - dualL.ts > 1000) return; // čakáme na obe zariadenia
        }

        const now = Date.now();
        const last = lastImuTsRef.current ?? now;
        const dt = sampleDt(detail, now - last); // hodiny streamera (utils/sampleClock.ts)
        lastImuTsRef.current = now;
        lastSampleAtRef.current = performance.now();

        // Dve ruky: grip platí len keď stláčajú všetkých 5 prstov OBE ruky
        // stisk ruky s hysterézou (fingerCalibration.handGrip): začne pri 5 prstoch, drží pri 4, krátko aj pri 3
        const grip = gripOf(sample, cfg) && (!dualL || gripOf(dualL.sample, cfg));

        // Ruka podľa zariadenia (stream posiela 'hand'), ako v menu a v kreslení; výber v menu len ako záloha
        const leftMain = !dualHands && (detail.hand === 'left' ? true : detail.hand === 'right' ? false : useLeftHand);
        // Pohyb ruky -> kurzor (utils/gloveCursor.ts): náklon, zmrazenie pri stisku/uvoľnení, vynulovanie, 3 s stisk mimo blokov = nový nulový bod
        const st = gloveRef.current!.step({ sample, hand: leftMain ? 'left' : 'right', hold: grip, dt, left: dualL });
        const outMain = st.out;
        if (st.rolled !== handRolledRef.current) { handRolledRef.current = st.rolled; setHandRolled(st.rolled); }
        const { position, gyro } = st;
        const rolledNow = st.rolled;
        if (Math.abs(st.calibProg - calibProgRef.current) > 0.04 || (st.calibProg === 0) !== (calibProgRef.current === 0)) {
          calibProgRef.current = st.calibProg; setCalibProg(st.calibProg);
        }
        if (st.calibrated) {
          input.reset(); // ďalší stisk až po uvoľnení prstov
          return;
        }

        // Klávesy R/E majú prednosť: počas ich držania sa vzorky z rukavice ignorujú
        if (!manip.isKeyRotating()) {
          // Pri ťahaní myšou, po výhre alebo v modale sa rukavica nepoužíva (rozpracované gesto sa zruší)
          const ready = !draggingRef.current && playableRef.current;
          if (input.update({ grip, position, gyro, dt }, performance.now(), ready)) {
            imuCtrlRef.current?.consumeGyroX(); // flip je vybavený: ďalší až po uvoľnení gyra
          }
        }

        recRef.current?.add(now, detail, { grip, active: input.moving, x: position.x, y: position.y, rolled: rolledNow });

        if (showImuDebugRef.current) {
          const nMain = normalizeImuSample(sample.imu, 1);
          setImuDebug({
            pitch: Math.round(nMain.pitchDeg * 10) / 10,
            roll: Math.round(nMain.rollDeg * 10) / 10,
            yaw: Math.round(nMain.yawDeg * 10) / 10,
            gyro: outMain.gyro,
            linAcc: { x: Math.round(nMain.linAccX * 10) / 10, y: Math.round(nMain.linAccY * 10) / 10 },
            adcMax: Math.max(0, ...((sample.adc || []) as number[]).slice(1, 5).map((v: number) => normalizeAdc(v))),
            grip,
            quat: sample.imu.quatW !== undefined ? {
              w: sample.imu.quatW ?? 0,  // Už normalizované backendom!
              x: sample.imu.quatX ?? 0,
              y: sample.imu.quatY ?? 0,
              z: sample.imu.quatZ ?? 0,
            } : undefined,
          });
        }
      } catch (err) {
        console.warn('Pentomino: chyba pri spracovaní vzorky', err);
      }
    }

    const wrappedSample = (ev: Event) => {
      if ((window as any).__modalOpen) { inputRef.current?.cancel(); return; }
      onSample(ev as any);
    };
    window.addEventListener('imu-sample', wrappedSample as EventListener);
    return () => window.removeEventListener('imu-sample', wrappedSample as EventListener);
  }, [wsConnected, isCalibrated, showCalibrationModal, useLeftHand, dualHands, cfg]);


  // Kontrola výhry
  // Level sa vyhodnotí až keď hráč PUSTÍ blok (nie počas držania). Výhra sa pre daný level zaznamená raz (wonKeyRef) a popup
  // "Oddýchnite si" má vlastný časovač závislý len od showRestPopup. Predtým časovač bežal v tomto effecte a zrušila ho každá
  // zmena poľa (Krok späť, chytenie bloku myšou počas popupu): popup potom ostal visieť a rukavica bola vypnutá.
  const levelKey = `${currentLevelIndex}:${reloadKey}`;
  useEffect(() => {
    if (!currentLevel || placedPieces.length === 0) return;
    if (wonKeyRef.current === levelKey) return;
    // Pole ešte patrí predchádzajúcemu levelu (nový level sa práve načítava)
    if (grid !== gridRef.current) return;
    // Nespúšťaj kontrolu výhry ak je aktívny grip (hráč ešte drží blok)
    if (grabbedRef.current) return;
    // Nespúšťaj kontrolu výhry ak sa ťahá blok myšou
    if (draggingPiece) return;
    if (showFinishedModal) return;

    if (isLevelComplete(grid, currentLevel.targetShape)) {
      wonKeyRef.current = levelKey;
      levelSecondsRef.current = Math.floor((Date.now() - levelStartRef.current) / 1000);
      setShowRestPopup(true);
    }
  }, [grid, currentLevel, placedPieces, isGripping, draggingPiece, levelKey, showFinishedModal]);

  // Po oddychu: zaznamenaj výsledok levelu a prejdi na ďalší (alebo ukáž štatistiky po poslednom)
  finishLevelRef.current = () => {
    setShowRestPopup(false);
    // Zaznamenaj trvanie tohto dokončeného levelu (po posledný ťah; prestávka COFFEE_BREAK sa nepočíta)
    const duration = levelSecondsRef.current ?? Math.floor((Date.now() - levelStartRef.current) / 1000);
    levelSecondsRef.current = null;
    addResult({ t: Date.now(), kind: 'pentomino', level: currentLevelIndex + 1, seconds: duration }); // pokrok používateľa
    setLevelDurations((prev) => {
      const newArr = [...prev, duration];
      // Ak toto bol posledný level, vypočítaj najdlhší
      if (currentLevelIndex >= levels.length - 1) {
        let max = -1;
        let idx = 0;
        newArr.forEach((d, i) => { if (d > max) { max = d; idx = i; } });
        setLongestLevelIndex(idx);
        setLongestLevelTime(max);
      }
      return newArr;
    });
    // Zaznamenaj koľko kúskov bolo uložených v tomto leveli (unikátne používateľské interakcie)
    setLevelPlacedCounts((prev) => {
      const newArr = [...prev, levelUserPlacedRef.current.size];
      setTotalPlacedCount(newArr.reduce((a, b) => a + b, 0));
      return newArr;
    });

    if (currentLevelIndex < levels.length - 1) {
      setCurrentLevelIndex((i) => i + 1);
    } else if (currentLevelIndex >= 1) {
      // Posledný level -> modal so štatistikami, ale len ak hráč dosiahol aspoň level 2 (index 1)
      setTimeTaken(Math.floor((Date.now() - startTimeRef.current) / 1000));
      setShowFinishedModal(true);
    } else {
      onBackToMenu();
    }
  };
  useEffect(() => {
    if (!showRestPopup) return;
    const timeout = setTimeout(() => finishLevelRef.current(), cfg?.COFFEE_BREAK ?? 1000);
    return () => clearTimeout(timeout);
  }, [showRestPopup]);

  const handleRestart = () => {
    // Znovu načítaj aktuálny level zvýšením reloadKey, čo spustí inicializačný effect (ten nastaví aj čas začiatku levelu;
    // na prvom leveli vynuluje celé štatistiky). Celkový čas a ťahy relácie sa tu nenulujú: predtým sa po reštarte napr. 5. levelu
    // celkový čas počítal len od reštartu, kým "Najdlhší level" obsahoval aj predchádzajúce levely.
    setReloadKey((k) => k + 1);
    setShowRestPopup(false);
    levelSecondsRef.current = null;
    setHistoryStack([]); // Vyčisti históriu pri reštarte
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
    if (historyStack.length === 0 || showRestPopup) return; // level je už dokončený
    
    const previousState = historyStack[historyStack.length - 1];
    setHistoryStack(prev => prev.slice(0, -1));
    
    setGrid(previousState.grid);
    setPlacedPieces(previousState.placedPieces);
    setAvailablePieces(previousState.availablePieces);
    setActivePieceId(previousState.activePieceId);
    gridRef.current = previousState.grid;
    placedPiecesRef.current = previousState.placedPieces;
    activePieceIdRef.current = previousState.activePieceId;
    manipRef.current?.reset();
    
    // Zníž počet ťahov
    setMovesCount(m => Math.max(0, m - 1));
  }, [historyStack, showRestPopup]);

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

        // blok si ponechá svoje uid (štatistika "Položené bloky" ho inak pri každom presune myšou rátala ako nový)
        const uid = draggingPiece.originalUid ?? genUid();
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

          const uid = draggingPiece.originalUid ?? genUid();
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
            // Umiestnenie MIMO targetShape sa nepočíta (dočasná pozícia); blok vytiahnutý z cieľa sa prestane počítať
            levelUserPlacedRef.current.delete(uid);
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

          const uid = draggingPiece.originalUid ?? genUid();
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

  // Rotácia bloku, ktorý práve ťaháš myšou (R). Bloky na mriežke otáča PieceManipulator (klávesy R/E, zápästie).
  const handleRotateDragging = () => {
    if (!draggingPiece) return;
    setDraggingPiece({ ...draggingPiece, grid: rotatePentomino(draggingPiece.grid) });
  };

  // Prevrátenie (F): blok ťahaný myšou sa prevráti hneď, vybraný blok na mriežke s animáciou
  const handleFlipDragging = () => {
    if (draggingPiece) {
      setDraggingPiece({ ...draggingPiece, grid: flipPentomino(draggingPiece.grid) });
    } else {
      manipRef.current?.flipSelected();
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
      
      // Plynulú rotáciu (R/E) rieši samostatný effect, ak nedržíme blok myšou
      if (!draggingPiece && (e.key.toLowerCase() === 'r' || e.key.toLowerCase() === 'e')) return;

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

  // === KLÁVESY R (doprava) / E (doľava): plynulé otáčanie vybraného bloku, rovnako ako zápästie ===
  const saveToHistoryRef = useRef(saveToHistory);
  useEffect(() => { saveToHistoryRef.current = saveToHistory; }, [saveToHistory]);

  // Potvrdenie bloku po pustení: zapíše novú orientáciu/polohu do mriežky (jediné miesto, kde ruka mení stav hry)
  commitPieceRef.current = (info) => {
    const piece = placedPiecesRef.current.find((p) => p.uid === info.uid);
    if (!piece) return;
    if (info.changed) {
      saveToHistoryRef.current(); // pre undo: stav spred zmeny
      setMovesCount((m) => m + 1);
    }
    const newGrid = placePiece(removePiece(gridRef.current, piece), info.grid, info.row, info.col, piece.color);
    const updated = placedPiecesRef.current.map((p) => (p.uid === info.uid ? { ...p, grid: info.grid, row: info.row, col: info.col } : p));
    // refy sa nastavia hneď: ďalšia vzorka (zachytenie) môže prísť ešte pred prekreslením
    gridRef.current = newGrid;
    placedPiecesRef.current = updated;
    setGrid(newGrid);
    setPlacedPieces(updated);
    // Do štatistiky sa blok započíta, keď celý leží v cieľovom tvare (ako pri položení myšou)
    const target = currentLevel?.targetShape;
    const inside = !!target && info.grid.every((row, r) => row.every((v, c) => !v || !!target[info.row + r]?.[info.col + c]));
    if (inside) levelUserPlacedRef.current.add(info.uid); else levelUserPlacedRef.current.delete(info.uid);
  };
  playableRef.current = !!currentLevel && !showRestPopup && !showFinishedModal;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k !== 'r' && k !== 'e') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if ((window as any).__modalOpen) return;
      if (wsConnected && !isCalibrated) return; // pripojená, ale nekalibrovaná rukavica: klávesy sú zamknuté
      if (draggingRef.current) return;          // blok ťahaný myšou rieši handleRotateDragging
      const input = inputRef.current, manip = manipRef.current;
      if (!input || !manip || input.gripping) return;
      if (!manip.keyDown(k)) return;
      e.preventDefault();
      input.cancel(); // po klávese treba pred ďalším stiskom rukavice uvoľniť prsty
    };
    const onKeyUp = (e: KeyboardEvent) => manipRef.current?.keyUp(e.key.toLowerCase());
    const onBlur = () => manipRef.current?.keyUp();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [wsConnected, isCalibrated]);

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
      {handRolled && (
        <div className="fixed bottom-3 left-3 z-[9000] px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-sm font-medium shadow">
          Rukavica otočená – použité osi pre otočenú polohu
        </div>
      )}
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
              className="relative rounded-2xl shadow-2xl p-3 transition-shadow duration-200"
              style={{
                backgroundColor: BOARD_FRAME,
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

              {/* Hracie pole: viditeľné bunky (predtým biele s takmer neviditeľnými čiarami), každá 5. čiara výraznejšia na orientáciu */}
              <div
                className="absolute inset-3 pointer-events-none"
                style={{
                  backgroundColor: BOARD_CELL,
                  backgroundImage: [
                    `linear-gradient(to right, ${BOARD_LINE_MAJOR} 2px, transparent 2px)`,
                    `linear-gradient(to bottom, ${BOARD_LINE_MAJOR} 2px, transparent 2px)`,
                    `linear-gradient(to right, ${BOARD_LINE} 1px, transparent 1px)`,
                    `linear-gradient(to bottom, ${BOARD_LINE} 1px, transparent 1px)`,
                  ].join(', '),
                  backgroundSize: `${CELL_SIZE * 5}px ${CELL_SIZE * 5}px, ${CELL_SIZE * 5}px ${CELL_SIZE * 5}px, ${CELL_SIZE}px ${CELL_SIZE}px, ${CELL_SIZE}px ${CELL_SIZE}px`,
                  borderRight: `1px solid ${BOARD_LINE}`,
                  borderBottom: `1px solid ${BOARD_LINE}`,
                }}
              />

              {/* Cieľový tvar (obrysy) */}
              {/* Len vonkajší obrys cieľa: čiara sa kreslí iba tam, kde susedná bunka nie je súčasťou cieľa */}
              {currentLevel.targetShape.map((row, r) =>
                row.map((cell, c) => {
                  if (!cell) return null;
                  const t = currentLevel.targetShape;
                  const edge = (rr: number, cc: number) => (t[rr]?.[cc] ? '0px' : '4px');
                  return (
                    <div
                      key={`target-${r}-${c}`}
                      className="absolute pointer-events-none"
                      style={{
                        left: 12 + c * CELL_SIZE,
                        top: 12 + r * CELL_SIZE,
                        width: CELL_SIZE,
                        height: CELL_SIZE,
                        boxSizing: 'border-box',
                        borderStyle: 'solid',
                        borderColor: '#000000',
                        backgroundColor: TARGET_FILL, // cieľová plocha je zreteľne odlíšená od zvyšku poľa
                        borderTopWidth: edge(r - 1, c),
                        borderBottomWidth: edge(r + 1, c),
                        borderLeftWidth: edge(r, c - 1),
                        borderRightWidth: edge(r, c + 1),
                      }}
                    />
                  );
                })
              )}

              {/* Náhľad dosadnutia držaného bloku: kam dosadne po uvoľnení prstov */}
              {snap.live?.ghost && (() => {
                const g = snap.live.ghost;
                const color = placedPieces.find((p) => p.uid === snap.live!.uid)?.color ?? '#64748b';
                return g.grid.map((row, r) =>
                  row.map((cell, c) =>
                    cell ? (
                      <div
                        key={`ghost-${r}-${c}`}
                        className="absolute rounded pointer-events-none"
                        style={{
                          left: 12 + (g.col + c) * CELL_SIZE + 3,
                          top: 12 + (g.row + r) * CELL_SIZE + 3,
                          width: CELL_SIZE - 6,
                          height: CELL_SIZE - 6,
                          border: `3px dashed ${color}`,
                          backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
                          opacity: 0.85,
                        }}
                      />
                    ) : null
                  )
                );
              })()}

              {/* Umiestnené kúsky */}
              {placedPieces.map((piece, index) => {
                // Blok, ktorý práve drží/otáča ruka alebo klávesy, sa kreslí z desatinnej polohy a uhla (bez skokov po bunkách)
                const live = snap.live && snap.live.uid === piece.uid ? snap.live : null;
                const pg = live ? live.grid : piece.grid;
                const pw = pg[0]?.length ?? 0;
                const ph = pg.length;
                const isActive = piece.uid === activePieceId;
                const isHover = !live && !isActive && piece.uid === snap.hoverUid;
                // Obrys celého bloku (nie jednotlivých buniek): štyri posunuté tiene
                const o = SELECTED_OUTLINE;
                const filters: string[] = [];
                if (isActive) filters.push(`drop-shadow(3px 0 0 ${o})`, `drop-shadow(-3px 0 0 ${o})`, `drop-shadow(0 3px 0 ${o})`, `drop-shadow(0 -3px 0 ${o})`, 'drop-shadow(0 0 10px rgba(255, 153, 0, 0.9))');
                if (isHover) filters.push('drop-shadow(0 0 5px rgba(23, 100, 125, 0.9))');
                if (live?.grabbed) filters.push('drop-shadow(0 8px 10px rgba(0, 0, 0, 0.35))');
                return (
                <div
                  key={`placed-${piece.uid ?? index}`}
                  className={`absolute ${isActive ? 'cursor-move' : 'cursor-pointer'}${isActive && !live ? ' piece-selected-pulse' : ''}`}
                  style={{
                    left: live ? 12 + (live.cx - pw / 2) * CELL_SIZE : 12 + piece.col * CELL_SIZE,
                    top: live ? 12 + (live.cy - ph / 2) * CELL_SIZE : 12 + piece.row * CELL_SIZE,
                    // Rozmery len počas ťahania/otáčania (transform-origin = stred bloku); inak by prázdne rohy boli klikateľné
                    ...(live
                      ? {
                          width: pw * CELL_SIZE,
                          height: ph * CELL_SIZE,
                          transformOrigin: '50% 50%',
                          transform: `rotate(${live.angle}deg) scaleX(${live.flipScale})`,
                          zIndex: 30,
                          pointerEvents: 'none' as const,
                        }
                      : {}),
                    filter: filters.length ? filters.join(' ') : undefined,
                  }}
                  onClick={() => {
                    // Kliknutím sa prepne na tento kúsok
                    setActivePieceId(piece.uid ?? null);
                  }}
                  onMouseDown={(e) => {
                    // Kliknutím sa vyberie kúsok, podržaním sa začne presúvanie
                    if (showRestPopup) return; // level je dokončený: bloky sa už nehýbu
                    if (piece.uid !== activePieceId) {
                      setActivePieceId(piece.uid ?? null);
                      return;
                    }

                    e.preventDefault();
                    inputRef.current?.cancel(); // myš preberá ovládanie od rukavice
                    manipRef.current?.reset();
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
                  {pg.map((row, r) =>
                    row.map((cell, c) =>
                      cell ? (
                        <div
                          key={`cell-${r}-${c}`}
                          className="absolute rounded"
                          style={{
                            left: c * CELL_SIZE + 3,
                            top: r * CELL_SIZE + 3,
                            width: CELL_SIZE - 6,
                            height: CELL_SIZE - 6,
                            backgroundColor: piece.color,
                          }}
                        >
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
                );
              })}

              {calibProg > 0 && (
                <div className="absolute left-1/2 top-2 -translate-x-1/2 z-[70] bg-white/90 rounded-lg shadow px-3 py-2 text-sm text-slate-700 pointer-events-none">
                  Kalibrácia polohy… držte prsty stisnuté bez pohybu 3 s (kurzor sa presunie do stredu)
                  <div className="h-2 mt-1 bg-slate-200 rounded-full overflow-hidden"><div className="h-full bg-orange-500" style={{ width: `${calibProg * 100}%` }} /></div>
                </div>
              )}

              {/* Kurzor rukavice: biely kruh s krížom, pri plnom stisku oranžový */}
              {/* poloha a farba sa nastavujú priamo v drawCursor (bez prekreslenia Reactu) */}
              <div
                ref={cursorElRef}
                aria-hidden
                className="pentomino-glove-cursor absolute pointer-events-none"
                style={{ left: 0, top: 0, zIndex: 60, display: 'none', willChange: 'transform' }}
              >
                <svg width="40" height="40" viewBox="-20 -20 40 40" style={{ overflow: 'visible' }}>
                  <circle r="11" fill="white" fillOpacity="0.7" strokeWidth="3" />
                  <path d="M -17 0 H 17 M 0 -17 V 17" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </div>
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

            {/* Inštrukcie pre ovládanie */}
            <div className="rounded-xl bg-blue-50 p-4">
                <h3 className="text-lg font-bold text-blue-900 mb-3 flex items-center gap-2">
                  Informácie
                </h3>
                <div className="space-y-2 text-md text-blue-700">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    <p><span className="font-semibold">Náklon ruky (prsty voľné) →</span> Pohyb kurzora</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                    <p><span className="font-semibold">Stisk 5 prstov nad blokom →</span> Chytiť a presúvať naklonením ruky</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                    <p><span className="font-semibold">Otočenie zápästia pri stisku →</span> Plynulé otočenie bloku</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                    <p><span className="font-semibold">Kývnutie zápästia pri stisku →</span> Prevrátenie bloku</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <p><span className="font-semibold">Uvoľnenie prstov →</span> Blok sa prichytí na mriežku</p>
                  </div>
                </div>
              </div>


            </div>{/* end scrollable top */}

            {/* Tlačidlá */}
            <div className="flex flex-col gap-3 mt-4">
              {/* Tlačidlo Krok späť */}
              <button
                onClick={handleUndo}
                disabled={historyStack.length === 0 || showRestPopup}
                className={`flex items-center justify-center gap-2 rounded-xl py-3 px-6 transition-colors w-full ${
                  historyStack.length === 0 || showRestPopup
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                }`}
              >
                <Undo2 className="w-5 h-5" />
                Krok späť
              </button>
              <button
                onClick={() => {
                  setShowRestPopup(false); // zruší aj časovač prechodu na ďalší level
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
