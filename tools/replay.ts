// Offline replay of a glove recording (tools/recordings/pose_*/samples.jsonl) through the real SingleIMUController.
// Prints numbers that describe cursor quality, so a controller change can be compared before/after without the glove.
//
//   tools/replay.sh tools/recordings/pose_20261102_110016            (menu preset)
//   tools/replay.sh --preset game tools/recordings/pose_*            (Pentomino/drawing preset, several recordings)
//   tools/replay.sh --no-rest-recenter <rec>                         (zero only at the first sample; tests automatic pose detection)
//
// Columns per direction step (A_right, B_up, ...), cursor in screen units (1 = half of the screen, x right, y down):
//   reach  - how far the cursor went in the asked direction (98th percentile)
//   side   - sideways drift per unit of travel (0 = straight line, 0.3 = ~17 degrees off)
// Rest steps: jitter = cursor noise in px (deviation from a 0.3 s moving average), wander = total range in px (1920x1080 screen).
import './replayEnv';
import fs from 'fs';
import path from 'path';
import SingleIMUController from '../src/utils/imuController';
import { applyAxisCorr } from '../src/utils/axisCalibration';
import { computeFingerCal, saveFingerCal, detectFingers, clearFingerCal } from '../src/utils/fingerCalibration';

type Row = { t: number; step: string; msg: any };
type Pt = { t: number; x: number; y: number };
const SCREEN = { w: 1920, h: 1080 };

const args = process.argv.slice(2);
let preset: 'menu' | 'game' = 'menu';
let restRecenter = true;
const recs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--preset') preset = args[++i] as any;
  else if (args[i] === '--no-rest-recenter') restRecenter = false;
  else recs.push(args[i]);
}
if (!recs.length) { console.error('usage: tools/replay.sh [--preset menu|game] [--no-rest-recenter] <recording dir or samples.jsonl> ...'); process.exit(1); }

function makeController(): SingleIMUController {
  const c = new SingleIMUController();
  c.gyroDivisor = 1; c.linearTilt = true; c.angleTilt = true; c.precisionScale = 1; c.tiltMax = 4; c.posLimit = 4;
  if (preset === 'menu') { // as in MenuCursor.tsx
    c.oneEuro = true; c.tiltDeadzone = 0.035; c.autoReach = false; c.autoAxes = false;
    c.rolledTune = { up: 1.4, down: 1.7, shear: -0.2 };
  } else { // as in PentominoGame.tsx / ShapeTraceModal.tsx
    c.oneEuro = false; c.posAlpha = 0.45; c.tiltDeadzone = 0; c.autoReach = false; c.autoAxes = false;
    c.rolledTune = { up: 1.4, down: 1.7, shear: -0.2, right: 1, left: 1 };
  }
  return c;
}

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))] : 0; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-').padStart(6);

