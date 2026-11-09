import { useEffect, useRef, useState, useCallback } from 'react';
import SingleIMUController from '../utils/imuController';
import { applyAxisCorr } from '../utils/axisCalibration';
import { pressedCountOf } from '../utils/fingerCalibration';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';
import { MenuCursor } from './MenuCursor';
import { AxisCalibrationModal } from './AxisCalibrationModal';

// Voliteľné okno "Skúška kreslenia": hráč vyberie tvar, stisne všetky prsty (pero dole)
// a rukavicou ho obkreslí. Slúži na vyskúšanie ovládania a presnosti pohybu.
// Je úplne oddelené od hier – vlastný SingleIMUController a vlastné počúvanie 'imu-sample'.

type ShapeKey = 'triangle' | 'circle' | 'square' | 'rhombus';
type Pt = [number, number];

const SHAPES: { key: ShapeKey; label: string; glyph: string }[] = [
  { key: 'triangle', label: 'Trojuholník', glyph: '△' },
  { key: 'circle', label: 'Kruh', glyph: '○' },
  { key: 'square', label: 'Štvorec', glyph: '□' },
  { key: 'rhombus', label: 'Kosoštvorec', glyph: '◇' },
];

const PEN_FINGERS = 5;          // stisnuté prsty = pero dole
const CURSOR_SMOOTH = 0.35;
// Otočená ruka ("kosť") mala navyše One Euro filter (0,9 Hz, beta 0,006). Na zázname kruhu (pose_20261102) tremor takmer neznížil
// (3,00 vs 3,01 px), ale pridal oneskorenie 13 px (bez neho 5 px) a nerovnomernú rýchlosť kurzora voči ruke (33 % vs 11 %): pri pomalšom
// úseku kruhu kurzor zaostal a pri zrýchlení ho prudko dobehol. Preto sa už nepoužíva; ostáva len CURSOR_SMOOTH ako v zvyčajnej polohe.
// Úrovne: ten istý tvar v troch veľkostiach (veľkosť = podiel min(šírka, výška) plátna). Väčší tvar sa kreslí ťažšie.
const LEVELS = [
  { level: 1, label: 'Úroveň 1', hint: 'malý', scale: 0.16 },
  { level: 2, label: 'Úroveň 2', hint: 'stredný', scale: 0.24 },
  { level: 3, label: 'Úroveň 3', hint: 'veľký', scale: 0.32 },
];
const REF_SCALE = 0.32;         // veľkosť, pre ktorú sú nastavené tolerancie hodnotenia
const MIN_STROKE_POINTS = 20;
const COVER_TOL = 0.18;         // tolerancia pokrytia obrysu (v jednotkách tvaru)
const SAMPLE_TIMEOUT_MS = 1500;
const DATA_LOSS_MS = 2000;      // (stream sa každých ~40 s na ~1 s preruší a znovu pripojí, preto nie menej)  bez vzoriek dlhšie ako toto sa rozpracovaný ťah zahodí a pred ďalším treba uvoľniť prsty
const CURSOR_COLOR = '#17647d';
const CURSOR_GRIP_COLOR = '#FF9900';
// Zosilenie náklonu -> pohyb kurzora. Namerané: bežný náklon ruky dá len ~±0,5 rozsahu, takže pri 1,0 sa nedalo dosiahnuť
// spodnú tretinu (a okraje) plátna; pri 2,0 stačí polovičný náklon na okraj.
const DRAW_GAIN = 1.0;       // pri posGain 1,5 a krivke odozvy 0,5 (rovnaké ako v pentamine) dá bežný náklon podobný dosah ako dovtedy
const HAND_POS_GAIN = 1;
const HAND_RESPONSE_CURVE = 0;
const HOME_ZONE = 0.22;      // vzdialenosť od kalibračnej (normálnej) polohy ruky, do ktorej sa ruka považuje za 'doma'
const CALIB_HOLD_MS = 3000;     // všetky prsty stisnuté a bez pohybu takto dlho = nový nulový bod ruky a kurzor do stredu (3 s, aby sa nezamenilo s bodkou/ťahom)
const CALIB_SHOW_MS = 500;      // priebeh vynulovania sa ukazuje až po tomto čase
const CALIB_MAX_STROKE_PX = 45; // ťah, ktorý je väčší, sa nikdy nevynuluje (len náhodná bodka)
const CALIB_STILL_PX = 30;      // 'bez pohybu': kurzor sa za túto dobu nesmie pohnúť o viac ako toľko px
const PEN_SETTLE_MS = 180;      // po stisku prstov chvíľu počkaj (ruka sa pri stisku hýbe), potom vynuluj náklon a spusti pero; kurzor medzitým stojí
// Rovnako ako v Pentomine: stisk aj uvoľnenie prstov samo nakloní rukavicu (3–7°). Pri stisku to pohltí PEN_SETTLE_MS, pri uvoľnení
// kurzor chvíľu stojí a potom sa nulový bod vynuluje v polohe otvorenej ruky – kurzor po zdvihnutí pera neodskočí.
const RELEASE_FREEZE_MS = 350;
const RELEASE_LOOKBACK_MS = 80; // koniec ťahu: body z posledných 80 ms pred uvoľnením sú už trhnutie od otvárania prstov, nekreslia sa
// Výpadok jedného prsta (4 z 5) sa za uvoľnenie považuje až po tomto čase: pohyb zápästia mení napätie tenzometrov a ťah sa trhal na kúsky.
const GRIP_DROPOUT_MS = 250;

