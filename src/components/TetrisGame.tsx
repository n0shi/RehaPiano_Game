import { useEffect, useRef, useState } from 'react';
import { Tetris } from './tetris/game/Tetris';
import { InputMapper, BTN_LEFT, BTN_RIGHT, BTN_UP, BTN_DOWN, BTN_ROTATE, BTN_DROP } from './tetris/imu/InputMapper';
import SingleIMUController from '../utils/imuController';
import { Piece } from './tetris/game/Piece';
import { COLS, ROWS, CELL_SIZE, PIECE_COLORS, TETROMINOES } from './tetris/game/constants';
// FingerCalibration tu nie je potrebná — prahy tensometra pochádzajú len z konfigurácie
import { SettingsMenu } from './tetris/SettingsMenu';
import { useConfig } from '../config/ConfigContext';
import { useCalibration } from '../context/CalibrationContext';
import { CalibrationModal } from './CalibrationModal';
import { ModalBackdrop } from './ModalBackdrop';
import { Blocks } from 'lucide-react';
import { normalizeAdc, normalizeImuSample } from '../utils/imuNormalize';
import type { FingerState } from '../utils/fingerCalibration';

// Komponent modálneho okna pre koniec hry
interface TetrisFinishedModalProps {
  score: number;
  placedCount: number;
  timeTaken: number;
  title?: string;
  onBackToMenu: () => void;
  onRestart: () => void;
}

