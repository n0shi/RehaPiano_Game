import { useEffect, useState, useRef } from 'react';
import { Hand, X } from 'lucide-react';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';
import { useModal } from '../context/ModalContext';
import { computeFingerCal, saveFingerCal, handKeyOf, provisionalPressed, FINGER_COUNT, type FingerState } from '../utils/fingerCalibration';

// Kalibrácia prstov pre konkrétneho človeka a sedenie (pozri utils/fingerCalibration.ts): pred stiskom sa zmeria pokoj a pohyb zápästia.
type Phase = 'rest' | 'motion' | 'grip';
const REST_SETTLE_MS = 800; // začiatok pokoja sa zahodí: prsty ešte dobiehajú zo stisku pri výbere ruky (na záznamoch odchýlka až 2 000 – 5 000 v prvých ~0,5 s)
const REST_MS = 2000;      // uvoľnená ruka, bez pohybu (meria sa po REST_SETTLE_MS)
const MOTION_MS = 3000;    // uvoľnené prsty, krúženie zápästím
const GRIP_SKIP_MS = 300;  // začiatok stisku (prsty sa ešte zatvárajú) sa do sily stisku nepočíta
const MIN_GRIP_SAMPLES = 40;

// TEST: klávesy Q W E R T fungujú ako prepínače (netreba držať všetkých 5 naraz).
// false = pôvodné správanie (treba držať všetky klávesy súčasne)
const KEYBOARD_STICKY_FINGERS = true;

interface CalibrationModalProps {
  useLeftHand?: boolean;
}

type Quat = { w: number; x: number; y: number; z: number };

