import { useEffect, useRef } from 'react';
import SingleIMUController from '../utils/imuController';
import { applyAxisCorr } from '../utils/axisCalibration';
import { pressedCountOf } from '../utils/fingerCalibration';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';

// Kurzor rukavice pre MENU (výber ruky a výber hry).
// Je úplne oddelený od ovládania v hrách: má vlastný SingleIMUController, vlastné počúvanie
// 'imu-sample' a nikam nezapisuje stav hry. Klik = stisk všetkých 5 prstov.

const CLICK_FINGERS = 5;        // koľko prstov musí byť stlačených pre klik
const SCREEN_GAIN = 1.0;        // citlivosť: 1 = plný náklon pokryje celú obrazovku
// Vyhladenie: kontrolér má One Euro filter (ako v Pentomine) – v pokoji silno vyhladí chvenie, pri pohybe takmer bez oneskorenia.
// Predtým tu boli dve EMA za sebou (kontrolér 0,28 + obrazovka 0,35 ≈ 40 ms oneskorenia), kurzor preto za rukou "ťahal".
const TILT_DEADZONE = 0.035;    // rad (~2°); predvolených 0,05 bolo bez One Euro filtra nutných proti túlaniu kurzora v pokoji
const HISTORY_MS = 400;         // história polohy: klik sa berie z polohy PRED stlačením (stisk hýbe rukou)
const CLICK_LOOKBACK_MS = 250;
const SAMPLE_TIMEOUT_MS = 1500; // bez vzoriek dlhšie ako toto kurzor skryjeme
const CALIB_HOLD_MS = 3000;     // všetky prsty stisnuté a bez pohybu takto dlho = nový nulový bod ruky a kurzor do stredu, bez kliku
const CALIB_STILL_PX = 40;      // 'bez pohybu': cieľ kurzora sa za túto dobu nesmie pohnúť o viac ako toľko px
const CALIB_SHOW_MS = 500;      // priebeh vynulovania sa zobrazí až po tejto dobe držania (kratší stisk je len klik)
// Rovnako ako v Pentomine a v kreslení: uvoľnenie prstov samo nakloní rukavicu, kurzor preto chvíľu stojí a potom sa nulový bod
// vynuluje v polohe otvorenej ruky (počas stisku kurzor stojí, takže by inak po uvoľnení skočil tam, kam sa ruka medzitým pohla).
const RELEASE_FREEZE_MS = 350;
// Výpadok jedného prsta (4 z 5) sa za uvoľnenie považuje až po tomto čase (pohyb zápästia mení napätie tenzometrov).
const GRIP_DROPOUT_MS = 250;
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
  const neutralRef = useRef<any>(null);
  neutralRef.current = neutral;

  // Kurzor je relatívny (ako v skúške kreslenia): pri každom vstupe na obrazovku sa náklon vynuluje v mieste kurzora, takže
  // nezáleží na tom, v akej polohe je ruka voči kalibrácii. Kalibrácia slúži len ako referencia na rozpoznanie otočenej rukavice.
  useEffect(() => {
    if (!ctrlRef.current) {
      const c = new SingleIMUController();
      c.gyroDivisor = 1;
      c.linearTilt = true; // diagonály bez blokovania osí
      c.angleTilt = true; // lineárny uhol náklonu (bez saturácie/obratu pri veľkom náklone)
      c.precisionScale = 1; // stisk prstov nesmie meniť citlivosť kurzora
      c.oneEuro = true;
      c.tiltDeadzone = TILT_DEADZONE;
      // bez saturácie: pri okraji sa dá kurzor vždy odtiahnuť späť. Mŕtva zóna ostáva (predvolených 0,05 rad): bez nej sa kurzor
      // v pokoji "túla" (v zázname ~110 px pri pokoji, s ňou ~12 px) – kvôli chveniu ruky
      c.autoReach = true; // dosah výchylky sa vyrovná medzi smermi a medzi polohami
      c.autoAxes = true; // osi otočenej polohy sa spresňujú z ťahov ruky
      // otočená poloha (kosť na 90°): zvislé pohyby boli slabšie než vodorovné a hore kurzor ušiel doľava. Laditeľné v konzole:
      // localStorage.setItem('rehapiano.menuRolled', '{"up":1.4,"down":1.7,"shear":-0.2}') a obnoviť stránku
      c.rolledTune = { up: 1.4, down: 1.7, shear: -0.2 };
      try {
        const raw = localStorage.getItem('rehapiano.menuRolled');
        if (raw) c.rolledTune = { ...c.rolledTune, ...JSON.parse(raw) };
      } catch { /* ignore */ }
      c.tiltMax = 4;
      c.posLimit = 4;
      ctrlRef.current = c;
    }
    if (neutral) ctrlRef.current.setReferenceQuat(neutral);
    needRecenterRef.current = true;
  }, [screen, neutral]);

  useEffect(() => {

    const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const anchor = { x: pos.x, y: pos.y }; // bod, v ktorom bol kurzor pri poslednom vynulovaní náklonu
    const history: { t: number; x: number; y: number }[] = [];
    let wasGrip = false;
    let gripSince = 0;
    let gripStill = { x: 0, y: 0 };
    let clickTarget: HTMLElement | null = null;
    let calibrated = false;       // vynulovanie sa už stalo v tomto stisku: po uvoľnení nebude klik
    let calibDoneTimer = 0;
    let lastSampleTs = 0;
    let hovered: Element | null = null;
    let gripLostAt = 0;
    let releaseUntil = 0;         // kurzor stojí po uvoľnení prstov do tohto času (0 = nie)
    let lastNx = 0, lastNy = 0;   // náklon z poslednej vzorky (px), na dorovnanie kotvy bez skoku

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

    // Vykresľovanie raz za snímku obrazovky (vzorky chodia ~125/s, displej má 60 Hz): poloha, zvýraznenie tlačidla pod kurzorom
    // (elementFromPoint je drahé) a atribúty sa menia len pri zmene, aby sa štýly neprepočítavali pri každej vzorke.
    const view = { grip: false, calib: 0, hover: false };
    const shown = { x: NaN, y: NaN, grip: '', calib: '', calibrating: '', visible: false };
    let raf = 0;
    const frame = () => {
      raf = 0;
      const el = elRef.current;
      if (!el) return;
      if (view.hover) setHover(targetAt(pos.x, pos.y));
      if (pos.x !== shown.x || pos.y !== shown.y) {
        el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        shown.x = pos.x; shown.y = pos.y;
      }
      if (!shown.visible) { el.style.opacity = '1'; shown.visible = true; }
      const g = view.grip ? 'true' : 'false';
      if (g !== shown.grip) { el.dataset.grip = g; shown.grip = g; }
      const cp = view.calib.toFixed(3);
      if (cp !== shown.calib) { el.style.setProperty('--calib', cp); shown.calib = cp; }
      const cing = view.calib > 0 ? 'true' : 'false';
      if (cing !== shown.calibrating) { el.dataset.calibrating = cing; shown.calibrating = cing; }
    };
    const draw = (grip: boolean, calibProg = 0, hover = false) => {
      view.grip = grip; view.calib = calibProg; view.hover = hover;
      if (!raf) raf = requestAnimationFrame(frame);
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

      if (neutralRef.current) ctrl.setReferenceQuat(neutralRef.current);
      if (needRecenterRef.current) {
        ctrl.recenter(d.imu || {});
        needRecenterRef.current = false;
        anchor.x = pos.x; anchor.y = pos.y;
      }

      const left = p.handMode === 'dual' ? false : d.hand === 'left' ? true : d.hand === 'right' ? false : p.leftHand;
      applyAxisCorr(ctrl, left ? 'left' : 'right');
      const seqBefore = ctrl.recenterSeq;
      const out = ctrl.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);

      if (ctrl.recenterSeq !== seqBefore) { anchor.x = pos.x; anchor.y = pos.y; } // kontrolér sám vynuloval náklon: kurzor ostane na mieste

      // Stisk prstov (rovnaké prahy ako v hrách); krátky výpadok jedného prsta stisk neruší
      const pressed = pressedCountOf(d, cfg); // kalibrované prahy prstov (detail.fingers z WebSocketStatus)
      let grip = pressed >= CLICK_FINGERS;
      if (grip) gripLostAt = 0;
      else if (wasGrip && pressed === CLICK_FINGERS - 1) {
        if (!gripLostAt) gripLostAt = now;
        if (now - gripLostAt < GRIP_DROPOUT_MS) grip = true;
      } else gripLostAt = 0;

      // Zrkadlenie osí rovnaké ako pri ovládaní v hrách (ľavá: Y obrátené, pravá: X obrátené)
      const nx = (left ? out.posNorm.x : -out.posNorm.x) * SCREEN_GAIN;
      const ny = (left ? -out.posNorm.y : out.posNorm.y) * SCREEN_GAIN;
      lastNx = nx * (window.innerWidth / 2); lastNy = ny * (window.innerHeight / 2);
      const syncAnchor = () => { anchor.x = pos.x - lastNx; anchor.y = pos.y - lastNy; }; // kurzor ostane, kde je
      let tx = anchor.x + lastNx;
      let ty = anchor.y + lastNy;
      // pri okraji obrazovky sa kotva posunie s kurzorom, aby sa nenahromadil náklon, ktorý by kurzor držal pri stene
      const cx = Math.max(0, Math.min(window.innerWidth - 1, tx));
      const cy = Math.max(0, Math.min(window.innerHeight - 1, ty));
      anchor.x += cx - tx; anchor.y += cy - ty;
      tx = cx; ty = cy;

      let calibProg = 0;
      let hover = false;
      if (!grip) {
        // klik sa robí až po uvoľnení (krátky stisk); dlhý stisk bez pohybu je vynulovanie polohy
        if (wasGrip && !calibrated && clickTarget && now - gripSince < CALIB_HOLD_MS) clickTarget.click();
        clickTarget = null;
        if (wasGrip) releaseUntil = now + RELEASE_FREEZE_MS;
        if (releaseUntil) {
          // kurzor stojí; na konci nový nulový bod v polohe otvorenej ruky (otočená ruka: len dorovnanie kotvy, ako v kreslení)
          if (now >= releaseUntil) {
            releaseUntil = 0;
            if (!out.rolled) { ctrl.recenter(d.imu || {}); anchor.x = pos.x; anchor.y = pos.y; }
            else syncAnchor();
          }
        } else {
          pos.x = tx; pos.y = ty;
        }
        history.push({ t: now, x: pos.x, y: pos.y });
        while (history.length && now - history[0].t > HISTORY_MS) history.shift();
        hover = true;
      } else if (!wasGrip) {
        if (releaseUntil) { releaseUntil = 0; syncAnchor(); } // nový stisk ešte počas zmrazenia
        // Hrana stisku = cieľ je pod polohou spred CLICK_LOOKBACK_MS (kým sa ruka nerozhýbala stiskom)
        const ref = history.find((h) => now - h.t <= CLICK_LOOKBACK_MS) ?? history[history.length - 1];
        if (ref) { pos.x = ref.x; pos.y = ref.y; }
        clickTarget = targetAt(pos.x, pos.y);
        setHover(clickTarget);
        gripSince = now; gripStill = { x: tx, y: ty }; calibrated = false;
      } else if (!calibrated) {
        // držanie bez pohybu: ak sa ruka pohla, odmeriavanie začína odznova
        if (Math.hypot(tx - gripStill.x, ty - gripStill.y) > CALIB_STILL_PX) { gripSince = now; gripStill = { x: tx, y: ty }; }
        const held = now - gripSince;
        if (held >= CALIB_HOLD_MS) {
          ctrl.recenter(d.imu || {});
          // nový nulový bod v tejto polohe ruky a kurzor do stredu obrazovky
          pos.x = window.innerWidth / 2; pos.y = window.innerHeight / 2;
          anchor.x = pos.x; anchor.y = pos.y;
          history.length = 0;
          clickTarget = null; calibrated = true;
          setHover(null);
          const el = elRef.current;
          if (el) {
            el.dataset.calibDone = 'true';
            window.clearTimeout(calibDoneTimer);
            calibDoneTimer = window.setTimeout(() => { el.dataset.calibDone = 'false'; }, 900);
          }
        } else if (held > CALIB_SHOW_MS) {
          calibProg = held / CALIB_HOLD_MS;
        }
      }
      wasGrip = grip;
      draw(grip, calibProg, hover);
    };

    // skrytie kurzora, keď prestanú chodiť vzorky
    const idle = window.setInterval(() => {
      if (lastSampleTs && Date.now() - lastSampleTs > SAMPLE_TIMEOUT_MS && elRef.current) {
        elRef.current.style.opacity = '0';
        shown.visible = false;
        setHover(null);
      }
    }, 500);

    window.addEventListener('imu-sample', onSample as EventListener);
    return () => {
      window.removeEventListener('imu-sample', onSample as EventListener);
      window.clearInterval(idle);
      window.clearTimeout(calibDoneTimer);
      if (raf) cancelAnimationFrame(raf);
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
      <div className="imu-menu-cursor__calib" />
      <div className="imu-menu-cursor__ring" />
      <div className="imu-menu-cursor__dot" />
    </div>
  );
}
