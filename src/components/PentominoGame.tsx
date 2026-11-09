import { useState, useEffect, useCallback, useRef } from 'react';
import SingleIMUController from '../utils/imuController';
import { applyAxisCorr } from '../utils/axisCalibration';
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
import { pressedCountOf } from '../utils/fingerCalibration';
import { fuseSigned, DUAL_LEFT_GYRO_SIGN } from '../utils/dualHands';
import { CursorGripInput } from '../utils/cursorInput';
import { PieceManipulator, type ManipSnapshot, type CommitInfo } from '../utils/pieceManip';

// Ovládanie rukavicou je kurzorové (port z Tangram): otvorená dlaň hýbe kurzorom, plný stisk > 200 ms zachytí blok pod
// kurzorom, otočenie zápästia (gyro Z) ho plynulo otáča, kývnutie zápästia ho prevráti, uvoľnenie prstov ho prichytí na mriežku.
// Gestá sú v utils/cursorInput.ts, správanie bloku (ťahanie, otáčanie, prevrat, prichytenie) v utils/pieceManip.ts.
// Pohyb ruky -> kurzor je rovnaký ako v "Skúške kreslenia" (ShapeTraceModal), kde vpravo/vľavo/hore/dole funguje dobre:
// lineárne (bez krivky odozvy), bez mŕtvej zóny, zosilnenie 1 v oboch osiach, bez One Euro filtra, vyhladenie kurzora 0,35.
// Predtým: zosilnenie 1,5 + krivka 0,5 + zvislá os ×1/1,5 + mŕtva zóna 0,05 – smery mali rozdielnu citlivosť a začiatok pohybu "lepil".
const HAND_POS_GAIN = 1;
// Vľavo/vpravo silnejšie: plátno kreslenia je široké (vodorovne w/2 px na jednotku, ~1,7× viac ako zvisle), hracie pole
// Pentomina je štvorcové (20×20), takže pri rovnakom zosilnení bol vodorovný pohyb ~1,7× slabší. Zápästie má navyše
// vodorovne menší rozsah. Hore/dole ostáva 1 (funguje dobre).
const HAND_X_GAIN = 1.7;
const HAND_Y_SCALE = 1;
const HAND_RESPONSE_CURVE = 0;
const HAND_TILT_DEADZONE = 0;
// Menej vyhladenia ako v kreslení (0,35 + posAlpha 0,28 dávalo ~50 ms oneskorenia); bloky idú po bunkách s hysteréziou,
// takže tremor sa na nich neprejaví.
const CURSOR_SMOOTH = 0.6;
const HAND_POS_ALPHA = 0.45;
const SHOW_GLOVE_CURSOR = true; // kurzor rukavice: stisk všetkých prstov nad blokom ho zachytí (pozri PieceManipulator.begin)
const GRIP_RECENTER_MS = 180; // po stisku prstov (ruka sa pri stisku hýbe) sa náklon vynuluje v aktuálnej polohe: tak sa rozpozná aj otočená ruka ("kosť") a korekcie osí platia okolo skutočného nuly
const CALIB_HOLD_MS = 3000;   // všetky prsty stisnuté bez pohybu a bez zachyteného bloku takto dlho = nový nulový bod ruky a kurzor do stredu (3 s, aby sa nezamenilo s bežným stiskom)
const CALIB_STILL = 0.12;     // 'bez pohybu': kurzor (rozsah -1..1) sa nesmie pohnúť o viac ako toľko, inak odmeriavanie začína odznova
const CALIB_SHOW_MS = 500;    // priebeh sa ukazuje až po tomto čase (krátky stisk mimo bloku ho neukáže)
// Stisk aj uvoľnenie prstov samo nakloní rukavicu (na záznamoch 3–7°, t. j. ~1–2 bunky). Pri stisku to pohltí vynulovanie
// po GRIP_RECENTER_MS; pri uvoľnení nie, preto kurzor po pustení bloku "uletel". Počas oboch prechodov kurzor stojí.
const GRIP_FREEZE_MS = GRIP_RECENTER_MS + 60; // od začiatku stisku do vynulovania (s rezervou, aby vynulovanie padlo ešte do zmrazenia)
const RELEASE_FREEZE_MS = 350;   // po uvoľnení: prsty sa otvárajú postupne (stisk končí už prvým uvoľneným prstom)
const RELEASE_LOOKBACK_MS = 80;  // poloha pred uvoľnením: naklonenie začína ešte pred tým, ako prst klesne pod prah
// Výpadok JEDNÉHO prsta (4 z 5) počas stisku sa za uvoľnenie považuje až po tomto čase. Pohyb zápästia mení napätie tenzometrov
// a jeden prst krátko klesne pod prah: blok sa potom pustil, kurzor zamrzol a po 200 ms sa chytil znova – presun išiel "po bunkách".
// Pustenie viacerých prstov naraz (≤ 3) platí hneď.
const GRIP_DROPOUT_MS = 250;
// Zámok osi kurzora (ako zámok osi bloku v pieceManip): pri zjavne vodorovnom/zvislom pohybe sa bočná zložka zahodí.
// Prečo: náklon ruky má bočnú zložku (natočenie senzora a oblúk zápästia nesedia u každého presne – na záznamoch 10–35 %).
// Bloky sa hýbu po bunkách, preto tu zámok ostáva (kreslenie ho nemá: kruh a šikmé čiary).
const AXIS_LOCK_MIN = 0.06;      // posun (rozsah -1..1, ~0,6 bunky) v hlavnej osi, od ktorého sa zámok zvažuje
const AXIS_LOCK_RATIO = 1.8;     // hlavná os ≥ 1,8× bočná (odklon do ~29°) = pohyb po osi
const AXIS_UNLOCK_RATIO = 0.8;   // bočná os ≥ 0,8× hlavnej (~39°) = zámerne šikmý pohyb, zámok sa uvoľní
const STROKE_STILL_SPEED = 0.15; // rýchlosť (rozsah/s), pod ktorou ruka "stojí"
const STROKE_END_MS = 150;       // po takejto pauze sa pohyb považuje za skončený a ďalší sa vyhodnocuje odznova
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
  const anchorRef = useRef({ x: 0, y: 0 });
  const gripStartRef = useRef(0);
  const gripRecenteredRef = useRef(false);
  const calibStartRef = useRef(0);
  const calibPosRef = useRef({ x: 0, y: 0 });
  const calibProgRef = useRef(0);
  const [calibProg, setCalibProg] = useState(0);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const prevGripRef = useRef(false);
  const gripLostAtRef = useRef(0);
  const strokeRef = useRef<{ prev: { x: number; y: number } | null; seq: number; sx: number; sy: number; lock: 'x' | 'y' | null; stillMs: number }>(
    { prev: null, seq: -1, sx: 0, sy: 0, lock: null, stillMs: 0 });
  const freezeRef = useRef<{ pos: { x: number; y: number } | null; until: number; release: boolean }>({ pos: null, until: 0, release: false });
  const posHistRef = useRef<{ t: number; x: number; y: number }[]>([]);
  const handRolledRef = useRef<boolean>(false);
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
  // Na začiatku nie je vybraný žiadny blok: hráč si ho vyberie sám kurzorom (stisk nad blokom); šípky na klávesnici vyberú prvý
  setActivePieceId(null);
  // Nový level / reštart: zahoď rozpracované gesto a nový stav hneď sprístupni gestám (refy sa inak synchronizujú až po prekreslení)
  gridRef.current = newGrid;
  placedPiecesRef.current = initialPlacedPieces;
  activePieceIdRef.current = null;
  manipRef.current?.reset();
  inputRef.current?.reset();
    
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
    if (!imuCtrlRef.current) {
      imuCtrlRef.current = new SingleIMUController();
      imuCtrlRef.current.gyroDivisor = 1; // streamer posiela gyro už v °/s
      // Rovnaké snímanie polohy ako v "Skúške kreslenia": izotropný lineárny náklon z uhla, bez zosilnenia pri stisku
      imuCtrlRef.current.linearTilt = true;
      imuCtrlRef.current.angleTilt = true;
      imuCtrlRef.current.precisionScale = 1; // stisk prstov nesmie meniť polohu kurzora pri rovnakom náklone
      imuCtrlRef.current.posGain = HAND_POS_GAIN;
      // ako v kreslení: bez One Euro filtra, lineárna odozva, bez mŕtvej zóny (kurzor ide presne za rukou)
      imuCtrlRef.current.oneEuro = false;
      imuCtrlRef.current.posAlpha = HAND_POS_ALPHA;
      imuCtrlRef.current.responseCurve = HAND_RESPONSE_CURVE;
      imuCtrlRef.current.cellHysteresis = 0.3;
      imuCtrlRef.current.tiltDeadzone = HAND_TILT_DEADZONE;
      // Rovnaké spracovanie otočenej polohy ako v "Skúške kreslenia": pevné vstavané osi bez priebežného učenia (cukalo kurzorom)
      // a pevné zosilnenie bez vyrovnávania dosahu podľa smeru.
      imuCtrlRef.current.autoReach = false;
      imuCtrlRef.current.autoReachTarget = 0.6;
      imuCtrlRef.current.autoAxes = false;
      imuCtrlRef.current.rolledTune = { up: 1.4, down: 1.7, shear: -0.2, right: 1, left: 1 }; // len otočená poloha; ladenie: localStorage 'rehapiano.drawRolled' (rovnaké ako v kreslení)
      try {
        const raw = localStorage.getItem('rehapiano.drawRolled');
        if (raw) imuCtrlRef.current.rolledTune = { ...imuCtrlRef.current.rolledTune, ...JSON.parse(raw) };
      } catch { /* ignore */ }
      imuCtrlRef.current.tiltMax = 4; // bez saturácie nakláňania a polohy: kurzor ide plynule až na okraj a nezasekne sa
      imuCtrlRef.current.posLimit = 4;
    }
    if (dualHands && !imuCtrlLRef.current) {
      imuCtrlLRef.current = new SingleIMUController();
      imuCtrlLRef.current.gyroDivisor = 1;
    }
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
      stepMove: true, // pôvodné ťahanie po bunkách (nie plynulé); otáčanie, prevrat a prichytenie ostávajú nové
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
    anchorRef.current = { x: 0, y: 0 };
    lastPosRef.current = { x: 0, y: 0 };
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
    const countPressed = (s: { adc?: number[]; fingers?: unknown }) => pressedCountOf(s, cfg);

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
        lastSampleAtRef.current = performance.now();

        // Dve ruky: grip platí len keď stláčajú všetkých 5 prstov OBE ruky
        const pressedMain = countPressed(sample);
        const pressedCount = dualL ? Math.min(pressedMain, countPressed(dualL.sample)) : pressedMain;
        let grip = pressedCount === 5;
        {
          const tG = performance.now();
          if (grip) gripLostAtRef.current = 0;
          else if (prevGripRef.current && pressedCount === 4) {
            if (!gripLostAtRef.current) gripLostAtRef.current = tG;
            if (tG - gripLostAtRef.current < GRIP_DROPOUT_MS) grip = true; // krátky výpadok jedného prsta: stisk trvá
          } else gripLostAtRef.current = 0;
        }

        // Ruka podľa zariadenia (stream posiela 'hand'), ako v menu a v kreslení; výber v menu len ako záloha
        const leftMain = !dualHands && (detail.hand === 'left' ? true : detail.hand === 'right' ? false : useLeftHand);
        applyAxisCorr(imuCtrlRef.current!, leftMain ? 'left' : 'right');
        // ako v kreslení: počas stisku sa nulový bod (a rozpoznanie otočenej ruky) nesmie meniť, inak vznikne neviditeľná stena
        imuCtrlRef.current!.freezePose = grip;
        const seqBefore = imuCtrlRef.current!.recenterSeq;
        const outMain = imuCtrlRef.current!.update(sample, dt);
        if (imuCtrlRef.current!.recenterSeq !== seqBefore) anchorRef.current = { ...lastPosRef.current };
        if (outMain.rolled !== handRolledRef.current) { handRolledRef.current = outMain.rolled; setHandRolled(outMain.rolled); }

        // Normalizácia gyroskopu (streamer posiela °/s). Dve ruky: gyro sa započíta len keď sa obe hýbu rovnakým smerom.
        const nMain = normalizeImuSample(sample.imu, 1);
        const nLeft = dualL ? normalizeImuSample(dualL.sample.imu, 1) : null;
        const gyro = {
          x: nLeft ? fuseSigned(nMain.gyroX_dps, nLeft.gyroX_dps, 1, DUAL_LEFT_GYRO_SIGN.x) : nMain.gyroX_dps,
          y: nLeft ? fuseSigned(nMain.gyroY_dps, nLeft.gyroY_dps, 1, DUAL_LEFT_GYRO_SIGN.y) : nMain.gyroY_dps,
          z: nLeft ? fuseSigned(nMain.gyroZ_dps, nLeft.gyroZ_dps, 1, DUAL_LEFT_GYRO_SIGN.z) : nMain.gyroZ_dps,
        };

        // Poloha kurzora -1..1 v súradniciach obrazovky. Zrkadlenie osí ako v menu a v "Skúške kreslenia":
        // ľavá ruka (x, -y), pravá (-x, y). Dve ruky: priemer polôh oboch rúk.
        const mainPos = !leftMain
          ? { x: -outMain.posNorm.x, y: outMain.posNorm.y }
          : { x: outMain.posNorm.x, y: -outMain.posNorm.y };
        const rawBoth = dualL
          ? { x: (mainPos.x + dualL.out.posNorm.x) / 2, y: (mainPos.y - dualL.out.posNorm.y) / 2 }
          : mainPos;
        const rawPos = { x: rawBoth.x * HAND_X_GAIN, y: rawBoth.y * HAND_Y_SCALE };
        const anchor = anchorRef.current;
        // Zámok osi kurzora (pozri AXIS_LOCK_*): bočná zložka pohybu sa pri pohybe po osi odpočíta cez kotvu.
        {
          const st = strokeRef.current;
          const seq = imuCtrlRef.current!.recenterSeq;
          const frozenNow = !!freezeRef.current.pos || grip !== prevGripRef.current;
          if (!st.prev || st.seq !== seq || frozenNow) {
            // po vynulovaní náklonu (skok surovej polohy) a počas zmrazenia sa nemeria; nový pohyb od nuly
            st.sx = 0; st.sy = 0; st.lock = null; st.stillMs = 0;
          } else {
            const dx = rawPos.x - st.prev.x, dy = rawPos.y - st.prev.y;
            if (Math.hypot(dx, dy) / dt < STROKE_STILL_SPEED) {
              st.stillMs += dt * 1000;
              if (st.stillMs > STROKE_END_MS) { st.sx = 0; st.sy = 0; st.lock = null; }
            } else st.stillMs = 0;
            st.sx += dx; st.sy += dy;
            const ax = Math.abs(st.sx), ay = Math.abs(st.sy);
            if (st.lock === 'x' && ay > AXIS_UNLOCK_RATIO * ax) st.lock = null;
            else if (st.lock === 'y' && ax > AXIS_UNLOCK_RATIO * ay) st.lock = null;
            if (!st.lock) {
              if (ax >= AXIS_LOCK_MIN && ax > AXIS_LOCK_RATIO * ay) st.lock = 'x';
              else if (ay >= AXIS_LOCK_MIN && ay > AXIS_LOCK_RATIO * ax) st.lock = 'y';
            }
            if (st.lock === 'x') anchor.y -= dy;
            else if (st.lock === 'y') anchor.x -= dx;
          }
          st.prev = { ...rawPos }; st.seq = seq;
        }
        // Zmrazenie kurzora pri prechode stisk <-> uvoľnenie (pozri GRIP_FREEZE_MS / RELEASE_FREEZE_MS): kotva sa dorovná tak,
        // aby poloha ostala stáť; po skončení kurzor pokračuje plynulo od tohto miesta.
        const tPos = performance.now();
        const fr = freezeRef.current;
        if (grip !== prevGripRef.current) {
          if (grip) {
            fr.pos = { ...lastPosRef.current };
            fr.until = tPos + GRIP_FREEZE_MS;
            fr.release = false;
          } else {
            // Počas držania je kurzor prilepený k bloku (blok ide po bunkách, so zámkom osi a zastaví sa o stenu/blok), takže
            // jeho poloha sa líši od polohy ruky. Po pustení ostane tam, kde ho hráč videl, nie na polohe ruky.
            // Posun z otáčania (input.offset) sa tu zapracuje do kotvy a v inpute zahodí: inak ostal natrvalo, kurzor sa pri
            // ďalšom pohybe zasekol o okraj skôr (alebo neskôr) a po pustení na okamih odletel k polohe ruky.
            const held = manip.heldCursor();
            let back: { x: number; y: number };
            if (held) {
              back = { x: held.x, y: held.y };
              input.clearOffset();
            } else {
              const hist = posHistRef.current;
              back = hist[hist.length - 1] ?? { ...lastPosRef.current };
              for (let i = hist.length - 1; i >= 0 && hist[i].t >= tPos - RELEASE_LOOKBACK_MS; i--) back = hist[i];
            }
            fr.pos = { x: back.x, y: back.y };
            fr.until = tPos + RELEASE_FREEZE_MS;
            fr.release = true;
            lastPosRef.current = { ...fr.pos }; // bez dobehu vyhladenia: kurzor ostane presne tam, kde bol pri bloku
          }
          prevGripRef.current = grip;
        }
        let recenterAfterRelease = false;
        if (fr.pos && (tPos < fr.until || fr.release)) {
          anchor.x = fr.pos.x - rawPos.x; anchor.y = fr.pos.y - rawPos.y;
          // Koniec zmrazenia po uvoľnení: nulový bod sa vynuluje aj v polohe OTVORENEJ ruky (pri stisku sa vynuluje v polohe stisku).
          // Inak by mŕtva zóna a jemná krivka odozvy ostali okolo polohy stisku a otvorená ruka by bola mimo stredu,
          // takže jeden smer by začínal prechodom cez mŕtvu zónu.
          if (tPos >= fr.until) { recenterAfterRelease = true; fr.pos = null; fr.release = false; }
        } else fr.pos = null;
        const tgtX = anchor.x + rawPos.x, tgtY = anchor.y + rawPos.y;
        const clamped = { x: Math.max(-1, Math.min(1, tgtX)), y: Math.max(-1, Math.min(1, tgtY)) };
        anchor.x += clamped.x - tgtX; anchor.y += clamped.y - tgtY;
        // vyhladenie kurzora ako v kreslení (CURSOR_SMOOTH)
        const prevPos = lastPosRef.current;
        const position = {
          x: prevPos.x + CURSOR_SMOOTH * (clamped.x - prevPos.x),
          y: prevPos.y + CURSOR_SMOOTH * (clamped.y - prevPos.y),
        };
        lastPosRef.current = position;
        const hist = posHistRef.current;
        hist.push({ t: tPos, x: position.x, y: position.y });
        while (hist.length && hist[0].t < tPos - 300) hist.shift();
        // Otočená ruka ("kosť"): ako v kreslení sa nula nevynuluje ani pri stisku, ani po uvoľnení. Korekcie osí (zosilnenia
        // hore/dole, skos, oblúk vpravo) sú navrhnuté okolo neutrálnej polohy zápästia; po vynulovaní inde by sa smery správali inak.
        // Kurzor ostáva spojitý cez kotvu.
        const rolledNow = !!outMain.rolled;
        if (recenterAfterRelease && !rolledNow) {
          imuCtrlRef.current?.recenter(sample.imu);
          if (dualL) imuCtrlLRef.current?.recenter(dualL.sample.imu);
          anchorRef.current = { ...position };
        }

        // Vynulovanie náklonu pri každom stisku (ako v menu a v kreslení): nula sa berie v pozícii ruky pri zachytení, nie v kalibračnej.
        // Poloha kurzora ostáva spojitá (kotva = posledná poloha), blok sa preto neskočí.
        if (grip) {
          const tNow = performance.now();
          if (!gripStartRef.current) gripStartRef.current = tNow;
          if (!gripRecenteredRef.current && tNow - gripStartRef.current >= GRIP_RECENTER_MS && !manip.hasMoved() && !input.transformed) {
            gripRecenteredRef.current = true;
            if (!rolledNow) {
              imuCtrlRef.current?.recenter(sample.imu);
              if (dualL) imuCtrlLRef.current?.recenter(dualL.sample.imu);
              anchorRef.current = { ...lastPosRef.current };
            }
          }
        } else {
          gripStartRef.current = 0;
          gripRecenteredRef.current = false;
        }

        // Kalibrácia polohy: všetky prsty stisnuté ~1 s bez pohybu, keď NIE JE zachytený žiadny blok (stisk mimo blokov).
        // Držanie bloku sa nikdy nepovažuje za kalibráciu (ani keď sa blok ešte nepohol). Kurzor ostane na mieste, mení sa len nulový bod ruky.
        if (grip && !input.moving && !manip.hasMoved() && !input.transformed && !draggingRef.current && playableRef.current) {
          const cp = calibPosRef.current;
          if (!calibStartRef.current || Math.hypot(position.x - cp.x, position.y - cp.y) > CALIB_STILL) {
            calibStartRef.current = performance.now();
            calibPosRef.current = { ...position };
          }
          const held = performance.now() - calibStartRef.current;
          const prog = held > CALIB_SHOW_MS ? Math.min(1, held / CALIB_HOLD_MS) : 0;
          if (Math.abs(prog - calibProgRef.current) > 0.04 || (prog === 0) !== (calibProgRef.current === 0)) {
            calibProgRef.current = prog; setCalibProg(prog);
          }
          if (held >= CALIB_HOLD_MS) {
            imuCtrlRef.current?.recenter(sample.imu);
            if (dualL) imuCtrlLRef.current?.recenter(dualL.sample.imu);
            // nový nulový bod v tejto polohe ruky a kurzor do stredu; zmrazenie pri uvoľnení ho tam udrží
            anchorRef.current = { x: 0, y: 0 };
            lastPosRef.current = { x: 0, y: 0 };
            posHistRef.current = [];
            calibStartRef.current = 0; calibProgRef.current = 0; setCalibProg(0);
            input.reset(); // ďalší stisk až po uvoľnení prstov
            return;
          }
        } else if (calibStartRef.current || calibProgRef.current) {
          calibStartRef.current = 0; calibProgRef.current = 0; setCalibProg(0);
        }

        // Klávesy R/E majú prednosť: počas ich držania sa vzorky z rukavice ignorujú
        if (!manip.isKeyRotating()) {
          // Pri ťahaní myšou, po výhre alebo v modale sa rukavica nepoužíva (rozpracované gesto sa zruší)
          const ready = !draggingRef.current && playableRef.current;
          if (input.update({ grip, position, gyro }, performance.now(), ready)) {
            imuCtrlRef.current?.consumeGyroX(); // flip je vybavený: ďalší až po uvoľnení gyra
          }
        }

        if (showImuDebugRef.current) {
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
  // Level sa vyhodnotí až keď hráč PUSTÍ blok (nie počas držania)
  useEffect(() => {
    if (!currentLevel || placedPieces.length === 0) return;
    
    // Nespúšťaj kontrolu výhry ak je aktívny grip (hráč ešte drží blok)
    if (grabbedRef.current) return;
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
    gridRef.current = previousState.grid;
    placedPiecesRef.current = previousState.placedPieces;
    activePieceIdRef.current = previousState.activePieceId;
    manipRef.current?.reset();
    
    // Zníž počet ťahov
    setMovesCount(m => Math.max(0, m - 1));
  }, [historyStack]);

  const handlePieceMouseDown = (
    e: React.MouseEvent,
    shape: PentominoShape,
    pieceGrid: boolean[][]
  ) => {
    e.preventDefault();
    inputRef.current?.cancel(); // myš preberá ovládanie od rukavice
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