export function CalibrationModal({ useLeftHand: useLeftHandProp = false }: CalibrationModalProps) {
  const { showCalibrationModal, calibrate, hideCalibrationModal, isCalibrated, handMode, calibratingHand } = useCalibration();
  const dual = handMode === 'dual';
  // V režime dvoch rúk sa kalibruje najprv ľavá, potom pravá – usporiadanie prstov podľa aktuálnej ruky
  const useLeftHand = dual ? calibratingHand === 'left' : useLeftHandProp;
  const cfg = useConfig();
  const { enterModal, exitModal } = useModal();
  const wsConnected = typeof window !== 'undefined' && !!(window as any).__wsConnected;
  
  // Stav stlačenia prstov (0-4: malíček -> palec)
  const [fingerStates, setFingerStates] = useState<boolean[]>([false, false, false, false, false]);
  const [allPressedFor, setAllPressedFor] = useState<number>(0);
  const [lastQuat, setLastQuat] = useState<Quat | null>(null);
  const allPressedStartRef = useRef<number | null>(null);
  const calibrationDoneRef = useRef<boolean>(false);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const imuFingerStatesRef = useRef<boolean[]>([false, false, false, false, false]);
  const modalEnteredRef = useRef<boolean>(false);
  const [phase, setPhase] = useState<Phase>('rest');
  const phaseRef = useRef<Phase>('rest');
  const [phaseProg, setPhaseProg] = useState(0);
  const phaseStartRef = useRef<number | null>(null);
  const restBufRef = useRef<number[][]>([]);
  const motionBufRef = useRef<number[][]>([]);
  const gripBufRef = useRef<number[][]>([]);
  const restStatsRef = useRef<{ rest: number[]; noise: number[] } | null>(null);
  const skipFingersRef = useRef(false);      // kalibrácia prstov preskočená (tlačidlo alebo klávesnica): platí uložená / pôvodný prah
  const handKeyRef = useRef<unknown>(undefined);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const goPhase = (p: Phase) => { phaseRef.current = p; setPhase(p); phaseStartRef.current = null; setPhaseProg(0); };
  const resetFingerCal = () => {
    restBufRef.current = []; motionBufRef.current = []; gripBufRef.current = [];
    restStatsRef.current = null; skipFingersRef.current = false; setSavedNote(null);
    goPhase('rest');
  };

  // Simulácia klávesnice pre testovanie (Q, W, E, R, T pre 5 prstov)
  useEffect(() => {
    if (!showCalibrationModal || !wsConnected) return;
    // označiť otvorenie modalu pre globálne zablokovanie vstupu
    enterModal();
    modalEnteredRef.current = true;
    const keyToFinger: Record<string, number> = {
      'q': 0, 'w': 1, 'e': 2, 'r': 3, 't': 4,
      'Q': 0, 'W': 1, 'E': 2, 'R': 3, 'T': 4,
    };

    // uchovať stlačené klávesy v refe, aby ich IMU handler mohol kombinovať
    pressedKeysRef.current = pressedKeysRef.current || new Set<string>();

    const handleKeyDown = (e: KeyboardEvent) => {
      const finger = keyToFinger[e.key];
      if (finger !== undefined) {
        if (phaseRef.current !== 'grip' || !skipFingersRef.current) { skipFingersRef.current = true; goPhase('grip'); }
        const k = e.key.toLowerCase();
        if (KEYBOARD_STICKY_FINGERS) {
          // Režim "prepínač": klávesa raz = prst stlačený, ešte raz = uvoľnený
          if (e.repeat) return;
          if (pressedKeysRef.current.has(k)) pressedKeysRef.current.delete(k);
          else pressedKeysRef.current.add(k);
        } else {
          pressedKeysRef.current.add(k);
        }
        // kombinovať IMU a klávesnicu
        const kbStates = [
          pressedKeysRef.current.has('q'),
          pressedKeysRef.current.has('w'),
          pressedKeysRef.current.has('e'),
          pressedKeysRef.current.has('r'),
          pressedKeysRef.current.has('t'),
        ];
        const combined = imuFingerStatesRef.current.map((v, i) => v || kbStates[i]);
        setFingerStates(combined);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (KEYBOARD_STICKY_FINGERS) return; // v režime prepínača keyup nič neuvoľňuje
      pressedKeysRef.current.delete(e.key.toLowerCase());
      const kbStates = [
        pressedKeysRef.current.has('q'),
        pressedKeysRef.current.has('w'),
        pressedKeysRef.current.has('e'),
        pressedKeysRef.current.has('r'),
        pressedKeysRef.current.has('t'),
      ];
      const combined = imuFingerStatesRef.current.map((v, i) => v || kbStates[i]);
      setFingerStates(combined);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (modalEnteredRef.current) {
        exitModal();
        modalEnteredRef.current = false;
      }
    };
  }, [showCalibrationModal, wsConnected]);

  // Počúvať vzorky z IMU pre detekciu stlačenia prstov
  useEffect(() => {
    if (!showCalibrationModal || !wsConnected) {
      calibrationDoneRef.current = false;
      return;
    }

    const handleImuSample = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      // Dve ruky: reaguj len na vzorky ruky, ktorá sa práve kalibruje
      if (dual && detail.hand !== calibratingHand) return;

      const adc: number[] = Array.isArray(detail.adc) ? detail.adc : [];
      const imu = detail.imu || {};

      // Extrahovať quaternion pre kalibráciu
      if (imu.quatW !== undefined) {
        setLastQuat({
          w: imu.quatW ?? 0,
          x: imu.quatX ?? 0,
          y: imu.quatY ?? 0,
          z: imu.quatZ ?? 0,
        });
      }

      // ADC prstov v poradí kanálov 1-5
      const fingersRaw = Array.from({ length: FINGER_COUNT }, (_, i) => Number(adc[i + 1]) || 0);
      handKeyRef.current = detail.hand;
      const now = performance.now();

      // Kroky 1 a 2: pokoj a pohyb zápästia (len zber vzoriek, prsty sa nevyhodnocujú)
      const ph = phaseRef.current;
      if (ph === 'rest' || ph === 'motion') {
        if (phaseStartRef.current === null) phaseStartRef.current = now;
        const dur = ph === 'rest' ? REST_SETTLE_MS + REST_MS : MOTION_MS;
        if (ph === 'motion') motionBufRef.current.push(fingersRaw);
        else if (now - phaseStartRef.current >= REST_SETTLE_MS) restBufRef.current.push(fingersRaw);
        const prog = Math.min(1, (now - phaseStartRef.current) / dur);
        setPhaseProg(prog);
        if (prog >= 1) {
          if (ph === 'rest') {
            const c = computeFingerCal(restBufRef.current, [], restBufRef.current);
            restStatsRef.current = { rest: c.rest, noise: c.noise };
            goPhase('motion');
          } else {
            goPhase('grip');
          }
        }
        imuFingerStatesRef.current = [false, false, false, false, false];
        setFingerStates([false, false, false, false, false]);
        return;
      }

      // Krok 3: stisk. Počas merania sa stisk pozná predbežne (výrazne nad nameraným pokojom); po preskočení podľa uloženej kalibrácie.
      const rs = restStatsRef.current;
      const chPressed = !skipFingersRef.current && rs
        ? fingersRaw.map((v, i) => provisionalPressed(v, rs.rest[i], rs.noise[i]))
        : ((detail.fingers as FingerState | undefined)?.pressed ?? fingersRaw.map(() => false));
      if (!skipFingersRef.current && rs && chPressed.every(Boolean) && allPressedStartRef.current !== null
        && now - allPressedStartRef.current > GRIP_SKIP_MS) {
        gripBufRef.current.push(fingersRaw);
      }
      const newStates = useLeftHand ? chPressed : chPressed.slice().reverse();

      // uložiť stavy odvodené z IMU a kombinovať s držanými klávesmi
      imuFingerStatesRef.current = newStates;
      const kbStates = [
        pressedKeysRef.current.has('q'),
        pressedKeysRef.current.has('w'),
        pressedKeysRef.current.has('e'),
        pressedKeysRef.current.has('r'),
        pressedKeysRef.current.has('t'),
      ];
      const combined = newStates.map((v, i) => v || kbStates[i]);
      setFingerStates(combined);
    };

    window.addEventListener('imu-sample', handleImuSample);
    return () => window.removeEventListener('imu-sample', handleImuSample);
  }, [showCalibrationModal, useLeftHand, cfg, wsConnected, dual, calibratingHand]);

  // Skontrolovať či sú všetky prsty stlačené a podržať pre kalibráciu
  useEffect(() => {
    if (!showCalibrationModal || calibrationDoneRef.current || !wsConnected) return;
    const CALIBRATION_THRESHOLD_MS = 1300; // skutočne požadovaný čas podržania
    let rafId: number | null = null;

    const start = () => {
      // Inicializovať začiatok a resetovať progres len keď naozaj začneme
      if (allPressedStartRef.current === null) {
        allPressedStartRef.current = performance.now();
        setAllPressedFor(0);
      }

      const loop = () => {
        if (allPressedStartRef.current === null) return;
        const elapsed = performance.now() - allPressedStartRef.current;
        setAllPressedFor(elapsed);

        if (elapsed >= CALIBRATION_THRESHOLD_MS) {
          // dokončiť kalibráciu a zastaviť RAF
          calibrationDoneRef.current = true;
          // uložiť kalibráciu prstov (ak sa merala): pokoj, pohyb zápästia, sila stisku
          if (!skipFingersRef.current && restStatsRef.current && gripBufRef.current.length >= MIN_GRIP_SAMPLES) {
            saveFingerCal(handKeyOf(handKeyRef.current), computeFingerCal(restBufRef.current, motionBufRef.current, gripBufRef.current));
          }
          if (lastQuat) calibrate(lastQuat);
          else calibrate({ w: 1, x: 0, y: 0, z: 0 });
          return;
        }

        rafId = requestAnimationFrame(loop);
      };

      rafId = requestAnimationFrame(loop);
    };

    const stop = () => {
      allPressedStartRef.current = null;
      setAllPressedFor(0);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };

    const allPressed = fingerStates.every((s) => s);
    if (allPressed) start();
    else stop();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [fingerStates, showCalibrationModal, lastQuat, calibrate, wsConnected]);

  // Dve ruky: pri prechode na ďalšiu ruku vyčisti stav (prsty, progres, naposledy videný quaternion)
  useEffect(() => {
    if (!dual) return;
    calibrationDoneRef.current = false;
    allPressedStartRef.current = null;
    imuFingerStatesRef.current = [false, false, false, false, false];
    setFingerStates([false, false, false, false, false]);
    setAllPressedFor(0);
    setLastQuat(null);
    resetFingerCal();
  }, [dual, calibratingHand]);

  // Resetovať stavy prstov keď sa modal zatvorí
  useEffect(() => {
    if (!showCalibrationModal) {
      setFingerStates([false, false, false, false, false]);
      setAllPressedFor(0);
      allPressedStartRef.current = null;
      calibrationDoneRef.current = false;
      // vyčistiť refy pre IMU a klávesnicu, aby sa nezachovali staré "pressed" hodnoty
      try {
        pressedKeysRef.current?.clear?.();
      } catch (e) {
        pressedKeysRef.current = new Set();
      }
      imuFingerStatesRef.current = [false, false, false, false, false];
    } else {
      // pri otvorení zabezpečiť, že nie je prítomný žiadny starý stav
      calibrationDoneRef.current = false;
      try {
        pressedKeysRef.current?.clear?.();
      } catch (e) {
        pressedKeysRef.current = new Set();
      }
      imuFingerStatesRef.current = [false, false, false, false, false];
      setFingerStates([false, false, false, false, false]);
      setAllPressedFor(0);
      allPressedStartRef.current = null;
      resetFingerCal();
    }
  }, [showCalibrationModal]);

  if (!showCalibrationModal || !wsConnected) return null;

  const fingerNames = useLeftHand 
    ? ['Malíček', 'Prstenník', 'Prostredník', 'Ukazovák', 'Palec']
    : ['Palec', 'Ukazovák', 'Prostredník', 'Prstenník', 'Malíček'];

  const CALIBRATION_THRESHOLD_MS = 1300;
  const progress = Math.min(100, (allPressedFor / CALIBRATION_THRESHOLD_MS) * 100);
  const allPressed = fingerStates.every(s => s);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-md"
      style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
    >
      <div
        className="relative bg-white rounded-3xl shadow-2xl p-10 max-w-lg w-full mx-4 animate-fadeinup"
        style={{ borderRadius: '24px' }}
      >
        {isCalibrated ? (
          <button
            aria-label="Close calibration"
            onClick={() => {
              // vyčistiť tranzitný IMU/klávesnicový stav aby vizuály nezostali
              try {
                pressedKeysRef.current?.clear?.();
              } catch (e) {
                pressedKeysRef.current = new Set();
              }
              imuFingerStatesRef.current = [false, false, false, false, false];
              setFingerStates([false, false, false, false, false]);
              setAllPressedFor(0);
              allPressedStartRef.current = null;
              calibrationDoneRef.current = false;
              // zatvoriť modal (neodstraňovať existujúcu kalibráciu)
              hideCalibrationModal();
              if (modalEnteredRef.current) {
                exitModal();
                modalEnteredRef.current = false;
              }
            }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100"
            style={{ transform: 'translate(0, 0)' }}
          >
            <X className="w-5 h-5" />
          </button>
        ) : null}
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-6">
            <Hand className="w-8 h-8 text-blue-600" />
          </div>

          <h2 className="text-3xl font-extrabold text-slate-900 mb-3">
            Kalibrácia senzora{dual && calibratingHand ? ` – ${calibratingHand === 'left' ? 'ĽAVÁ ruka (1/2)' : 'PRAVÁ ruka (2/2)'}` : ''}
          </h2>
          {/* Kroky kalibrácie: 1 pokoj, 2 pohyb zápästia, 3 stisk */}
          <div className="flex gap-2 mb-4 text-xs font-semibold">
            {(['rest', 'motion', 'grip'] as Phase[]).map((p, i) => (
              <span key={p} className={`px-3 py-1 rounded-full ${phase === p ? 'bg-blue-600 text-white' : (['rest', 'motion', 'grip'].indexOf(phase) > i ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500')}`}>
                {i + 1}. {p === 'rest' ? 'Pokoj' : p === 'motion' ? 'Pohyb zápästia' : 'Stisk'}
              </span>
            ))}
          </div>
          <p className="text-lg text-slate-600 mb-8">
            {phase === 'rest' && <>Položte ruku do <strong>normálnej polohy</strong>, prsty <strong>úplne uvoľnené</strong> a nehýbte sa.</>}
            {phase === 'motion' && <>Prsty nechajte <strong>uvoľnené</strong> a pomaly <strong>krúžte zápästím</strong> do všetkých strán.</>}
            {phase === 'grip' && <>Teraz <strong>stisnite naplno všetky prsty naraz</strong> a podržte ich 1 sekundu v normálnej polohe.</>}
          </p>
          {phase !== 'grip' && (
            <div className="w-full mb-6">
              <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-blue-500" style={{ width: `${phaseProg * 100}%` }} />
              </div>
              <button
                className="mt-3 text-sm text-slate-500 underline"
                onClick={() => { skipFingersRef.current = true; goPhase('grip'); setSavedNote('Kalibrácia prstov preskočená – platí posledná uložená (alebo pôvodný prah).'); }}
              >
                Preskočiť kalibráciu prstov
              </button>
            </div>
          )}
          {savedNote && <p className="text-xs text-slate-500 -mt-4 mb-4">{savedNote}</p>}
          {phase === 'grip' && !skipFingersRef.current && (
            <button className="-mt-4 mb-4 text-sm text-slate-500 underline" onClick={resetFingerCal}>
              Nedá sa stisnúť? Začať kalibráciu prstov odznova
            </button>
          )}
          

          {/* Finger visualization */}
          <div className="w-full mb-8">
            <div className="flex justify-center gap-3 mb-4">
              {fingerStates.map((pressed, idx) => {
                // Výšky prstov pre vizuálnu reprezentáciu
                const heights = useLeftHand 
                  ? [48, 64, 72, 64, 48]  // malíček -> palec
                  : [48, 64, 72, 64, 48]; // palec -> malíček
                
                return (
                  <div key={idx} className="flex flex-col items-center">
                    <div
                      className={`rounded-full transition-all duration-200 ${
                        pressed 
                          ? 'bg-green-500 shadow-lg shadow-green-500/50' 
                          : 'bg-slate-300'
                      }`}
                      style={{
                        width: 32,
                        height: heights[idx],
                        transform: pressed ? 'scale(1.1)' : 'scale(1)',
                      }}
                    />
                    <span className={`text-xs mt-2 font-medium ${pressed ? 'text-green-600' : 'text-slate-500'}`}>
                      {fingerNames[idx]}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* dlaň odstránená - zobrazené sú len prsty */}
          </div>

          {/* Progress držania stisku (krok 3) */}
          {phase === 'grip' && <div className="w-full mb-6">
            <div className="h-3 bg-slate-200 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full ${allPressed ? 'bg-green-500' : 'bg-amber-400'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className={`text-sm mt-2 font-medium ${allPressed ? 'text-green-600' : 'text-slate-600'}`}>
              {allPressed ? (() => {
                const remainingMs = Math.max(0, Math.ceil(CALIBRATION_THRESHOLD_MS - allPressedFor));
                const secs = (remainingMs / 1000).toFixed(2);
                return `Držte... ${secs} s`;
              })() : 'Stlačte všetky prsty'}
            </p>
          </div>}

          

          
        </div>
      </div>
    </div>
  );
}