const TetrisFinishedModal: React.FC<TetrisFinishedModalProps> = ({
  score,
  placedCount,
  timeTaken,
  title = 'Výborne!',
  onBackToMenu,
  onRestart,
}) => {
  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40 backdrop-blur-lg"
      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl p-12 transform transition-all scale-100 animate-fadeinup"
        style={{ maxWidth: '800px', borderRadius: '24px', overflow: 'hidden' }}
      >
        <div className="flex flex-col items-center text-center">
          <Blocks className="w-12 h-12 text-green-600 mb-4" />
          <h2 className="text-4xl font-extrabold mb-3">
            {title}
          </h2>
          <p className="text-xl text-slate-700 mb-8">
            Hra bola ukončená. Tu sú Vaše výsledky
          </p>

          <div className="w-full grid grid-cols-3 gap-4 mb-10 text-center">
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">Celkový čas</p>
              <p className="text-3xl font-bold text-green-800 py-1">
                {formatTime(timeTaken)}
              </p>
            </div>
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">Skóre</p>
              <p className="text-3xl font-bold text-green-800 py-1">{score}</p>
            </div>
            <div className="bg-green-50 rounded-xl p-4">
              <p className="text-sm font-medium text-green-600">
                Položených blokov
              </p>
              <p className="text-3xl font-bold text-green-800 py-1">
                {placedCount}
              </p>
            </div>
          </div>

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

interface TetrisGameProps {
  onBackToMenu: () => void;
  level: number;
  useLeftHand: boolean;
}

export function TetrisGame({ onBackToMenu, level, useLeftHand }: TetrisGameProps) {
  const cfg = useConfig();
  const [score, setScore] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const showSettingsRef = useRef(false);
  const [showHandModal, setShowHandModal] = useState(false);
  const [modalTitle, setModalTitle] = useState('Dobrá práca!');
  const [timeTaken, setTimeTaken] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const [placedCorrectCount, setPlacedCorrectCount] = useState(0);
  const [inputMapperInstance, setInputMapperInstance] = useState<InputMapper | null>(null);
  const [gravitySpeed, setGravitySpeed] = useState(1);
  const [ghostEnabled, setGhostEnabled] = useState(true);
  const ghostEnabledRef = useRef(true);
  const [scale, setScale] = useState(1);
  const [, forceUpdate] = useState({});
  // Stav animácie tvrdého pádu
  const [hardDropAnim, setHardDropAnim] = useState<null | {
    blocks: [number, number][];
    delta: number;
    color: string;
    duration: number;
    animate: boolean;
  }>(null);
  const hardDropAnimatingRef = useRef(false);
  // Stav animácie pri čistení riadku
  const [rowClearAnim, setRowClearAnim] = useState<null | {
    rows: number[];
    rowsData: (string | null)[][];
    duration: number;
    animate: boolean;
  }>(null);
  const rowClearAnimatingRef = useRef(false);

  // === STAV KALIBRÁCIE (z globálneho kontextu) ===
  const { isCalibrated, neutralQuat, requestCalibration } = useCalibration();
  const [imuDebug, setImuDebug] = useState<any>({});
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  // === VIZUÁLNA INDIKÁCIA STISKU (GRIP) ===
  const [isGripping, setIsGripping] = useState<boolean>(false);

  // === POHYB OVLÁDANÝ STISKNUTÍM (kopírované z PentominoGame) ===
  const imuCtrlRef = useRef<SingleIMUController | null>(null);
  const lastImuTsRef = useRef<number | null>(null);
  const gripStartGridXRef = useRef<number | null>(null); // Pozícia ruky na začiatku gripu (X)
  const gripStartGridYRef = useRef<number | null>(null); // Pozícia ruky na začiatku gripu (Y)
  const gripStartPieceXRef = useRef<number | null>(null); // Pozícia bloku na začiatku gripu (X)
  const gripStartPieceYRef = useRef<number | null>(null); // Pozícia bloku na začiatku gripu (Y)
  const wasGrippingForMoveRef = useRef<boolean>(false); // Predchádzajúci stav gripu pre pohyb
  const lastGyroRotateTimeRef = useRef<number>(0); // Čas poslednej gyro rotácie
  const gyroZWasReleasedRef = useRef<boolean>(true); // Hysterézia pre gyroZ
  const lastGestureTimeRef = useRef<number>(0);
  const isRotatingRef = useRef<boolean>(false);
  const flipDirectionRef = useRef<number>(0);
  const wasThumbPressedRef = useRef<boolean>(false);
  // === TAP/HOLD DETECTION (pre double-tap hard drop) ===
  const gripStartTimeRef = useRef<number>(0); // Čas začiatku gripu
  const lastTapTimeRef = useRef<number>(0); // Čas posledného tapu
  const tapCountRef = useRef<number>(0); // Počet tapnutí v aktívnom okne
  const tapTimeoutRef = useRef<number | null>(null); // ID timeoutu pre reset tap okna
  const wasGrippingRef = useRef<boolean>(false); // Predchádzajúci stav gripu (pre edge detection)
  const movementStartedRef = useRef<boolean>(false); // Či už začal pohyb (HOLD)
  const rotationBlockedUntilRef = useRef<number>(0); // timestamp until which hard-drop is blocked after rotation
  const ROTATION_HARDDROP_BLOCK_MS = 600; // ms block after rotation to avoid accidental hard-drops

  useEffect(() => {
    return () => {
      if (tapTimeoutRef.current) {
        window.clearTimeout(tapTimeoutRef.current);
        tapTimeoutRef.current = null;
      }
    };
  }, []);

  // Použiť farby z configuration.json
  const TETRIS_COLORS = cfg?.OUTLINE_COLORS || [
    '#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'
  ];

  // Pomocník pre animovaný tvrdý pád
  const triggerAnimatedHardDrop = (gParam?: any) => {
    const g = gParam ?? gameRef.current;
    if (!g || !g.tetris || !g.tetris.active) return;
    if (hardDropAnim) return; // už sa animuje

    const active = g.tetris.active;
    const ghostY = g.tetris.getGhostY();

    // Náhradné riešenie: okamžitý pád ak neexistuje ghost
    if (ghostY === null) {
      g.tetris.hardDrop();
      if (!g.tetris.active) g.onGameOver(true);
      g.waitForFingerRelease = true;
      g.blockEquipped = (level === 2);
      return;
    }

    const delta = ghostY - active.y;
    if (delta <= 0) {
      // nič sa nedeje
      g.tetris.hardDrop();
      if (!g.tetris.active) g.onGameOver(true);
      g.waitForFingerRelease = true;
      g.blockEquipped = (level === 2);
      return;
      return;
    }

    const blocks = active.blocks.map(([x, y]: [number, number]) => [x, y] as [number, number]);
    const color = g.tetris.activeColor || TETRIS_COLORS[0];

    // dĺžka sa škáluje so vzdialenosťou, ale je ohraničená (rýchlejšie)
    const duration = Math.min(300, 60 + delta * 20);

    setHardDropAnim({ blocks, delta, color, duration, animate: false });
    hardDropAnimatingRef.current = true;

    // spustiť animáciu v nasledujúcom frame
    requestAnimationFrame(() => {
      setHardDropAnim((prev) => (prev ? { ...prev, animate: true } : prev));
    });

    // ukončiť po animácii
    setTimeout(() => {
      // vykonať skutočný tvrdý pád v hernej logike
      try {
        g.tetris.hardDrop();
      } catch (e) {}
      if (!g.tetris.active) g.onGameOver(true);
      g.waitForFingerRelease = true;
      g.blockEquipped = (level === 2);
      setHardDropAnim(null);
      hardDropAnimatingRef.current = false;
      // vynútiť aktualizáciu aby UI odrážalo nový stav enginu
      forceUpdate({});
    }, duration);
  };

  // Počúvaj zmeny stavu WebSocket pripojenia
  useEffect(() => {
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

  // Požiadaj o kalibráciu pri mount-e, ak nie je kalibrované a WS je pripojený
  useEffect(() => {
    if (wsConnected && !isCalibrated) {
      requestCalibration();
    }
  }, [wsConnected, isCalibrated, requestCalibration]);

  // Použiť neutrálny quaternion z globálnej kalibrácie do IMU kontroléra
  useEffect(() => {
    if (imuCtrlRef.current && neutralQuat) {
      imuCtrlRef.current.calibrateNeutral(neutralQuat);
    }
  }, [neutralQuat]);

  // Stav načítavania
  const gameRef = useRef<{
    tetris: Tetris;
    inputMapper: InputMapper;
    lastGravity: number;
    intervalId: number;
    lastImuTime: number;
    waitForFingerRelease: boolean;
    blockEquipped: boolean;      // Či je blok "equipnutý" (môžeš s ním hýbať)
    wasGripping: boolean;        // Či boli prsty stlačené v predchádzajúcom frame
    onGameOver: (isLoss: boolean) => void;
    isGameOver: boolean;
  } | null>(null);

  useEffect(() => {

    // Inicializovať hru
    const tetris = new Tetris(TETRIS_COLORS);
    tetris.spawn();

    // Použiť nakonfigurovaný prah tensometra pre detekciu prstov cez ADC (kalibrácia ovplyvňuje len IMU quaternion)
    const fingerThresholds = Array(5).fill((cfg as any)?.TENSOMETER_RAW_THRESHOLD ?? 2000);

    const inputMapper = new InputMapper({
      posEnable: true,
      posEma: 0.1,
      posDeadzoneA: 0.01,
      posLeak: 0.2,
      posSatAcc: 8.0,
      posSatVel: 2.5,
      posScaleX: 0.9,
      posScaleY: 0.9,
      posHyst: 0.7,
      gyroRotate: true,
      gyroThreshold: 18.0,
      gyroCooldown: 0.5,
      gyroAlpha: 0.22,
      dropEnable: true,
      dropSoft: -30,
      dropHard: -58,
      dropArm: 15,
      dropAlpha: 0.18,
    });

    gameRef.current = {
      tetris,
      inputMapper,
      lastGravity: Date.now() / 1000,
      intervalId: 0,
      lastImuTime: 0,
      waitForFingerRelease: false,
      blockEquipped: true,   // Prvý blok je equipnutý
      wasGripping: false,
      isGameOver: false,
      onGameOver: (isLoss: boolean) => {
        const g = gameRef.current;
        if (!g) return;
        
        // Zabrániť viacerým volaniam
        if (g.isGameOver) return;
        g.isGameOver = true;
        
        // Ak prehra, zobraziť modal bez ohľadu na počet
        if (isLoss) {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setTimeTaken(elapsed);
          setPlacedCorrectCount(g.tetris.placedCount);
          setModalTitle('Koniec hry');
          setShowHandModal(true);
          return;
        }

        // Ak neboli umiestnené žiadne kúsky, vrátiť sa do menu
        if (g.tetris.placedCount === 0) {
          onBackToMenu();
          return;
        }
        
        // Vypočítať čas a zobraziť modal
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setTimeTaken(elapsed);
        setPlacedCorrectCount(g.tetris.placedCount);
        setModalTitle('Dobrá práca!');
        setShowHandModal(true);
      }
    };
    setInputMapperInstance(inputMapper);

    // Spracovanie vstupu
    const handleKeyDown = (e: KeyboardEvent) => {
      const g = gameRef.current;
      if (!g) return;
      // Ak je otvorený akýkoľvek modal, zablokovať herný vstup
      if ((window as any).__modalOpen) return;
      // Ak prebieha kalibrácia a WS je pripojený, zmraziť vstupy
      if (!isCalibrated && wsConnected) return;

      // F1 - prepnutie nastavení
      if (e.key === 'F1') {
        e.preventDefault();
        setShowSettings(prev => !prev);
        return;
      }

      // Ak sú otvorené nastavenia, BLOKOVAŤ všetky ostatné herné vstupy
      if (showSettingsRef.current) {
        return;
      }

      const key = e.key.toLowerCase();

      if (key === 'escape') {
        onBackToMenu();
        return;
      }

      // Ak prebieha animácia tvrdého pádu, zablokovať klávesy pre pohyb/rotáciu/umiestnenie
      if (hardDropAnimatingRef.current) {
        const blocked = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'z', 'x', 'r', ' '];
        if (blocked.includes(key)) {
          e.preventDefault();
          return;
        }
      }

      // ŠÍPKY DOĽAVA/DOPrAVA - vždy povolené
      if (e.key === 'ArrowLeft') g.tetris.move(-1, 0);
      else if (e.key === 'ArrowRight') g.tetris.move(1, 0);
      // ŠÍPKY HORE/DOLE - len v Level 1
      else if (e.key === 'ArrowUp' && level === 1) g.tetris.move(0, -1);
      else if (e.key === 'ArrowDown' && level === 1) g.tetris.move(0, 1);
      // Rotácia - klávesy Z, X, R
      else if (key === 'z' || key === 'x' || key === 'r') {
        g.tetris.rotate();
        rotationBlockedUntilRef.current = Date.now() + ROTATION_HARDDROP_BLOCK_MS;
      }
      // Space - umiestniť kúsok
      else if (key === ' ') g.tetris.place();
      // H - tvrdý pád
      else if (key === 'h') {
        // krátke zablokovanie tvrdého pádu po rotácii
        if (Date.now() < rotationBlockedUntilRef.current) {
          console.log('[BLOCKED] Hard drop ignored due to recent rotation');
        } else {
          // animovať tvrdý pád
          triggerAnimatedHardDrop(g);
        }
      }
      // N - vytvoriť nový kúsok
      else if (key === 'n') {
        if(!g.tetris.spawn()) g.onGameOver(true);
      }
      // F2 - kalibrovať IMU space pointer
      else if (e.key === 'F2') {
        g.inputMapper.calibrateSpacePointer();
        console.log('[IMU] Kalibrácia dokončená');
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // IMU event listener - PRESNÁ KÓPIA z PentominoGame
    if (!imuCtrlRef.current) imuCtrlRef.current = new SingleIMUController();
    // Nastaviť veľkosť gridu pre Tetris (stĺpce)
    imuCtrlRef.current.gridSize = COLS;
    
    const handleImuSample = (e: Event) => {
      // Ak je otvorený modal, ignorovať IMU vzorky pre hernú logiku
      if ((window as any).__modalOpen) return;
      // Zmraziť IMU-riadenú logiku kým nie je dokončená kalibrácia (len ak je WS pripojené)
      if (!isCalibrated && wsConnected) return;
      const g = gameRef.current;
      if (!g) return;

      g.lastImuTime = Date.now();
      const now = Date.now();
      const last = lastImuTsRef.current ?? now;
      const dt = Math.max(1, now - last) / 1000;
      lastImuTsRef.current = now;

      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      
      const sample = { imu: detail.imu || {}, adc: detail.adc || [], ts: Date.now() } as any;
      const adc: number[] = Array.isArray(detail.adc) ? detail.adc : [];

      // === DETEKCIA STISKU (presne ako v PentominoGame) ===
      let fingersRaw = adc.slice(1, 6).map((v: any) => Number(v || 0));
      const fingers = useLeftHand ? fingersRaw : fingersRaw.slice().reverse();

      const defaultRawThr = (cfg as any)?.TENSOMETER_RAW_THRESHOLD ?? 2000;
      const defaultNormThr = (cfg as any)?.TENSOMETER_NORM_THRESHOLD ?? 12;

      let pressedCount = 0;
      const fs = detail.fingers as FingerState | undefined;
      if (fs?.calibrated) pressedCount = fs.count; // kalibrované prahy prstov človeka
      else for (let i = 0; i < fingers.length; i++) {
        const raw = Math.abs(fingers[i] ?? 0);
        const norm = normalizeAdc(raw);
        if (raw > defaultRawThr || norm > defaultNormThr) pressedCount++;
      }
      const manualGrip = pressedCount === 5;
      
      // Aktualizovať vizuálny stav gripu pre neon glow: zobrazovať len keď sú stlačené VŠETKY päť prstov
      setIsGripping(pressedCount === 5);

      // Posielať ADC do InputMapper (pre detekciu pádu)
      g.inputMapper.feedAdc(fingers);

      // Spracovanie IMU dát pre InputMapper (detekcia pádu)
      let imuData = detail.imu;
      if (imuData) {
        imuData = { ...imuData };
        if (imuData.pitch !== undefined) {
          imuData.pitch = -Number(imuData.pitch);
        }
        if (!useLeftHand && imuData.gyroZ !== undefined) {
          imuData.gyroZ = -Number(imuData.gyroZ);
        }
      }
      g.inputMapper.feedImu(imuData);

      // === Aktualizácia SingleIMUController (pre pozíciu na gride) ===
      const out = imuCtrlRef.current!.update(sample, dt);

      // Pozícia na gride z IMU (rovnako ako v PentominoGame)
      // Namapovať pozíciu na gride podľa vybratej ruky (1:1 s majo)
      const gridX = out.grid.x;
      const gridY = useLeftHand ? (ROWS - 1 - out.grid.y) : out.grid.y; // Y pozícia pre Level 1 (invert pre ľavú ruku)

      // Hodnoty gyroskopu
      const gyro = out.gyro || { x: 0, y: 0, z: 0 };
      const GYRO_ROTATION_THRESHOLD = 20; // °/s
      const GYRO_ROTATION_COOLDOWN_MS = 600; // ms

      // === DETEKCIA TAP vs HOLD (Double Tap pre tvrdý pád) ===
      const TAP_MAX_DURATION = 200; // ms - maximálne trvanie pre tap
      const DOUBLE_TAP_WINDOW = 1000; // ms - okno pre double tap (informational)

      // Detekcia hrany gripu
      if (manualGrip && !wasGrippingRef.current) {
        // Začiatok gripu
        gripStartTimeRef.current = now;
        wasGrippingRef.current = true;
        movementStartedRef.current = false;
      } else if (!manualGrip && wasGrippingRef.current) {
        // Koniec gripu
        wasGrippingRef.current = false;
        
        if (movementStartedRef.current) {
          // Bol to pohyb (HOLD) - reset
          movementStartedRef.current = false;
        } else {
          // Bol to TAP (krátky stisk bez pohybu)
          const duration = now - gripStartTimeRef.current;
          if (duration < TAP_MAX_DURATION) {
            // Použiť čítač + timeout na implementáciu 1s okna pre double-tap
            if (tapCountRef.current === 0) {
              tapCountRef.current = 1;
              if (tapTimeoutRef.current) window.clearTimeout(tapTimeoutRef.current);
              tapTimeoutRef.current = window.setTimeout(() => {
                tapCountRef.current = 0;
                tapTimeoutRef.current = null;
              }, 1000);
            } else if (tapCountRef.current === 1) {
              // DRUHÝ TAP v okne -> tvrdý pád ak je stabilizované (povoliť rýchly double-tap alebo malý pohyb)
              const STABLE_CELL_THRESHOLD = 1;
              const STABILIZE_MS = 300; // povoliť rýchly druhý tap do 300 ms
              const startGridX = gripStartGridXRef.current;
              const startGridY = gripStartGridYRef.current;
              const movedCells = (startGridX !== null && startGridY !== null) ? Math.abs(gridX - startGridX) + Math.abs(gridY - startGridY) : 0;
              const timeSinceFirst = now - gripStartTimeRef.current;
              const allowDoubleTap = (movedCells <= STABLE_CELL_THRESHOLD) || (timeSinceFirst <= STABILIZE_MS);
              if (allowDoubleTap && g.tetris.active && g.blockEquipped) {
                if (Date.now() < rotationBlockedUntilRef.current) {
                  console.log('[BLOCKED] Double-tap hard drop ignored due to recent rotation');
                } else {
                  triggerAnimatedHardDrop(g);
                  console.log('[DOUBLE TAP] Hard Drop!');
                }
              }
              tapCountRef.current = 0;
              if (tapTimeoutRef.current) {
                window.clearTimeout(tapTimeoutRef.current);
                tapTimeoutRef.current = null;
              }
            }
          }
        }
      }

      // Určiť či je to HOLD (grip trvá dlhšie ako TAP_MAX_DURATION)
      const isHold = manualGrip && (now - gripStartTimeRef.current > TAP_MAX_DURATION);

      // === POHYB A ROTÁCIA LEN PRI GRIPE (rovnako ako v PentominoGame) ===
      if (g.tetris.active && g.blockEquipped && isHold && !hardDropAnimatingRef.current && !isRotatingRef.current) {
        // Označiť, že začal pohyb
        if (!movementStartedRef.current) {
          movementStartedRef.current = true;
        }
        // === ROTÁCIA pri grip + gyroZ > prah ===
        if (!hardDropAnimatingRef.current && gyro.z > GYRO_ROTATION_THRESHOLD && out.gyroZWasReleased && now - lastGestureTimeRef.current >= GYRO_ROTATION_COOLDOWN_MS) {
          g.tetris.rotate();
          lastGestureTimeRef.current = now;
          imuCtrlRef.current?.consumeGyroZ();
          rotationBlockedUntilRef.current = now + ROTATION_HARDDROP_BLOCK_MS;
          // krátko zablokovať pohyb kým rotácia nedokončí
          isRotatingRef.current = true;
          setTimeout(() => { isRotatingRef.current = false; }, GYRO_ROTATION_COOLDOWN_MS);
        }

        // === POHYB pri grip (relatívny) ===
        if (!wasGrippingForMoveRef.current) {
          // Začiatok gripu - uložiť počiatočné pozície (použiť celočíselný anchor ako v Pentomino)
            gripStartGridXRef.current = gridX;
            gripStartGridYRef.current = gridY;
            // uložiť anchor kúsku (active.x/y) pre 1:1 mapovanie
            gripStartPieceXRef.current = g.tetris.active!.x;
            gripStartPieceYRef.current = g.tetris.active!.y;
            wasGrippingForMoveRef.current = true;
        } else {
          // Grip pokračuje - relatívny posun
          const startGridX = gripStartGridXRef.current;
          const startGridY = gripStartGridYRef.current;
          const startPieceX = gripStartPieceXRef.current;
          const startPieceY = gripStartPieceYRef.current;
          
            if (startGridX !== null && startPieceX !== null) {
            // Vypočítať celočíselný cieľ ukotvený na piece.x/y (1:1 s Pentomino)
            const deltaX = gridX - startGridX;
            const desiredX = Math.round(startPieceX + deltaX);

            let desiredY = startPieceY;
            if (level === 1 && startGridY !== null && startPieceY !== null) {
              const deltaY = gridY - startGridY;
              desiredY = Math.round(startPieceY + deltaY);
            }

            // Aktualizovať len ak sa pozícia zmenila
            const curX = g.tetris.active!.x;
            const curY = g.tetris.active!.y;
            if (desiredX !== curX || desiredY !== curY) {
              const candidate = new Piece(g.tetris.active!.kind);
              candidate.x = desiredX;
              candidate.y = desiredY ?? candidate.y;
              candidate.rot = g.tetris.active!.rot;
              if (!g.tetris.collides(candidate)) {
                g.tetris.active = candidate;
              }
            }
          }
        }
      }
      
      // Resetovať pohybové refy ak nie je HOLD
      if (!isHold && wasGrippingForMoveRef.current) {
        wasGrippingForMoveRef.current = false;
        gripStartGridXRef.current = null;
        gripStartGridYRef.current = null;
        gripStartPieceXRef.current = null;
        gripStartPieceYRef.current = null;
      }

      const imuN = normalizeImuSample(sample.imu);
      // Aktualizovať stav debug overlay (pre kalibráciu)
      setImuDebug({
        pitch: Math.round(imuN.pitchDeg * 10) / 10,
        roll: Math.round(imuN.rollDeg * 10) / 10,
        yaw: Math.round(imuN.yawDeg * 10) / 10,
        gyro: out.gyro,
        quat: sample.imu.quatW !== undefined ? {
          w: sample.imu.quatW ?? 0,
          x: sample.imu.quatX ?? 0,
          y: sample.imu.quatY ?? 0,
          z: sample.imu.quatZ ?? 0,
        } : undefined,
      });
    };
    window.addEventListener('imu-sample', handleImuSample);

    // Herná slučka (60 FPS)
      const loop = () => {
      const g = gameRef.current;
      if (!g) return;

      if (g.isGameOver) return;

      // Pokiaľ kalibrácia nie je dokončená, preskočiť herné aktualizácie (len ak je WS pripojené)
      if (!isCalibrated && wsConnected) {
        // stále vyvolať render aby UI zobrazilo kalibračný modal/overlay
        forceUpdate({});
        return;
      }

      // Ak sú otvorené nastavenia, preskočiť aktualizácie
      if (!showSettingsRef.current) {
        // Skontrolovať či sú všetky prsty stlačené
        const allFingers = g.inputMapper.allFingersPressed();

        // Okamžité equipnutie: ak používateľ stlačí všetky päť prstov a kúsok je dostupný, equipnúť okamžite
        if (!g.blockEquipped && allFingers && g.tetris.active) {
          g.blockEquipped = true;
          console.log('[EQUIP] Immediate equip on full grip');
        }

        // Detekcia uvoľnenia gripu pre equipnutie bloku (fallback správanie)
        if (g.wasGripping && !allFingers && !g.blockEquipped) {
          g.blockEquipped = true;
          console.log('[EQUIP] Blok equipnutý!');
        }
        g.wasGripping = allFingers;

        // Resetovať waitForFingerRelease keď používateľ pustí prsty
        if (g.waitForFingerRelease && !allFingers) {
          g.waitForFingerRelease = false;
        }

        // Spracovať IMU vstupy
        const actions = g.inputMapper.pollActions();

        // Debug log (obmedzený)
        if (g.tetris.active && Math.random() < 0.01) {
          console.log(`[DEBUG] Equipped: ${g.blockEquipped}, AllFingers: ${allFingers}, Actions: ${actions.join(',')}`);
        }

        // Akcie sú povolené LEN ak je blok equipnutý a používateľ drží všetky prsty (ako v Pentomino)
        if (g.blockEquipped && allFingers) {
          for (const action of actions) {
            if (hardDropAnimatingRef.current) break;
            // Ak čakáme na pustenie prstov, ignorovať DROP
            if (g.waitForFingerRelease && action === BTN_DROP) {
              continue;
            }

            switch (action) {
              case BTN_LEFT: g.tetris.move(-1, 0); break;
              case BTN_RIGHT: g.tetris.move(1, 0); break;
              case BTN_UP: if (level === 1) g.tetris.move(0, -1); break;
              case BTN_DOWN: if (level === 1) g.tetris.move(0, 1); break;
                case BTN_ROTATE:
                  g.tetris.rotate();
                  rotationBlockedUntilRef.current = Date.now() + ROTATION_HARDDROP_BLOCK_MS;
                  break;
                case BTN_DROP:
                  if (Date.now() < rotationBlockedUntilRef.current) {
                    console.log('[BLOCKED] IMU hard drop ignored due to recent rotation');
                    break;
                  }
                  triggerAnimatedHardDrop(g);
                  break;
            }
          }

          // Space Pointer logika ODSTRÁNENÁ - pohyb funguje LEN pri gripe (všetkých 5 prstov)
          // Toto je presná kópia správania z PentominoGame
        }

        // Detekovať vyčistené riadky z enginu a spustiť UI animáciu
        if (!rowClearAnimatingRef.current && g.tetris && Array.isArray(g.tetris.lastClearedRows) && g.tetris.lastClearedRows.length > 0) {
          const rows = g.tetris.lastClearedRows.slice();
          const rowsData = (g.tetris.lastClearedRowsData || []).slice();
          const duration = 220;
          rowClearAnimatingRef.current = true;
          setRowClearAnim({ rows, rowsData, duration, animate: false });
          requestAnimationFrame(() => {
            setRowClearAnim((prev) => (prev ? { ...prev, animate: true } : prev));
          });
          setTimeout(() => {
            // vyčistiť snímku na strane enginu, aby sa znovu nespustila
            try { g.tetris.lastClearedRows = []; g.tetris.lastClearedRowsData = []; } catch (e) {}
            setRowClearAnim(null);
            rowClearAnimatingRef.current = false;
            forceUpdate({});
          }, duration);
        }

        // Gravitačný pohyb (Level 2) - LEN ak je blok equipnutý
        const now = Date.now() / 1000;
        const gravityInterval = 1.0 / gravitySpeed;

        if (level === 2 && g.blockEquipped && !allFingers && !g.waitForFingerRelease && !hardDropAnimatingRef.current && now - g.lastGravity >= gravityInterval) {
          if (!g.tetris.move(0, 1)) {
            g.tetris.place();
            if(!g.tetris.spawn()) g.onGameOver(true);
            // V Level 2 je nový blok hneď equipnutý (automatické padanie)
            g.blockEquipped = true;
          }
          g.lastGravity = now;
        }

        // Automatické spawnovanie (Level 1) - čakať na pustenie prstov
        if (level === 1 && !g.tetris.active && !g.waitForFingerRelease) {
          if(!g.tetris.spawn()) g.onGameOver(true);
          g.blockEquipped = false;  // Nový blok treba equipnúť
        }

        setScore(g.tetris.score);
      }

      forceUpdate({});
    };

    if (gameRef.current) {
      gameRef.current.intervalId = window.setInterval(loop, 1000 / 60);
    }

    return () => {
      if (gameRef.current) {
        clearInterval(gameRef.current.intervalId);
      }
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('imu-sample', handleImuSample);
    };
  }, [level, onBackToMenu, gravitySpeed]);

  const restartGame = () => {
    const g = gameRef.current;
    if (g) {
      // Vytvoriť znovu inštanciu Tetrisu a resetovať skóre
      g.tetris = new Tetris(TETRIS_COLORS);
      g.tetris.spawn();
      g.isGameOver = false;
      setScore(0);
      setPlacedCorrectCount(0);
      setTimeTaken(0);
      setModalTitle('Dobrá práca!');
      startTimeRef.current = Date.now();
      setShowHandModal(false);
      // vyvolať render
      forceUpdate({});
    }
  };

  // Logika škálovania - zodpovedá GameBoard a PentominoGame
  useEffect(() => {
    function computeScale() {
      const gridW = COLS * CELL_SIZE + 24;
      const sideW = 400; // sidebar width
      const gap = 24;
      const contentWidth = gridW + gap + sideW;

      const gridH = ROWS * CELL_SIZE + 24;
      const footerH = 140;
      const contentHeight = gridH + footerH;

      const padding = 48;
      const vw = Math.max(320, window.innerWidth - padding);
      const vh = Math.max(480, window.innerHeight - padding);

      // Match Pentomino/GameBoard behavior: apply small multiplier to avoid aggressive shrink
      const s = Math.min(1, vw / contentWidth, vh / contentHeight) * 1.1;
      setScale(Number(s.toFixed(3)));
    }

    computeScale();
    window.addEventListener('resize', computeScale);
    return () => window.removeEventListener('resize', computeScale);
  }, [CELL_SIZE]);

  // Blok tlačidiel extrahovaný, aby ho bolo možné renderovať buď v scroll oblasti
  // alebo pripevniť nižšie, v závislosti od levelu (aby sa zabránilo prázdnemu priestoru na L1).
  const Buttons = (
    <div className="mb-4 flex flex-col gap-3">
      {/* Ghost toggle placed above exit button as requested */}
      <button
        onClick={() => setGhostEnabled(!ghostEnabled)}
        className={`w-full rounded-xl py-3 px-6 transition-colors font-medium ${ghostEnabled ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-800'}`}
      >
        {ghostEnabled ? 'Obrys' : 'Obrys'}
      </button>

      <button
        onClick={() => {
          const g = gameRef.current;
          if (g) g.onGameOver(false);
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
    </div >
  );

  return (
    <div className="fixed inset-0 h-screen w-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 overflow-hidden">
      {showHandModal && (
        <ModalBackdrop>
          <TetrisFinishedModal
            score={score}
            placedCount={placedCorrectCount}
            timeTaken={timeTaken}
            title={modalTitle}
            onBackToMenu={onBackToMenu}
            onRestart={restartGame}
          />
        </ModalBackdrop>
      )}
      {inputMapperInstance && (
        <SettingsMenu
          inputMapper={inputMapperInstance}
          visible={showSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Calibration Modal */}
      <CalibrationModal useLeftHand={useLeftHand} />

      <div
        className="flex flex-col gap-6 animate-fade-in origin-center transition-transform duration-200 ease-out"
        style={{
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'center',
          position: 'relative'
        }}
      >


        <div className="flex gap-6">
          <div
            className="relative bg-white rounded-2xl shadow-2xl p-3 transition-shadow duration-200"
            style={{
              width: COLS * CELL_SIZE + 24,
              height: ROWS * CELL_SIZE + 24,
              boxShadow: isGripping 
                ? '0 0 12px 12px rgba(252, 186, 3, 0.35), 0 0 24px 8px rgba(147, 51, 234, 0.15)' 
                : undefined,
            }}
          >
            {/* Grid lines */}
            <div
              className="absolute inset-3 grid"
              style={{
                gridTemplateColumns: `repeat(${COLS}, ${CELL_SIZE}px)`,
                gridTemplateRows: `repeat(${ROWS}, ${CELL_SIZE}px)`,
              }}
            >
              {Array.from({ length: COLS * ROWS }).map((_, i) => (
                <div key={i} className="border border-slate-200" />
              ))}
            </div>

            {/* Board cells */}
            {gameRef.current?.tetris.board.map((row, y) =>
              row.map((cell, x) =>
                cell ? (
                  <div
                    key={`board-${y}-${x}`}
                    className="absolute rounded border-4 transition-all duration-200"
                    style={{
                      left: 12 + x * CELL_SIZE + 3,
                      top: 12 + y * CELL_SIZE + 3,
                      width: CELL_SIZE - 6,
                      height: CELL_SIZE - 6,
                      backgroundColor: cell,
                      borderColor: `color-mix(in srgb, ${cell} 30%, black)`,
                    }}
                  />
                ) : null
              )
            )}

            {/* Ghost piece */}
            {ghostEnabled && gameRef.current?.tetris.active && (() => {
              const g = gameRef.current;
              const active = g.tetris.active!;
              const ghostY = g.tetris.getGhostY();
              if (ghostY !== null && ghostY > active.y) {
                const color = g.tetris.activeColor || TETRIS_COLORS[0];
                return active.blocks.map(([bx, by], idx) => {
                  const gx = bx;
                  const gy = by + (ghostY - active.y);
                  if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) {
                    return (
                      <div
                        key={`ghost-${idx}`}
                        className="absolute rounded border-4 transition-all"
                        style={{
                          left: 12 + gx * CELL_SIZE + 3,
                          top: 12 + gy * CELL_SIZE + 3,
                          width: CELL_SIZE - 6,
                          height: CELL_SIZE - 6,
                          borderColor: color,
                          opacity: 0.4,
                        }}
                      />
                    );
                  }
                  return null;
                });
              }
              return null;
            })()}

            {/* Hard-drop animation overlay */}
            {hardDropAnim && (() => {
              const anim = hardDropAnim;
              return anim.blocks.map(([bx, by], idx) => {
                const left = 12 + bx * CELL_SIZE + 3;
                const startTop = 12 + by * CELL_SIZE + 3;
                const top = anim.animate ? startTop + anim.delta * CELL_SIZE : startTop;
                return (
                  <div
                    key={`harddrop-${idx}`}
                    className="absolute rounded border-4 transition-all pointer-events-none"
                    style={{
                      left,
                      top,
                      width: CELL_SIZE - 6,
                      height: CELL_SIZE - 6,
                      backgroundColor: anim.color,
                      borderColor: `color-mix(in srgb, ${anim.color} 30%, black)`,
                      transitionDuration: `${anim.duration}ms`,
                      zIndex: 60,
                    }}
                  />
                );
              });
            })()}

            {/* Row-clear animation overlay */}
            {rowClearAnim && (() => {
              const anim = rowClearAnim;
              const stagger = 28; // ms per column distance from center
              const center = (COLS - 1) / 2;
              return anim.rows.flatMap((rowIndex) => {
                const rowData = anim.rowsData[anim.rows.indexOf(rowIndex)] || [];
                return rowData.map((cellColor, colIdx) => {
                  if (!cellColor) return null;
                  const left = 12 + colIdx * CELL_SIZE + 3;
                  const topStart = 12 + rowIndex * CELL_SIZE + 3;
                  const delay = Math.round(Math.abs(colIdx - center) * stagger);
                  const transform = anim.animate ? 'translateY(-18px) scale(0.78)' : 'translateY(0px) scale(1)';
                  const opacity = anim.animate ? 0 : 1;
                  return (
                    <div
                      key={`clear-${rowIndex}-${colIdx}`}
                      className="absolute rounded pointer-events-none"
                      style={{
                        left,
                        top: topStart,
                        width: CELL_SIZE - 6,
                        height: CELL_SIZE - 6,
                        backgroundColor: cellColor,
                        borderColor: `color-mix(in srgb, ${cellColor} 30%, black)`,
                        transform,
                        opacity,
                        transitionProperty: 'transform, opacity',
                        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                        transitionDuration: `${anim.duration}ms`,
                        transitionDelay: `${delay}ms`,
                        zIndex: 55,
                      }}
                    />
                  );
                });
              });
            })()}

            {/* Active piece (hidden while animated hard-drop overlay is playing) */}
            {gameRef.current?.tetris.active && !hardDropAnim && (() => {
              const g = gameRef.current;
              const active = g.tetris.active!;
              const color = g.tetris.activeColor || TETRIS_COLORS[0];
              return active.blocks.map(([x, y], idx) => {
                if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
                  return (
                    <div
                      key={`active-${idx}`}
                      className="absolute rounded border-4 transition-all duration-200"
                      style={{
                        left: 12 + x * CELL_SIZE + 3,
                        top: 12 + y * CELL_SIZE + 3,
                        width: CELL_SIZE - 6,
                        height: CELL_SIZE - 6,
                        backgroundColor: color,
                        borderColor: `color-mix(in srgb, ${color} 30%, black)`,
                      }}
                    />
                  );
                }
                return null;
              });
            })()}
          </div>

          <div 
            className="flex flex-col rounded-2xl bg-white p-6 shadow-2xl"
            style={{ width: 400, height: ROWS * CELL_SIZE + 24 }}
          >

            {level === 1 && (
                <div className="mb-4 rounded-xl bg-amber-50 p-4">
                  <h4 className="text-lg font-bold text-amber-900 mb-2 flex items-center gap-2">
                    Úroveň 1
                  </h4>
                  <p className="text-md text-amber-700 text-justify">
                    Táto úroveň neobsahuje padanie. Blokom je možné pohybovať ľubovoľne vo všetkých smeroch.
                  </p>
                </div>
              )}

            <div className="flex-1 overflow-y-auto space-y-4">
              <div className="rounded-xl bg-green-50 p-5">
                <p className="text-lg font-bold text-green-600 tracking-wide">Skóre</p>
                <p className="text-5xl font-extrabold text-green-800 text-center py-3">{score}</p>
              </div>

              {level === 2 && (
                <div className="rounded-xl bg-orange-50 p-4">
                  <p className="text-lg font-bold text-orange-700  mb-2">Rýchlosť padania</p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setGravitySpeed(Math.max(1, gravitySpeed - 1))}
                      disabled={gravitySpeed <= 1}
                      className="px-3 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-bold text-lg flex-shrink-0"
                    >
                      −
                    </button>
                    <div className="flex-1 text-center">
                      <p className="text-2xl font-bold text-orange-900">{gravitySpeed}</p>
                    </div>
                    <button
                      onClick={() => setGravitySpeed(Math.min(5, gravitySpeed + 1))}
                      disabled={gravitySpeed >= 5}
                      className="px-3 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-bold text-lg flex-shrink-0"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-xl bg-purple-50 p-4">
                <h3 className="text-lg font-bold text-purple-900 mb-2">
                  Nasledujúce bloky
                </h3>
                {gameRef.current?.tetris.nextPiece && (() => {
                  const nextPiece = gameRef.current.tetris.nextPiece;
                  const upcoming = gameRef.current.tetris.upcomingPieces || [];
                  const previews = [nextPiece, ...(upcoming || [])].slice(0, 2);

                  const large = { cellSize: 14, containerWidth: 90, containerHeight: 60, wrapper: 'bg-white rounded-lg p-2 border-2 border-purple-400 shadow-md' };
                  const small = { cellSize: 10, containerWidth: 70, containerHeight: 40, wrapper: 'bg-white/50 rounded-lg p-1.5 opacity-60' };

                  return (
                    <div className="space-y-2">
                      {previews.map((p, i) => {
                        const cfg = i === 0 ? large : small;
                        const shapes = TETROMINOES[p.kind];
                        const shape = shapes[0];
                        const xs = shape.map(([x]) => x);
                        const ys = shape.map(([, y]) => y);
                        const minX = Math.min(...xs);
                        const maxX = Math.max(...xs);
                        const minY = Math.min(...ys);
                        const maxY = Math.max(...ys);
                        const width = maxX - minX + 1;
                        const height = maxY - minY + 1;
                        const offsetX = (cfg.containerWidth - width * cfg.cellSize) / 2;
                        const offsetY = (cfg.containerHeight - height * cfg.cellSize) / 2;

                        return (
                          <div key={`next-preview-${i}`} className={`${cfg.wrapper} flex justify-center items-center`}>
                            <div className="relative" style={{ width: `${cfg.containerWidth}px`, height: `${cfg.containerHeight}px` }}>
                              {shape.map(([dx, dy], idx) => (
                                <div
                                  key={`next-${i}-${idx}`}
                                  className="absolute rounded"
                                  style={{
                                    left: offsetX + (dx - minX) * cfg.cellSize,
                                    top: offsetY + (dy - minY) * cfg.cellSize,
                                    width: cfg.cellSize,
                                    height: cfg.cellSize,
                                    backgroundColor: p.color,
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

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
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <p><span className="font-semibold">Dvojité stlačenie →</span> Blok spadne</p>
                  </div>
                </div>
              </div>

            </div>
            {/* Buttons pinned at the bottom for all levels */}
            {Buttons}
          </div>
        </div>
      </div>
    </div>
  );
}
