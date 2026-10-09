import { useEffect, useState, useRef } from 'react';
import { Hand, X } from 'lucide-react';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';
import { useModal } from '../context/ModalContext';

interface CalibrationModalProps {
  useLeftHand?: boolean;
}

type Quat = { w: number; x: number; y: number; z: number };

export function CalibrationModal({ useLeftHand = false }: CalibrationModalProps) {
  const { showCalibrationModal, calibrate, hideCalibrationModal, isCalibrated } = useCalibration();
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
        pressedKeysRef.current.add(e.key.toLowerCase());
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

      // Extrahovať stavy prstov z ADC (indexy 1-5)
      let fingersRaw = adc.slice(1, 6).map((v: any) => Number(v || 0));
      const fingers = useLeftHand ? fingersRaw : fingersRaw.slice().reverse();

      const defaultRawThr = (cfg as any)?.TENSOMETER_RAW_THRESHOLD ?? 2000;
      const defaultNormThr = (cfg as any)?.TENSOMETER_NORM_THRESHOLD ?? 12;

      const newStates = fingers.map((val) => {
        const raw = Math.abs(val);
        const norm = raw / 128;
        return raw > defaultRawThr || norm > defaultNormThr;
      });

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
  }, [showCalibrationModal, useLeftHand, cfg, wsConnected]);

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
            Kalibrácia senzora
          </h2>
          <p className="text-lg text-slate-600 mb-8">
            Pre kalibráciu stlačte <strong>všetky prsty naraz</strong> a podržte ich 1 sekundu.
          </p>
          

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

          {/* Vždy viditeľný progress bar */}
          <div className="w-full mb-6">
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
          </div>

          

          
        </div>
      </div>
    </div>
  );
}
