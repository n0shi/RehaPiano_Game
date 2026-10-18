import { useEffect, useRef, useState, useCallback } from 'react';
import SingleIMUController, { TILT_ROTATION_RIGHT_DEG, SHEAR_UP_RIGHT_HAND, SHEAR_RIGHT_RIGHT_HAND } from '../utils/imuController';
import { normalizeAdc } from '../utils/imuNormalize';
import { useCalibration } from '../context/CalibrationContext';
import { useConfig } from '../config/ConfigContext';
import { MenuCursor } from './MenuCursor';

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
const SHAPE_SCALE = 0.32;       // veľkosť tvaru ako podiel min(šírka, výška) plátna
const MIN_STROKE_POINTS = 20;
const COVER_TOL = 0.18;         // tolerancia pokrytia obrysu (v jednotkách tvaru)
const SAMPLE_TIMEOUT_MS = 1500;
// Zosilenie náklonu -> pohyb kurzora. Namerané: bežný náklon ruky dá len ~±0,5 rozsahu, takže pri 1,0 sa nedalo dosiahnuť
// spodnú tretinu (a okraje) plátna; pri 2,0 stačí polovičný náklon na okraj.
const DRAW_GAIN = 2.0;
const MOVE_SETTLE_MS = 150;      // po stisku jedného prsta chvíľu počkaj, kým sa ruka ustáli, potom vynuluj náklon
const PEN_SETTLE_MS = 180;      // po stisku prstov chvíľu počkaj (ruka sa pri stisku hýbe), potom vynuluj náklon a spusti pero

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
    const n = Math.round(80);
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return pts;
}

type Result = { score: number; accuracy: number; coverage: number; range: number };

function evaluate(trail: Pt[], shape: Pt[]): Result {
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
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < COVER_TOL) { covered++; break; }
    }
  }
  const coverage = covered / shape.length;
  const accuracy = Math.max(0, 1 - meanDist / 0.35);
  const xs = trail.map((p) => p[0]), ys = trail.map((p) => p[1]);
  const range = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  return { score: Math.round(100 * accuracy * coverage), accuracy, coverage, range };
}

type Props = { leftHand: boolean; onClose: () => void };