/** Obrys tvaru v súradniciach -1..1, hustý zatvorený polygón. */
function outline(key: ShapeKey): Pt[] {
  if (key === 'circle') {
    return Array.from({ length: 240 }, (_, i) => {
      const a = (i / 240) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)] as Pt;
    });
  }
  const verts: Record<Exclude<ShapeKey, 'circle'>, Pt[]> = {
    triangle: [[0, -1], [0.95, 0.7], [-0.95, 0.7]],
    square: [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]],
    rhombus: [[0, -1], [0.75, 0], [0, 1], [-0.75, 0]],
  };
  const v = verts[key];
  const pts: Pt[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 60)); // rovnaká hustota bodov na všetkých stranách
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return pts;
}

type Result = { score: number; accuracy: number; coverage: number; range: number };

// tolScale: tolerancie sú v jednotkách tvaru; pri menšom tvare sa zväčšia, aby zodpovedali rovnakej odchýlke v pixeloch
function evaluate(trail: Pt[], shape: Pt[], tolScale = 1): Result {
  let sum = 0;
  for (const p of trail) {
    let best = Infinity;
    for (const q of shape) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
    sum += best;
  }
  const meanDist = sum / trail.length;
  let covered = 0;
  for (const q of shape) {
    for (const p of trail) {
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < COVER_TOL * tolScale) { covered++; break; }
    }
  }
  const coverage = covered / shape.length;
  const accuracy = Math.max(0, 1 - meanDist / (0.35 * tolScale));
  const xs = trail.map((p) => p[0]), ys = trail.map((p) => p[1]);
  const range = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  return { score: Math.round(100 * accuracy * coverage), accuracy, coverage, range };
}

type Props = { leftHand: boolean; onClose: () => void };

