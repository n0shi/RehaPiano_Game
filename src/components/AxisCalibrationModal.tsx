import { useEffect, useRef, useState } from 'react';
import SingleIMUController from '../utils/imuController';
import { useCalibration } from '../context/CalibrationContext';
import {
  Dir, HandKey, ProfileFit, clearProfiles, fitAxisProfile, hasProfiles, loadProfiles, saveProfile,
} from '../utils/axisCalibration';

type Vec3 = [number, number, number];

// Kalibrácia osí: používateľ 4× (vpravo, vľavo, hore, dole) pohne rukou z pokojovej polohy a späť; z nameraných otočení sa naučia
// osi ovládania pre AKTUÁLNU polohu rukavice (po otočení rukavice o 90° treba kalibrovať znova). Výsledok sa ukladá ako profil
// (localStorage) a hry si ho pri recentre vyberú podľa uhla krútenia rukavice (menu aj kreslenie). Beží samostatne od hier – vlastný kontrolér a vlastné počúvanie 'imu-sample'.

const STEPS: { dir: Dir; label: string }[] = [
  { dir: 'right', label: 'VPRAVO' },
  { dir: 'left', label: 'VĽAVO' },
  { dir: 'up', label: 'HORE' },
  { dir: 'down', label: 'DOLE' },
];
const PREP_MS = 3000;
const REC_MS = 6000;

type Props = { leftHand: boolean; onClose: () => void };