export function ShapeTraceModal({ leftHand, onClose }: Props) {
  const { handMode } = useCalibration();
  const cfg = useConfig() as any;
  const [phase, setPhase] = useState<'pick' | 'draw'>('pick');
  const [shapeKey, setShapeKey] = useState<ShapeKey>('circle');
  const [result, setResult] = useState<Result | null>(null);
  const [penDown, setPenDown] = useState(false);
  const [gloveLive, setGloveLive] = useState(false);
  const [mode, setMode] = useState<'idle' | 'move' | 'draw'>('idle');
  const modeRef = useRef<'idle' | 'move' | 'draw'>('idle');
  const moveSinceRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<SingleIMUController | null>(null);
  const recenterRef = useRef(true);
  const sizeRef = useRef({ w: 800, h: 600 });
  const cursorRef = useRef({ x: 400, y: 300, vis: false });
  const trailRef = useRef<Pt[]>([]);          // body aktuálneho ťahu v px
  const penRef = useRef(false);
  const anchorRef = useRef({ x: 400, y: 300 }); // bod, v ktorom bol kurzor pri poslednom vynulovaní náklonu
  const gripSinceRef = useRef(0);
  const armedRef = useRef(false);             // pero sa aktivuje až po uvoľnení prstov (aby klik na tvar nekreslil)
  const shapeRef = useRef<Pt[]>(outline('circle'));
  const lastSampleRef = useRef(0);
  const propsRef = useRef({ leftHand, handMode });
  propsRef.current = { leftHand, handMode };

  const shapePx = useCallback((): Pt[] => {
    const { w, h } = sizeRef.current;
    const s = Math.min(w, h) * SHAPE_SCALE;
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
    // kurzor
    const c = cursorRef.current;
    if (c.vis) {
      ctx.lineWidth = 4; ctx.strokeStyle = penRef.current ? '#16a34a' : '#2563eb';
      ctx.fillStyle = penRef.current ? 'rgba(22,163,74,0.3)' : 'rgba(37,99,235,0.12)';
      ctx.beginPath(); ctx.arc(c.x, c.y, penRef.current ? 12 : 20, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }, [shapePx]);

  const finishStroke = useCallback(() => {
    const tr = trailRef.current;
    if (tr.length < MIN_STROKE_POINTS) return;
    const { w, h } = sizeRef.current;
    const s = Math.min(w, h) * SHAPE_SCALE;
    const norm = tr.map(([x, y]) => [(x - w / 2) / s, (y - h / 2) / s] as Pt);
    setResult(evaluate(norm, shapeRef.current));
  }, []);

  const penDownAt = useCallback((x: number, y: number) => {
    penRef.current = true; setPenDown(true);
    trailRef.current = [[x, y]]; setResult(null);
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
      ctrlRef.current = c;
    }
    recenterRef.current = true;
    armedRef.current = false;
    const rawThr = cfg?.TENSOMETER_RAW_THRESHOLD ?? 2000;
    const normThr = cfg?.TENSOMETER_NORM_THRESHOLD ?? 12;
    let lastTs = 0;

    const onSample = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      const ctrl = ctrlRef.current;
      if (!d || !ctrl) return;
      const p = propsRef.current;
      if (p.handMode === 'dual' && d.hand && d.hand !== 'right') return;
      const now = Date.now();
      const dt = Math.max(1, now - (lastTs || now)) / 1000;
      lastTs = now; lastSampleRef.current = now;
      if (recenterRef.current) {
        ctrl.recenter(d.imu || {}); recenterRef.current = false;
        anchorRef.current = { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
        cursorRef.current.x = anchorRef.current.x; cursorRef.current.y = anchorRef.current.y;
      }
      const left = p.handMode === 'dual' ? false : d.hand === 'left' ? true : d.hand === 'right' ? false : p.leftHand;
      ctrl.tiltRotationDeg = left ? 0 : TILT_ROTATION_RIGHT_DEG;
      ctrl.shearUp = left ? 0 : SHEAR_UP_RIGHT_HAND;
      ctrl.shearRight = left ? 0 : SHEAR_RIGHT_RIGHT_HAND;
      const out = ctrl.update({ imu: d.imu || {}, adc: d.adc || [], ts: now } as any, dt);

      const adc: number[] = Array.isArray(d.adc) ? d.adc : [];
      const pressed = adc.slice(1, 6).filter((v) => {
        const raw = Math.abs(Number(v) || 0);
        return raw > rawThr || normalizeAdc(raw) > normThr;
      }).length;
      const grip = pressed >= PEN_FINGERS;

      const nx = left ? out.posNorm.x : -out.posNorm.x;
      const ny = left ? -out.posNorm.y : out.posNorm.y;
      const { w, h } = sizeRef.current;
      const c = cursorRef.current;
      // Kurzor = kotva + náklon od posledného vynulovania. Každý ťah začína vynulovaním náklonu v bode, kde kurzor stojí,
      // takže sa chyba (drift, zmena držania ruky) nenahromadí; pred ťahom sa kurzor nastaví otvorenou dlaňou.
      const follow = () => {
        const a = anchorRef.current;
        const tx = Math.max(0, Math.min(w, a.x + nx * (w / 2) * DRAW_GAIN));
        const ty = Math.max(0, Math.min(h, a.y + ny * (h / 2) * DRAW_GAIN));
        c.x += CURSOR_SMOOTH * (tx - c.x);
        c.y += CURSOR_SMOOTH * (ty - c.y);
        c.vis = true;
      };

      // Režimy podľa počtu stisnutých prstov:
      //  1 prst  = POSUN: kurzor sa hýbe (od nuly nastavenej pri stisku prsta),
      //  5 prstov = KRESLENIE: pero dole (nula sa nastaví v bode kurzora),
      //  inak (0, 2-4) = POKOJ: kurzor stojí a náklon sa priebežne vynuluje, takže ruku možno pohodlne prestaviť.
      const mode: 'idle' | 'move' | 'draw' = grip ? 'draw' : pressed === 1 ? 'move' : 'idle';
      if (mode !== modeRef.current) { modeRef.current = mode; setMode(mode); }

      if (mode !== 'draw') {
        armedRef.current = true;
        gripSinceRef.current = 0;
        if (penRef.current) penUp();
      }
      if (mode === 'idle') {
        ctrl.recenter(d.imu || {});
        anchorRef.current = { x: c.x, y: c.y };
        moveSinceRef.current = 0;
        c.vis = true;
      } else if (mode === 'move') {
        // stisk prsta hýbe rukou: chvíľu počkaj, potom vynuluj náklon v bode kurzora a nechaj ho sledovať ruku
        if (!moveSinceRef.current) moveSinceRef.current = now;
        if (now - moveSinceRef.current < MOVE_SETTLE_MS) {
          ctrl.recenter(d.imu || {});
          anchorRef.current = { x: c.x, y: c.y };
          c.vis = true;
        } else follow();
      } else if (penRef.current) {
        follow();
        trailRef.current.push([c.x, c.y]);
      } else if (armedRef.current) {
        // stisk všetkých prstov: kurzor stojí, po PEN_SETTLE_MS sa náklon vynuluje v tomto bode a začne kreslenie
        if (!gripSinceRef.current) gripSinceRef.current = now;
        if (now - gripSinceRef.current >= PEN_SETTLE_MS) {
          ctrl.recenter(d.imu || {});
          anchorRef.current = { x: c.x, y: c.y };
          penDownAt(c.x, c.y);
        }
      }
      render();
    };

    window.addEventListener('imu-sample', onSample as EventListener);
    const live = window.setInterval(() => setGloveLive(Date.now() - lastSampleRef.current < SAMPLE_TIMEOUT_MS), 500);
    return () => {
      window.removeEventListener('imu-sample', onSample as EventListener);
      window.clearInterval(live);
    };
  }, [phase, cfg, render, penDownAt, penUp]);

  // zmena tvaru
  useEffect(() => {
    shapeRef.current = outline(shapeKey);
    trailRef.current = []; penRef.current = false; setPenDown(false); setResult(null);
    render();
  }, [shapeKey, phase, render]);

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
                : `Tvar: ${shape.label}. Stisnutý jeden prst = posun kurzora. Uvoľnená ruka = kurzor stojí (ruku môžete pohodlne prestaviť). Všetky prsty = kreslenie.`}
            </p>
          </div>
          <div className="flex gap-2">
            {phase === 'draw' && (
              <>
                <button className={btn} onClick={() => { recenterRef.current = true; trailRef.current = []; setResult(null); render(); }}>Vycentrovať</button>
                <button className={btn} onClick={() => setPhase('pick')}>Iný tvar</button>
              </>
            )}
            <button className={btn} onClick={onClose}>Zavrieť</button>
          </div>
        </div>

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
              <div className="absolute left-3 top-3 flex gap-2 text-sm">
                <span className={`px-2.5 py-1 rounded-full ${gloveLive ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
                  {gloveLive ? 'Rukavica aktívna' : 'Čakám na rukavicu (kresliť sa dá aj myšou)'}
                </span>
                <span className={`px-2.5 py-1 rounded-full ${mode === 'move' ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {mode === 'move' ? 'Posun kurzora (1 prst)' : 'Kurzor stojí'}
                </span>
                <span className={`px-2.5 py-1 rounded-full ${penDown ? 'bg-green-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {penDown ? 'Pero dole' : 'Pero hore'}
                </span>
              </div>
              {result && (
                <div className="absolute right-3 top-3 bg-white/95 rounded-xl shadow-lg p-4 text-slate-700 min-w-[220px]">
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
      {phase === 'pick' && <MenuCursor screen="menu" leftHand={leftHand} />}
    </div>
  );
}
