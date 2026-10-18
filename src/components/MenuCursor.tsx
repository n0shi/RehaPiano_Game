import { useEffect, useRef } from 'react';
import SingleIMUController, { TILT_ROTATION_RIGHT_DEG, SHEAR_UP_RIGHT_HAND, SHEAR_RIGHT_RIGHT_HAND } from '../utils/imuController';
import { normalizeAdc } from '../utils/imuNormalize';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';

// Kurzor rukavice pre MENU (výber ruky a výber hry).
// Je úplne oddelený od ovládania v hrách: má vlastný SingleIMUController, vlastné počúvanie
// 'imu-sample' a nikam nezapisuje stav hry. Klik = stisk všetkých 5 prstov.

const CLICK_FINGERS = 5;        // koľko prstov musí byť stlačených pre klik
const SCREEN_GAIN = 1.0;        // citlivosť: 1 = plný náklon pokryje celú obrazovku
const CURSOR_SMOOTH = 0.35;     // dodatočné vyhladenie kurzora na obrazovke (0..1, menej = plynulejšie)
const HISTORY_MS = 400;         // história polohy: klik sa berie z polohy PRED stlačením (stisk hýbe rukou)
const CLICK_LOOKBACK_MS = 250;
const SAMPLE_TIMEOUT_MS = 1500; // bez vzoriek dlhšie ako toto kurzor skryjeme
const HOVER_ATTR = 'data-imu-hover';

type Props = {
  screen: 'menu' | 'gameSelection';
  leftHand: boolean;
};