export function AxisCalibrationModal({ leftHand, onClose }: Props) {
  const { handMode } = useCalibration();
  const [phase, setPhase] = useState<'intro' | 'run' | 'result'>('intro');
  const [stepIdx, setStepIdx] = useState(0);
  const [stage, setStage] = useState<'prep' | 'rec'>('prep');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [result, setResult] = useState<ProfileFit | null>(null);
  const [hand, setHand] = useState<HandKey>(handMode === 'dual' ? 'right' : leftHand ? 'left' : 'right');
  const [live, setLive] = useState(false);

  const dataRef = useRef<Record<Dir, Vec3[]>>({ right: [], left: [], up: [], down: [] });
  const rollsRef = useRef<number[]>([]); // uhol krútenia rukavice pri každom kroku (°)
  const ctrlRef = useRef<SingleIMUController | null>(null);
  const recRef = useRef<{ dir: Dir | null; needCenter: boolean }>({ dir: null, needCenter: false });
  const lastSampleRef = useRef(0);
  const handRef = useRef<HandKey>(hand);
  handRef.current = hand;

  // vzorky z rukavice -> náklon bez akýchkoľvek korekcií (gain 1, bez otočenia/shear)
  useEffect(() => {
    const c = new SingleIMUController();
    c.gyroDivisor = 1;
    c.linearTilt = true;
    c.angleTilt = true;
    c.precisionScale = 1;
    c.tiltRotationDeg = 0;
    c.shearUp = 0;
    c.shearRight = 0;
    c.posGain = 1;
    ctrlRef.current = c;
    let lastTs = 0;
    const onSample = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (!d) return;
      if (handMode === 'dual' && d.hand && d.hand !== 'right') return;
      const detected: HandKey | null = d.hand === 'left' ? 'left' : d.hand === 'right' ? 'right' : null;
      if (detected && detected !== handRef.current && recRef.current.dir === null) setHand(detected);
      const now = Date.now();
      const dt = Math.max(1, now - (lastTs || now)) / 1000;
      lastTs = now;
      lastSampleRef.current = now;
      const rec = recRef.current;
      if (rec.needCenter) {
        c.recenter(d.imu || {});
        rec.needCenter = false;
        if (rec.dir) rollsRef.current.push(c.restRollDeg);
      }
      const out = c.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);
      if (rec.dir) dataRef.current[rec.dir].push([out.rv[0], out.rv[1], out.rv[2]]);
    };
    window.addEventListener('imu-sample', onSample as EventListener);
    const t = window.setInterval(() => setLive(Date.now() - lastSampleRef.current < 1500), 500);
    return () => {
      window.removeEventListener('imu-sample', onSample as EventListener);
      window.clearInterval(t);
    };
  }, [handMode]);

  // prehrávanie krokov: 3 s príprava (ruka v pokoji, nulový náklon), 6 s záznam
  useEffect(() => {
    if (phase !== 'run') return;
    let cancelled = false;
    const timers: number[] = [];
    const runStep = (i: number) => {
      if (cancelled) return;
      if (i >= STEPS.length) {
        recRef.current.dir = null;
        const rolls = rollsRef.current.map((r) => (r * Math.PI) / 180);
        const meanRoll = rolls.length
          ? (Math.atan2(rolls.reduce((a, r) => a + Math.sin(r), 0), rolls.reduce((a, r) => a + Math.cos(r), 0)) * 180) / Math.PI
          : 0;
        const fit = fitAxisProfile(dataRef.current, meanRoll);
        setResult(fit);
        setPhase('result');
        return;
      }
      setStepIdx(i);
      setStage('prep');
      recRef.current = { dir: null, needCenter: true };
      const t0 = Date.now();
      const tick = window.setInterval(() => {
        const el = Date.now() - t0;
        setSecondsLeft(Math.max(0, Math.ceil((PREP_MS - el) / 1000)));
      }, 200);
      timers.push(window.setTimeout(() => {
        window.clearInterval(tick);
        if (cancelled) return;
        recRef.current = { dir: STEPS[i].dir, needCenter: true }; // nula = pokojová poloha na začiatku záznamu
        setStage('rec');
        const r0 = Date.now();
        const tick2 = window.setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((REC_MS - (Date.now() - r0)) / 1000))), 200);
        timers.push(window.setTimeout(() => {
          window.clearInterval(tick2);
          runStep(i + 1);
        }, REC_MS));
      }, PREP_MS));
    };
    runStep(0);
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const start = () => {
    dataRef.current = { right: [], left: [], up: [], down: [] };
    rollsRef.current = [];
    setResult(null);
    setStepIdx(0);
    setPhase('run');
  };

  const btn = 'px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors';
  const primary = 'px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors';
  const saved = loadProfiles(hand);
  const fmtProfile = (p: { roll: number; gains: { right: number; left: number; up: number; down: number } }) =>
    `poloha ${p.roll.toFixed(0)}°, dosah → ${p.gains.right.toFixed(2)} ← ${p.gains.left.toFixed(2)} ↑ ${p.gains.up.toFixed(2)} ↓ ${p.gains.down.toFixed(2)}`;

  return (
    <div className="fixed inset-0 z-[9500] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-xl p-8">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="text-2xl font-semibold text-slate-800">Kalibrácia osí – {hand === 'right' ? 'pravá' : 'ľavá'} ruka</h2>
          <button className={btn} onClick={onClose}>Zavrieť</button>
        </div>

        {phase === 'intro' && (
          <>
            <p className="text-slate-600 mb-3">
              Hra si prispôsobí smery ovládania vašej ruke v AKTUÁLNEJ polohe rukavice. Ak rukavicu otočíte (napr. o 90°),
              kalibrujte znova v tejto polohe. Štyrikrát (vpravo, vľavo, hore, dole) pohnete rukou z pohodlnej polohy a späť.
              Pri každom kroku najprv 3 s pokoj, potom 6 s pohybu – opakujte ho viackrát.
            </p>
            <p className="text-slate-600 mb-3">Pohybujte rukou tak, ako pri ovládaní hry (kulak stisnutý je v poriadku, ale nie je nutný).</p>
            <p className="text-sm text-slate-500 mb-4">
              {saved.length
                ? `Uložené polohy rukavice: ${saved.map(fmtProfile).join(' | ')}`
                : 'Žiadny uložený profil – platí predvolené ovládanie (kalibrovaná je len základná poloha).'}
            </p>
            <div className="flex gap-2 items-center flex-wrap">
              <button className={primary} onClick={start} disabled={!live}>Začať</button>
              {hasProfiles(hand) && (
                <button className={btn} onClick={() => { clearProfiles(hand); onClose(); }}>Obnoviť predvolené</button>
              )}
              <span className={`text-sm px-2.5 py-1 rounded-full ${live ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
                {live ? 'Rukavica aktívna' : 'Čakám na rukavicu'}
              </span>
            </div>
          </>
        )}

        {phase === 'run' && (
          <div className="text-center py-4">
            <div className="text-sm text-slate-500 mb-2">Krok {stepIdx + 1} / {STEPS.length}</div>
            <div className="text-5xl font-bold text-slate-800 mb-3">{STEPS[stepIdx].label}</div>
            {stage === 'prep' ? (
              <p className="text-xl text-amber-600">Pripravte sa, ruka v pokoji… {secondsLeft}</p>
            ) : (
              <p className="text-xl text-green-600 font-semibold">POHYB! Z pokoja {STEPS[stepIdx].label.toLowerCase()} a späť… {secondsLeft}</p>
            )}
          </div>
        )}

        {phase === 'result' && result && (
          <>
            {result.ok && result.profile ? (
              <>
                <p className="text-slate-700 mb-2">Naučené pre túto polohu rukavice: <strong>{fmtProfile(result.profile)}</strong></p>
                <p className="text-sm text-slate-500 mb-4">
                  Rozlíšenie smerov: vodorovne {result.separationDeg?.horizontal.toFixed(0)}°, zvisle {result.separationDeg?.vertical.toFixed(0)}°.
                  Profil sa použije vždy, keď po stisku všetkých prstov bude rukavica v podobnej polohe (±40°).
                </p>
                <div className="flex gap-2 flex-wrap">
                  <button className={primary} onClick={() => { saveProfile(hand, result.profile!); onClose(); }}>Uložiť a použiť</button>
                  <button className={btn} onClick={start}>Zopakovať</button>
                  <button className={btn} onClick={onClose}>Zahodiť</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-red-600 mb-4">{result.reason ?? 'Kalibrácia sa nepodarila.'} Skúste pohyby väčšie a zopakujte.</p>
                <div className="flex gap-2"><button className={primary} onClick={start}>Zopakovať</button><button className={btn} onClick={onClose}>Zavrieť</button></div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