export function ShapeTraceModal({ leftHand, onClose }: Props) {
  const { handMode, neutralQuat, neutralQuats } = useCalibration();
  const cfg = useConfig() as any;
  const [phase, setPhase] = useState<'pick' | 'draw'>('pick');
  const [shapeKey, setShapeKey] = useState<ShapeKey>('circle');
  const [level, setLevel] = useState(3);
  const [result, setResult] = useState<Result | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [gloveLive, setGloveLive] = useState(false);
  const [axisCalOpen, setAxisCalOpen] = useState(false);
  const [home, setHome] = useState<{ x: number; y: number } | null>(null); // odchýlka ruky od normálnej (kalibračnej) polohy
  const homeCtrlRef = useRef<SingleIMUController | null>(null);
  const homeNeutralRef = useRef<any>(null);
  const homeAppliedRef = useRef<any>(null);
  const homeLastRef = useRef(0);
  const axisCalOpenRef = useRef(false);
  axisCalOpenRef.current = axisCalOpen;
  const [calibProg, setCalibProg] = useState(0);      // 0..1 priebeh držania pre vynulovanie polohy
  const calibProgRef = useRef(0);
  const [calibNote, setCalibNote] = useState(false);
  const calibStartRef = useRef(0);
  const calibPosRef = useRef({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<SingleIMUController | null>(null);
  const recenterRef = useRef(true);
  const sizeRef = useRef({ w: 800, h: 600 });
  const cursorRef = useRef({ x: 400, y: 300, vis: false });
  const trailRef = useRef<Pt[]>([]);          // body aktuálneho ťahu v px
  const penRef = useRef(false);
  const rolledRef = useRef(false);
  const anchorRef = useRef({ x: 400, y: 300 }); // bod, v ktorom bol kurzor pri poslednom vynulovaní náklonu
  const gripSinceRef = useRef(0);
  const prevGripRef = useRef(false);
  const gripLostAtRef = useRef(0);
  const releaseUntilRef = useRef(0);          // kurzor stojí po uvoľnení prstov do tohto času (0 = nie)
  const trailTsRef = useRef<number[]>([]);    // časy bodov ťahu z rukavice (na orezanie konca ťahu)
  const armedRef = useRef(false);             // pero sa aktivuje až po uvoľnení prstov (aby klik na tvar nekreslil)
  const shapeRef = useRef<Pt[]>(outline('circle'));
  const scaleRef = useRef(REF_SCALE);
  scaleRef.current = LEVELS.find((l) => l.level === level)!.scale;
  const lastSampleRef = useRef(0);
  const propsRef = useRef({ leftHand, handMode });
  propsRef.current = { leftHand, handMode };
  homeNeutralRef.current = handMode === 'dual' ? neutralQuats.right : neutralQuat;

  const shapePx = useCallback((): Pt[] => {
    const { w, h } = sizeRef.current;
    const s = Math.min(w, h) * scaleRef.current;
    return shapeRef.current.map(([x, y]) => [w / 2 + x * s, h / 2 + y * s] as Pt);
  }, []);

  const render = useCallback(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const { w, h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // cieľový tvar
    const sp = shapePx();
    ctx.lineWidth = 10; ctx.strokeStyle = '#cbd5e1'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    ctx.beginPath();
    sp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.stroke();
    // ťah
    const tr = trailRef.current;
    if (tr.length > 1) {
      ctx.lineWidth = 6; ctx.strokeStyle = '#2563eb'; ctx.lineCap = 'round';
      ctx.beginPath();
      tr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    // kurzor (rovnaký ako v hre Pentomino a Tangram): biely kruh s krížom, pri plnom stisku oranžový
    const c = cursorRef.current;
    if (c.vis) {
      ctx.lineWidth = 3; ctx.strokeStyle = penRef.current ? CURSOR_GRIP_COLOR : CURSOR_COLOR; ctx.lineCap = 'round';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.arc(c.x, c.y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(c.x - 20, c.y); ctx.lineTo(c.x + 20, c.y);
      ctx.moveTo(c.x, c.y - 20); ctx.lineTo(c.x, c.y + 20);
      ctx.stroke();
    }
  }, [shapePx]);

  const finishStroke = useCallback(() => {
    const tr = trailRef.current;
    if (tr.length < MIN_STROKE_POINTS) return;
    const { w, h } = sizeRef.current;
    const s = Math.min(w, h) * scaleRef.current;
    const norm = tr.map(([x, y]) => [(x - w / 2) / s, (y - h / 2) / s] as Pt);
    setResult(evaluate(norm, shapeRef.current, REF_SCALE / scaleRef.current));
  }, []);

  const penDownAt = useCallback((x: number, y: number) => {
    penRef.current = true; setPenDown(true);
    trailRef.current = [[x, y]]; trailTsRef.current = [Date.now()]; setResult(null);
  }, []);
  const penUp = useCallback(() => {
    if (!penRef.current) return;
    penRef.current = false; setPenDown(false);
    finishStroke();
  }, [finishStroke]);

  // veľkosť plátna
  useEffect(() => {
    if (phase !== 'draw') return;
    const fit = () => {
      const wrap = wrapRef.current, cv = canvasRef.current;
      if (!wrap || !cv) return;
      const w = wrap.clientWidth, h = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      sizeRef.current = { w, h };
      cursorRef.current.x = w / 2; cursorRef.current.y = h / 2;
      anchorRef.current = { x: w / 2, y: h / 2 };
      render();
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phase, render]);

  // rukavica -> kurzor a pero
  useEffect(() => {
    if (phase !== 'draw') return;
    if (!ctrlRef.current) {
      const c = new SingleIMUController();
      c.gyroDivisor = 1;
      c.linearTilt = true; // diagonály bez blokovania osí
      c.angleTilt = true;  // lineárny uhol náklonu (bez saturácie/obratu pri veľkom náklone)
      c.precisionScale = 1;
      // rovnaké spracovanie polohy ako v pentamine: One Euro filter + jemnejšia krivka odozvy + zosilenie
      c.oneEuro = false;
      c.responseCurve = HAND_RESPONSE_CURVE;
      c.posGain = HAND_POS_GAIN;
      c.cellHysteresis = 0.3;
      // žiadna mŕtva zóna v strede ani saturácia na okraji: kurzor ide presne za rukou
      c.tiltDeadzone = 0;
      c.autoReach = false; // pri kreslení pevné lineárne zosilnenie: meniace sa zosilnenie podľa smeru pôsobilo ako stena
      c.autoAxes = false; // pri kreslení pevné vstavané osi otočenej polohy: priebežné učenie osí (a osi naučené v menu) kurzorom počas kruhu cukalo
      // otočená poloha (kosť na 90°) – rovnaké doladenie zvislých pohybov ako v menu; zvyčajnú polohu sa netýka. Laditeľné v konzole:
      // localStorage.setItem('rehapiano.drawRolled', '{"up":1.4,"down":1.7,"shear":-0.2}') a obnoviť stránku
      // right: bolo 1,5 (dosah doprava ~1,5x kratší podľa záznamu kruhu), ale zosilňovalo tremor a kompenzáciu predlaktím práve na konci pohybu
      // doprava a kurzor narážal do steny už pri ~2/3 pohybu (nestabilný koniec), preto 1
      c.rolledTune = { up: 1.4, down: 1.7, shear: -0.2, right: 1, left: 1 };
      try {
        const raw = localStorage.getItem('rehapiano.drawRolled');
        if (raw) c.rolledTune = { ...c.rolledTune, ...JSON.parse(raw) };
      } catch { /* ignore */ }
      c.tiltMax = 4;
      c.posLimit = 4;
      ctrlRef.current = c;
    }
    if (!homeCtrlRef.current) {
      const h = new SingleIMUController();
      h.gyroDivisor = 1; h.linearTilt = true; h.angleTilt = true; h.precisionScale = 1;
      homeCtrlRef.current = h;
    }
    recenterRef.current = true;
    armedRef.current = false;
    let lastTs = 0;
    let raf = 0;
    const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

    const onSample = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      const ctrl = ctrlRef.current;
      if (!d || !ctrl) return;
      const p = propsRef.current;
      if (axisCalOpenRef.current) return; // beží kalibrácia osí
      if (p.handMode === 'dual' && d.hand && d.hand !== 'right') return;
      const now = Date.now();
      const dt = Math.max(1, now - (lastTs || now)) / 1000;
      lastTs = now; lastSampleRef.current = now;
      if (homeNeutralRef.current) ctrl.setReferenceQuat(homeNeutralRef.current); // základná poloha z globálnej kalibrácie (podľa nej sa pozná otočená rukavica)
      if (recenterRef.current) {
        ctrl.recenter(d.imu || {}); recenterRef.current = false;
        anchorRef.current = { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
        cursorRef.current.x = anchorRef.current.x; cursorRef.current.y = anchorRef.current.y;
      }
      const left = p.handMode === 'dual' ? false : d.hand === 'left' ? true : d.hand === 'right' ? false : p.leftHand;
      applyAxisCorr(ctrl, left ? 'left' : 'right');
      ctrl.freezePose = penRef.current; // počas ťahu sa nulový bod nesmie meniť (vznikla by neviditeľná stena)
      const seqBefore = ctrl.recenterSeq;
      const out = ctrl.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);
      rolledRef.current = !!out.rolled;
      if (ctrl.recenterSeq !== seqBefore) {
        // kontrolér sám vynuloval náklon (rozpoznal otočenú ruku): kotva ostane pod kurzorom, aby kurzor nevyletel späť k starej kotve
        anchorRef.current = { x: cursorRef.current.x, y: cursorRef.current.y };
      }

      // Ukazovateľ normálnej polohy: odchýlka ruky od kalibračnej polohy (bez vynulovania), v súradniciach obrazovky
      const hc = homeCtrlRef.current, hn = homeNeutralRef.current;
      if (hc && hn) {
        if (homeAppliedRef.current !== hn) { hc.calibrateNeutral(hn); homeAppliedRef.current = hn; }
        applyAxisCorr(hc, left ? 'left' : 'right');
        const ho = hc.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);
        if (now - homeLastRef.current > 100) {
          homeLastRef.current = now;
          setHome({ x: left ? ho.posNorm.x : -ho.posNorm.x, y: left ? -ho.posNorm.y : ho.posNorm.y });
        }
      }

      const pressed = pressedCountOf(d, cfg); // kalibrované prahy prstov (detail.fingers z WebSocketStatus)
      let grip = pressed >= PEN_FINGERS;
      if (grip) gripLostAtRef.current = 0;
      else if (prevGripRef.current && pressed === PEN_FINGERS - 1) {
        if (!gripLostAtRef.current) gripLostAtRef.current = now;
        if (now - gripLostAtRef.current < GRIP_DROPOUT_MS) grip = true; // krátky výpadok jedného prsta: pero ostáva dole
      } else gripLostAtRef.current = 0;
      const releasing = !grip && prevGripRef.current;
      prevGripRef.current = grip;

      const nx = left ? out.posNorm.x : -out.posNorm.x;
      const ny = left ? -out.posNorm.y : out.posNorm.y;
      const { w, h } = sizeRef.current;
      const c = cursorRef.current;
      // Kurzor = kotva + náklon od posledného vynulovania. Každý ťah začína vynulovaním náklonu v bode, kde kurzor stojí,
      // takže sa chyba (drift, zmena držania ruky) nenahromadí; pred ťahom sa kurzor nastaví otvorenou dlaňou.
      const follow = () => {
        const a = anchorRef.current;
        let tx = a.x + nx * (w / 2) * DRAW_GAIN;
        let ty = a.y + ny * (h / 2) * DRAW_GAIN;
        // na okraji plátna sa kotva posunie s kurzorom, aby sa nenahromadil "predpätý" náklon, ktorý by kurzor držal pri okraji
        const cx = Math.max(0, Math.min(w, tx)), cy = Math.max(0, Math.min(h, ty));
        a.x += cx - tx; a.y += cy - ty;
        tx = cx; ty = cy;
        c.x += CURSOR_SMOOTH * (tx - c.x);
        c.y += CURSOR_SMOOTH * (ty - c.y);
        c.vis = true;
      };

      // kotva tak, aby kurzor ostal tam, kde je (pri aktuálnom náklone)
      const syncAnchor = () => { anchorRef.current = { x: c.x - nx * (w / 2) * DRAW_GAIN, y: c.y - ny * (h / 2) * DRAW_GAIN }; };

      // Kurzor sa hýbe vždy. Stisk všetkých prstov = pero dole (kreslenie). Ak sa ovládanie "rozbehne" (kurzor je ďaleko,
      // ruka je v inej polohe), stačí stisnúť všetky prsty a držať ich 3 s bez pohybu: nastaví sa nový nulový bod ruky a kurzor ide do stredu.
      const recalibrate = () => {
        ctrl.recenter(d.imu || {});
        anchorRef.current = { x: w / 2, y: h / 2 }; // nový nulový bod v tejto polohe ruky, kurzor do stredu
        c.x = w / 2; c.y = h / 2;
        releaseUntilRef.current = 0;
        c.vis = true;
        trailRef.current = [];
        if (penRef.current) { penRef.current = false; setPenDown(false); }
        setResult(null);
        armedRef.current = false;     // ďalšie pero až po uvoľnení prstov
        calibStartRef.current = 0;
        setCalibProg(0);
        setCalibNote(true);
        window.setTimeout(() => setCalibNote(false), 1800);
      };

      if (!grip) {
        armedRef.current = true;
        gripSinceRef.current = 0;
        calibStartRef.current = 0;
        if (calibProgRef.current !== 0) { calibProgRef.current = 0; setCalibProg(0); }
        if (releasing) {
          // koniec ťahu: zahoď trhnutie od otvárania prstov a kurzor nechaj na skutočnom konci čiary
          const tr = trailRef.current, ts = trailTsRef.current;
          if (penRef.current && ts.length === tr.length) {
            while (tr.length > MIN_STROKE_POINTS && ts[ts.length - 1] >= now - RELEASE_LOOKBACK_MS) { tr.pop(); ts.pop(); }
            const end = tr[tr.length - 1];
            if (end) { c.x = end[0]; c.y = end[1]; }
          }
          releaseUntilRef.current = now + RELEASE_FREEZE_MS;
        }
        if (penRef.current) penUp();
        if (releaseUntilRef.current) {
          if (now >= releaseUntilRef.current) {
            releaseUntilRef.current = 0;
            // nulový bod v polohe otvorenej ruky (otočená ruka nie – pozri vysvetlenie pri spustení pera nižšie); kurzor ostáva
            if (!rolledRef.current) { ctrl.recenter(d.imu || {}); anchorRef.current = { x: c.x, y: c.y }; }
            else syncAnchor();
          }
          c.vis = true; // kurzor stojí
        } else follow();
      } else {
        if (releaseUntilRef.current) { releaseUntilRef.current = 0; syncAnchor(); } // nový stisk ešte počas zmrazenia: pokračuj bez skoku
        // držanie bez pohybu: ak sa kurzor pohol, odmeriavanie začína odznova
        const cp = calibPosRef.current;
        if (!calibStartRef.current || Math.hypot(c.x - cp.x, c.y - cp.y) > CALIB_STILL_PX) {
          calibStartRef.current = now;
          calibPosRef.current = { x: c.x, y: c.y };
        }
        // vynulovanie len pri "bodke": skutočný ťah (rozsah > CALIB_MAX_STROKE_PX) sa nikdy nepreruší
        const tr = trailRef.current;
        let extent = 0;
        if (tr.length > 1) {
          const xs = tr.map((q) => q[0]), ys = tr.map((q) => q[1]);
          extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        }
        if (extent > CALIB_MAX_STROKE_PX) calibStartRef.current = now;
        const held = now - calibStartRef.current;
        const prog = held > CALIB_SHOW_MS ? Math.min(1, held / CALIB_HOLD_MS) : 0;
        if (Math.abs(prog - calibProgRef.current) > 0.04 || (prog === 0) !== (calibProgRef.current === 0)) {
          calibProgRef.current = prog; setCalibProg(prog);
        }
        if (held >= CALIB_HOLD_MS) {
          recalibrate();
        } else if (penRef.current) {
          follow();
          trailRef.current.push([c.x, c.y]);
          trailTsRef.current.push(now);
        } else if (armedRef.current) {
          // po PEN_SETTLE_MS sa náklon vynuluje v bode kurzora a začne kreslenie
          if (!gripSinceRef.current) gripSinceRef.current = now;
          if (now - gripSinceRef.current >= PEN_SETTLE_MS) {
            if (rolledRef.current) {
              // Otočená ruka: nulu nenastavujeme znova v bode, kde sa začal ťah. Korekcie osí (zosilnenia vpravo/vľavo/hore/dole, skos)
              // sú navrhnuté okolo neutrálnej polohy zápästia; po vynulovaní na začiatku ťahu by sa vzťahovali k inému bodu a pri stisnutých
              // prstoch by sa pohyb správal inak než bez stisku. Kurzor ostane spojitý posunutím kotvy.
              anchorRef.current = { x: c.x - nx * (w / 2) * DRAW_GAIN, y: c.y - ny * (h / 2) * DRAW_GAIN };
            } else {
              ctrl.recenter(d.imu || {});
              anchorRef.current = { x: c.x, y: c.y };
            }
                penDownAt(c.x, c.y);
          }
          // inak kurzor stojí: pohyb ruky pri stisku by posunul začiatok ťahu
        } else {
          follow();
        }
      }
      scheduleRender(); // vzorky chodia ~125/s, plátno sa prekreslí raz za snímku obrazovky
    };

    window.addEventListener('imu-sample', onSample as EventListener);
    const live = window.setInterval(() => {
      const last = lastSampleRef.current;
      setGloveLive(Date.now() - last < SAMPLE_TIMEOUT_MS);
      // Strata dát (rovnako ako v Tangrame): pero nesmie ostať "dole" bez vzoriek; kurzor sa skryje a treba uvoľniť prsty
      if (last && Date.now() - last > DATA_LOSS_MS && (penRef.current || cursorRef.current.vis)) {
        penRef.current = false; setPenDown(false);
        trailRef.current = [];
        armedRef.current = false;
        gripSinceRef.current = 0;
        calibStartRef.current = 0;
        if (calibProgRef.current !== 0) { calibProgRef.current = 0; setCalibProg(0); }
        cursorRef.current.vis = false;
        render();
      }
    }, 250);
    return () => {
      window.removeEventListener('imu-sample', onSample as EventListener);
      window.clearInterval(live);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [phase, cfg, render, penDownAt, penUp]);

  // zmena tvaru
  useEffect(() => {
    shapeRef.current = outline(shapeKey);
    trailRef.current = []; penRef.current = false; setPenDown(false); setResult(null);
    render();
  }, [shapeKey, phase, level, render]);

  // Esc = zavrieť
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // myš ako záloha na skúšanie bez rukavice
  const mouse = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as Pt;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = mouse(e); e.currentTarget.setPointerCapture(e.pointerId);
    cursorRef.current = { x, y, vis: true }; penDownAt(x, y); render();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1 || !penRef.current) return;
    const [x, y] = mouse(e); cursorRef.current = { x, y, vis: true };
    trailRef.current.push([x, y]); render();
  };
  const onPointerUp = () => penUp();

  const shape = SHAPES.find((s) => s.key === shapeKey)!;
  const levelBtns = (
    <div className="flex gap-2">
      {LEVELS.map((l) => (
        <button
          key={l.level}
          onClick={() => setLevel(l.level)}
          className={`px-4 py-2 rounded-xl font-medium transition-colors ${level === l.level ? 'bg-blue-600 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
        >
          {l.label} <span className="text-xs opacity-80">({l.hint})</span>
        </button>
      ))}
    </div>
  );
  const btn = 'px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors';

  return (
    <div className="fixed inset-0 z-[9000] bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col p-6">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-semibold text-slate-800">Skúška kreslenia</h2>
            <p className="text-slate-600">
              {phase === 'pick'
                ? 'Vyberte tvar, ktorý budete kresliť.'
                : `Tvar: ${shape.label}, ${LEVELS[level - 1].label}. Kurzor sa hýbe vždy, všetky prsty stisnuté = kreslenie.`}
            </p>
          </div>
          <div className="flex gap-2">
            {phase === 'draw' && levelBtns}
            <button className={btn} onClick={() => setAxisCalOpen(true)}>Kalibrácia osí</button>
            {phase === 'draw' && (
              <>
                <button className={btn} onClick={() => { recenterRef.current = true; trailRef.current = []; setResult(null); render(); }}>Vycentrovať</button>
                <button className={btn} onClick={() => setPhase('pick')}>Iný tvar</button>
              </>
            )}
            <button className={btn} onClick={onClose}>Zavrieť</button>
          </div>
        </div>

        {phase === 'pick' && <div className="mb-4 flex items-center gap-3"><span className="text-slate-600">Úroveň:</span>{levelBtns}</div>}
        {phase === 'pick' && (
          <div className="grid grid-cols-2 gap-4 flex-1">
            {SHAPES.map((s) => (
              <button
                key={s.key}
                onClick={() => { setShapeKey(s.key); setPhase('draw'); }}
                className="rounded-2xl border-2 border-slate-200 hover:border-blue-400 hover:shadow-md transition-all flex flex-col items-center justify-center gap-2"
              >
                <span className="text-8xl text-blue-600 leading-none">{s.glyph}</span>
                <span className="text-xl font-semibold text-slate-800">{s.label}</span>
              </button>
            ))}
          </div>
        )}

        {phase === 'draw' && (
          <>
            <div ref={wrapRef} className="relative flex-1 rounded-2xl border-2 border-slate-200 bg-slate-50 overflow-hidden">
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full touch-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
              <div className="pointer-events-none absolute right-3 bottom-3 max-w-[13rem] bg-white/70 rounded-xl shadow px-3 py-2 text-xs text-slate-600">
                {calibNote ? (
                  <div className="text-green-700 font-semibold">Poloha ruky nakalibrovaná.</div>
                ) : (
                  <>
                    <div>
                      Ak sa kurzor správa zle: stisnite <strong>všetkých 5 prstov</strong> a držte 3 s bez pohybu –
                      aktuálna poloha ruky sa nastaví ako nová nula a kurzor sa presunie do stredu.
                    </div>
                    {calibProg > 0 && (
                      <div className="mt-2 h-2 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${calibProg * 100}%` }} />
                      </div>
                    )}
                  </>
                )}
              </div>
              {home && (
                <div className="absolute left-3 bottom-3 flex items-center gap-3 bg-white/90 rounded-xl shadow px-3 py-2">
                  <div className="relative w-16 h-16 rounded-full border-2 border-slate-300 bg-slate-50">
                    <div className="absolute rounded-full border border-green-400" style={{ left: `calc(50% - ${HOME_ZONE * 28}px)`, top: `calc(50% - ${HOME_ZONE * 28}px)`, width: HOME_ZONE * 56, height: HOME_ZONE * 56 }} />
                    <div
                      className={`absolute w-3 h-3 rounded-full ${Math.hypot(home.x, home.y) <= HOME_ZONE ? 'bg-green-500' : 'bg-blue-500'}`}
                      style={{
                        left: `calc(50% - 6px + ${Math.max(-1, Math.min(1, home.x)) * 26}px)`,
                        top: `calc(50% - 6px + ${Math.max(-1, Math.min(1, home.y)) * 26}px)`,
                      }}
                    />
                  </div>
                  <div className="text-sm leading-tight">
                    <div className={Math.hypot(home.x, home.y) <= HOME_ZONE ? 'text-green-700 font-semibold' : 'text-slate-600'}>
                      {Math.hypot(home.x, home.y) <= HOME_ZONE ? 'Ruka v normálnej polohe' : 'Vráťte ruku do stredu'}
                    </div>
                    <div className="text-xs text-slate-500">Bod = poloha ruky voči kalibrácii</div>
                  </div>
                </div>
              )}
              <div className="absolute left-3 top-3 flex gap-2 text-sm">
                <span className={`px-2.5 py-1 rounded-full ${gloveLive ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
                  {gloveLive ? 'Rukavica aktívna' : 'Čakám na rukavicu (kresliť sa dá aj myšou)'}
                </span>
                <span className={`px-2.5 py-1 rounded-full ${penDown ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {penDown ? 'Pero dole' : 'Pero hore'}
                </span>
              </div>
              {result && (
                <div className="pointer-events-none absolute right-3 top-3 bg-white/85 rounded-xl shadow-lg p-3 text-slate-700 min-w-[180px]">
                  <div className="text-4xl font-bold text-slate-800">{result.score}<span className="text-lg"> / 100</span></div>
                  <div className="text-sm mt-1">Presnosť: {Math.round(result.accuracy * 100)} %</div>
                  <div className="text-sm">Pokrytie obrysu: {Math.round(result.coverage * 100)} %</div>
                  <div className="text-sm">Rozsah pohybu: {Math.round(result.range * 100)} % tvaru</div>
                  <div className="text-xs text-slate-500 mt-2">Stisnite prsty znova pre nový pokus.</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {axisCalOpen && <AxisCalibrationModal leftHand={leftHand} onClose={() => setAxisCalOpen(false)} />}
      {phase === 'pick' && !axisCalOpen && <MenuCursor screen="menu" leftHand={leftHand} />}
    </div>
  );
}