export function MenuCursor({ screen, leftHand }: Props) {
  const { neutralQuat, neutralQuats, handMode, showCalibrationModal } = useCalibration();
  const cfg = useConfig() as any;
  const elRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<SingleIMUController | null>(null);
  const needRecenterRef = useRef(true);
  const propsRef = useRef({ screen, leftHand, handMode, showCalibrationModal });
  propsRef.current = { screen, leftHand, handMode, showCalibrationModal };

  const dual = handMode === 'dual';
  const neutral = dual ? neutralQuats.right : neutralQuat;

  // Neutrálna poloha: v menu výberu hry (po kalibrácii) použijeme kalibráciu,
  // inak sa kurzor sám vycentruje na prvú vzorku.
  useEffect(() => {
    if (!ctrlRef.current) {
      const c = new SingleIMUController();
      c.gyroDivisor = 1;
      c.linearTilt = true; // diagonály bez blokovania osí
      c.angleTilt = true; // lineárny uhol náklonu (bez saturácie/obratu pri veľkom náklone)
      c.precisionScale = 1; // stisk prstov nesmie meniť citlivosť kurzora
      ctrlRef.current = c;
    }
    if (screen === 'gameSelection' && neutral) {
      ctrlRef.current.calibrateNeutral(neutral);
      ctrlRef.current.resetPosition();
      needRecenterRef.current = false;
    } else {
      needRecenterRef.current = true;
    }
  }, [screen, neutral]);

  useEffect(() => {
    const rawThr = cfg?.TENSOMETER_RAW_THRESHOLD ?? 2000;
    const normThr = cfg?.TENSOMETER_NORM_THRESHOLD ?? 12;

    const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const history: { t: number; x: number; y: number }[] = [];
    let wasGrip = false;
    let lastSampleTs = 0;
    let hovered: Element | null = null;

    const setHover = (el: Element | null) => {
      if (el === hovered) return;
      hovered?.removeAttribute(HOVER_ATTR);
      hovered = el;
      hovered?.setAttribute(HOVER_ATTR, 'true');
    };

    const targetAt = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y);
      const t = el?.closest('button, a, [role="button"]') as HTMLElement | null;
      if (!t || (t as HTMLButtonElement).disabled) return null;
      return t;
    };

    const draw = (grip: boolean) => {
      const el = elRef.current;
      if (!el) return;
      el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      el.style.opacity = '1';
      el.dataset.grip = grip ? 'true' : 'false';
    };

    const onSample = (ev: Event) => {
      const p = propsRef.current;
      if ((window as any).__modalOpen || p.showCalibrationModal) return;
      const d = (ev as CustomEvent).detail;
      if (!d) return;
      // v režime dvoch rúk riadi kurzor len pravá ruka
      if (p.handMode === 'dual' && d.hand && d.hand !== 'right') return;
      const ctrl = ctrlRef.current;
      if (!ctrl) return;

      const now = Date.now();
      const dt = Math.max(1, now - (lastSampleTs || now)) / 1000;
      lastSampleTs = now;

      if (needRecenterRef.current) {
        ctrl.recenter(d.imu || {});
        needRecenterRef.current = false;
      }

      const left = p.handMode === 'dual' ? false : d.hand === 'left' ? true : d.hand === 'right' ? false : p.leftHand;
      ctrl.tiltRotationDeg = left ? 0 : TILT_ROTATION_RIGHT_DEG;
      ctrl.shearUp = left ? 0 : SHEAR_UP_RIGHT_HAND;
      ctrl.shearRight = left ? 0 : SHEAR_RIGHT_RIGHT_HAND;
      const out = ctrl.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);

      // Stisk prstov (rovnaké prahy ako v hrách)
      const adc: number[] = Array.isArray(d.adc) ? d.adc : [];
      const pressed = adc.slice(1, 6).filter((v) => {
        const raw = Math.abs(Number(v) || 0);
        return raw > rawThr || normalizeAdc(raw) > normThr;
      }).length;
      const grip = pressed >= CLICK_FINGERS;

      // Zrkadlenie osí rovnaké ako pri ovládaní v hrách (ľavá: Y obrátené, pravá: X obrátené)
      const nx = (left ? out.posNorm.x : -out.posNorm.x) * SCREEN_GAIN;
      const ny = (left ? -out.posNorm.y : out.posNorm.y) * SCREEN_GAIN;
      const tx = Math.max(0, Math.min(window.innerWidth - 1, ((nx + 1) / 2) * window.innerWidth));
      const ty = Math.max(0, Math.min(window.innerHeight - 1, ((ny + 1) / 2) * window.innerHeight));

      if (!grip) {
        pos.x += CURSOR_SMOOTH * (tx - pos.x);
        pos.y += CURSOR_SMOOTH * (ty - pos.y);
        history.push({ t: now, x: pos.x, y: pos.y });
        while (history.length && now - history[0].t > HISTORY_MS) history.shift();
        setHover(targetAt(pos.x, pos.y));
      } else if (!wasGrip) {
        // Hrana stisku = klik na polohu spred CLICK_LOOKBACK_MS (kým sa ruka nerozhýbala stiskom)
        const ref = history.find((h) => now - h.t <= CLICK_LOOKBACK_MS) ?? history[history.length - 1];
        if (ref) { pos.x = ref.x; pos.y = ref.y; }
        const t = targetAt(pos.x, pos.y);
        setHover(t);
        t?.click();
      }
      wasGrip = grip;
      draw(grip);
    };

    // skrytie kurzora, keď prestanú chodiť vzorky
    const idle = window.setInterval(() => {
      if (lastSampleTs && Date.now() - lastSampleTs > SAMPLE_TIMEOUT_MS && elRef.current) {
        elRef.current.style.opacity = '0';
        setHover(null);
      }
    }, 500);

    window.addEventListener('imu-sample', onSample as EventListener);
    return () => {
      window.removeEventListener('imu-sample', onSample as EventListener);
      window.clearInterval(idle);
      setHover(null);
    };
  }, [cfg]);

  return (
    <div
      ref={elRef}
      aria-hidden
      className="imu-menu-cursor"
      style={{ opacity: 0, transform: `translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px)` }}
    >
      <div className="imu-menu-cursor__ring" />
      <div className="imu-menu-cursor__dot" />
    </div>
  );
}