function replay(file: string) {
  const p = fs.statSync(file).isDirectory() ? path.join(file, 'samples.jsonl') : file;
  const rows: Row[] = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) { console.log(`\n${file}: empty`); return null; }
  const hand: 'left' | 'right' = rows[0].msg.hand === 'left' ? 'left' : 'right';
  const left = hand === 'left';

  // Finger calibration from the recording itself (same procedure as the calibration window): rest, wrist motion, full grip
  clearFingerCal();
  const fingersOf = (r: Row) => (r.msg.adc as number[]).slice(1, 6);
  const of = (re: RegExp) => rows.filter((r) => re.test(r.step)).map(fingersOf);
  const rest = of(/^A_rest$/), grip = of(/^A_grip$/), motion = of(/^A_(right|left|up|down|circle)$/);
  const haveCal = rest.length > 50 && grip.length > 50;
  if (haveCal) saveFingerCal(hand, computeFingerCal(rest, motion, grip.slice(Math.floor(grip.length * 0.3))));

  const c = makeController();
  const steps = new Map<string, { pts: Pt[]; rolled: number; grip: number; rho: number[] }>();
  let last = 0, prevStep = '', first = true, recenters = 0, n = 0, ctrlGrip = 0;
  let turnEnd = 0, rolledAt = 0;
  for (const r of rows) {
    const m = r.msg; const t = (m.ts ?? r.t) * 1000;
    const dt = last ? Math.min(0.1, Math.max(0.001, (t - last) / 1000)) : 0.008; last = t;
    const newStep = r.step !== prevStep;
    if (first || (restRecenter && newStep && /_rest$/.test(r.step))) { c.recenter(m.imu); first = false; }
    if (newStep && prevStep === 'turn') turnEnd = t;
    prevStep = r.step;
    applyAxisCorr(c as any, hand);
    const fingers = detectFingers(m.adc, hand, {});
    const seq = c.recenterSeq;
    const o = c.update({ imu: m.imu, adc: m.adc, ts: t, fingers } as any, dt);
    if (c.recenterSeq !== seq) recenters++;
    if (o.rolled && turnEnd && !rolledAt) rolledAt = t;
    n++; if (o.grip) ctrlGrip++;
    const s = steps.get(r.step) ?? { pts: [], rolled: 0, grip: 0, rho: [] };
    steps.set(r.step, s);
    s.pts.push({ t, x: left ? o.posNorm.x : -o.posNorm.x, y: left ? -o.posNorm.y : o.posNorm.y });
    if (o.rolled) s.rolled++;
    if (o.grip) s.grip++;
    const q = m.imu; // twist of the glove: angle of world "up" in the sensor X/Y plane (what the controller uses to tell the poses apart)
    if (q && q.quatW !== undefined) s.rho.push((Math.atan2(2 * (q.quatY * q.quatZ + q.quatW * q.quatX), 2 * (q.quatX * q.quatZ - q.quatW * q.quatY)) * 180) / Math.PI);
  }

  console.log(`\n=== ${path.basename(path.dirname(p))}  hand=${hand}  preset=${preset}  samples=${n}  fingerCal=${haveCal ? 'from recording' : 'none (fixed threshold)'}`);
  console.log(`controller grip active: ${((100 * ctrlGrip) / n).toFixed(0)} % of samples | automatic recenters: ${recenters} | axis updates learned: ${c.autoLearnedSeq}` +
    (turnEnd ? ` | rolled pose recognised ${rolledAt ? ((rolledAt - turnEnd) / 1000).toFixed(1) + ' s after the turn' : 'NEVER'}` : ''));
  console.log('step        reach   side  rolled%  grip%  twist min..max');
  const out: Record<string, { reach: number; side: number }> = {};
  const restStats: string[] = [];
  for (const [name, s] of steps) {
    const pts = s.pts;
    const rolledPct = ((100 * s.rolled) / pts.length).toFixed(0).padStart(6);
    const gripPct = ((100 * s.grip) / pts.length).toFixed(0).padStart(6);
    const twist = `${pct(s.rho, 0).toFixed(0)}..${pct(s.rho, 100).toFixed(0)}`;
    const dir = name.match(/_(right|left|up|down)$/)?.[1];
    if (dir) {
      const t0 = pts[0].t;
      const start = pts.filter((q) => q.t - t0 < 300);
      const x0 = pct(start.map((q) => q.x), 50), y0 = pct(start.map((q) => q.y), 50);
      const horiz = dir === 'right' || dir === 'left';
      const sign = dir === 'right' || dir === 'down' ? 1 : -1;
      const main = pts.map((q) => sign * (horiz ? q.x - x0 : q.y - y0));
      const lat = pts.map((q) => (horiz ? q.y - y0 : q.x - x0));
      const reach = pct(main, 98);
      let spp = 0, sps = 0; // lateral per unit of travel: regression through the start point over the outward part of the move
      for (let i = 0; i < main.length; i++) if (main[i] > 0.2 * reach) { spp += main[i] * main[i]; sps += main[i] * lat[i]; }
      const side = spp > 0 ? sps / spp : NaN;
      out[name] = { reach, side };
      console.log(`${name.padEnd(10)} ${f(reach)} ${f(side)} ${rolledPct} ${gripPct}  ${twist}`);
    } else {
      if (/_rest$/.test(name)) {
        const px = pts.map((q) => ({ t: q.t, x: (q.x * SCREEN.w) / 2, y: (q.y * SCREEN.h) / 2 }));
        const dev: number[] = [];
        for (let i = 0, a = 0, b = 0; i < px.length; i++) {
          while (px[i].t - px[a].t > 150) a++;
          while (b < px.length - 1 && px[b + 1].t - px[i].t <= 150) b++;
          const w = px.slice(a, b + 1);
          dev.push(Math.hypot(px[i].x - mean(w.map((q) => q.x)), px[i].y - mean(w.map((q) => q.y))));
        }
        const jitter = Math.sqrt(mean(dev.map((d) => d * d)));
        const wander = Math.hypot(pct(px.map((q) => q.x), 100) - pct(px.map((q) => q.x), 0), pct(px.map((q) => q.y), 100) - pct(px.map((q) => q.y), 0));
        restStats.push(`${name}: jitter ${jitter.toFixed(1)} px, wander ${wander.toFixed(0)} px`);
      }
      console.log(`${name.padEnd(10)} ${f(NaN)} ${f(NaN)} ${rolledPct} ${gripPct}  ${twist}`);
    }
  }
  const summary: Record<string, number> = {};
  for (const pose of ['A', 'B']) {
    const d = ['right', 'left', 'up', 'down'].map((k) => out[`${pose}_${k}`]).filter(Boolean);
    if (d.length < 4) continue;
    const side = Math.sqrt(mean(d.map((v) => v.side * v.side)));
    const reaches = d.map((v) => v.reach);
    const spread = Math.max(...reaches) / Math.max(1e-6, Math.min(...reaches));
    summary[`${pose}.side`] = side; summary[`${pose}.spread`] = spread;
    console.log(`pose ${pose} (${pose === 'A' ? 'normal' : 'rolled'}): side drift rms ${side.toFixed(3)} | reach ${Math.min(...reaches).toFixed(2)}..${Math.max(...reaches).toFixed(2)} (spread x${spread.toFixed(1)})`);
  }
  if (restStats.length) console.log(restStats.join(' | '));
  return summary;
}

const all = recs.map(replay).filter(Boolean) as Record<string, number>[];
if (all.length > 1) {
  console.log(`\n=== mean over ${all.length} recordings (preset=${preset})`);
  for (const k of ['A.side', 'A.spread', 'B.side', 'B.spread']) {
    const v = all.map((s) => s[k]).filter(Number.isFinite);
    if (v.length) console.log(`${k.padEnd(9)} ${mean(v).toFixed(3)}`);
  }
}
