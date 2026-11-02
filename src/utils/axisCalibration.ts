import { TILT_ROTATION_RIGHT_DEG, SHEAR_UP_RIGHT_HAND, SHEAR_RIGHT_RIGHT_HAND, profileFeatures, type AxisProfile } from './imuController';

// Korekcia osí rukavice (natočenie senzora + oblúk zápästia) pre každú ruku zvlášť. Predvolené hodnoty sú z nameraných
// dát pravej ruky; "Kalibrácia osí" ich nahradí hodnotami vypočítanými z pohybov konkrétneho používateľa a uloží.
export type HandKey = 'left' | 'right';
export type Gains = { right: number; left: number; up: number; down: number };
export type AxisCorr = { rot: number; shearUp: number; shearRight: number; gains?: Gains };
export type Dir = 'right' | 'left' | 'up' | 'down';

const STORAGE_KEY = 'rehapiano.axisCalibration.v1';

export const DEFAULT_AXIS_CORR: Record<HandKey, AxisCorr> = {
  // gains: z nameraných výchyliek pravej ruky (doprava 0,98, doľava 0,41, hore 0,78, dole 0,88; pri kruhu doprava 0,66, doľava 0,41,
  // hore 0,33, dole 0,80) vyrovnané na priemer, mierne zjemnené kvôli kruhu; presné hodnoty dá 'Kalibrácia osí'
  right: {
    rot: TILT_ROTATION_RIGHT_DEG, shearUp: SHEAR_UP_RIGHT_HAND, shearRight: SHEAR_RIGHT_RIGHT_HAND,
    gains: { right: 1, left: 1, up: 1, down: 1 }, // vyrovnanie dosahu medzi smermi rieši autoReach; staré hodnoty (0,85 / 1,6) spomaľovali pohyb doprava
  },
  left: { rot: 0, shearUp: 0, shearRight: 0 },
};

type Stored = Partial<Record<HandKey, AxisCorr>>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

export function hasCustomAxisCorr(hand: HandKey): boolean {
  return !!readAll()[hand];
}

export function loadAxisCorr(hand: HandKey): AxisCorr {
  return readAll()[hand] ?? DEFAULT_AXIS_CORR[hand];
}

export function saveAxisCorr(hand: HandKey, corr: AxisCorr) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [hand]: corr }));
  } catch {
    // ignore
  }
}

export function clearAxisCorr(hand: HandKey) {
  try {
    const all = readAll();
    delete all[hand];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

type CorrTarget = {
  gainRight: number;
  gainLeft: number;
  gainUp: number;
  gainDown: number;
  tiltRotationDeg: number;
  shearUp: number;
  shearRight: number;
  screenFlipX: boolean;
  screenFlipY: boolean;
  axisProfiles: AxisProfile[];
};

/** Nastaví korekcie osí na kontroléri podľa ruky (uložená kalibrácia, inak predvolené hodnoty). */
export function applyAxisCorr(ctrl: CorrTarget, hand: HandKey) {
  const c = loadAxisCorr(hand);
  ctrl.tiltRotationDeg = c.rot;
  ctrl.shearUp = c.shearUp;
  ctrl.shearRight = c.shearRight;
  const g = c.gains;
  ctrl.gainRight = g?.right ?? 1;
  ctrl.gainLeft = g?.left ?? 1;
  ctrl.gainUp = g?.up ?? 1;
  ctrl.gainDown = g?.down ?? 1;
  ctrl.axisProfiles = loadProfiles(hand);
  ctrl.screenFlipX = hand === 'right';
  ctrl.screenFlipY = hand === 'left';
}

const DIRS: Dir[] = ['right', 'left', 'up', 'down'];

export type FitResult = {
  ok: boolean;
  reason?: string;
  corr: AxisCorr;
  /** odchýlka osí po korekcii od ideálu (°): vodorovná os, zvislá os */
  residualDeg: { horizontal: number; vertical: number };
};

const wrap180 = (deg: number) => {
  let d = deg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
};

/** Hlavná os bodov okolo počiatku (nulový náklon): vlastný vektor Σ p·pᵀ, bez znamienka. */
function principalAxis(pts: [number, number][]): [number, number] {
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(ang), Math.sin(ang)];
}

/** Priemerná poloha (priemet na os) bodov so silným výchylkou; slúži len na určenie znamienka osi. */
function strongMean(pts: [number, number][], e: [number, number]): number {
  const t = pts.map((p) => p[0] * e[0] + p[1] * e[1]);
  const mx = Math.max(...t.map(Math.abs));
  const sel = t.filter((v) => Math.abs(v) > 0.5 * mx);
  return sel.length ? sel.reduce((a, b) => a + b, 0) / sel.length : 0;
}

/**
 * Z vektorov náklonu (posNorm kontroléra BEZ korekcií: tiltRotationDeg=0, bez shear, posGain=1) pre štyri smery vypočíta
 * natočenie osí a oblúk zápästia. Natočenie sa berie z hlavných osí (nie z extrémov), takže nevadí, ak ruka pri
 * "vľavo" na chvíľu preletí aj doprava. Znamienko osi určí rozdiel medzi pohybmi vpravo a vľavo (hore a dole).
 */
export function fitAxisCorr(steps: Record<Dir, [number, number][]>, hand: HandKey): FitResult {
  const flipX = hand === 'right' ? -1 : 1;
  const flipY = hand === 'left' ? -1 : 1;
  const fail = (reason: string): FitResult => ({ ok: false, reason, corr: DEFAULT_AXIS_CORR[hand], residualDeg: { horizontal: 0, vertical: 0 } });

  for (const d of DIRS) {
    const pts = steps[d];
    if (!pts || pts.length < 30) return fail(`Málo dát pre smer ${d}`);
    const mag = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])));
    if (mag < 0.15) return fail(`Pohyb "${d}" nebol zaznamenaný (príliš malý náklon)`);
  }

  const eH = principalAxis([...steps.right, ...steps.left]);
  const eV = principalAxis([...steps.up, ...steps.down]);
  // znamienko: "vpravo" musí byť na kladnej strane oproti "vľavo", "dole" oproti "hore" (v súradniciach obrazovky)
  if (strongMean(steps.right, eH) < strongMean(steps.left, eH)) { eH[0] = -eH[0]; eH[1] = -eH[1]; }
  if (strongMean(steps.down, eV) < strongMean(steps.up, eV)) { eV[0] = -eV[0]; eV[1] = -eV[1]; }

  // R(θ)·e = F⁻¹·cieľ  ->  θ = uhol(cieľ v súradniciach kontroléra) − uhol(e)
  const deg = (v: [number, number]) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;
  const thetaH = wrap180(deg([flipX, 0]) - deg(eH));
  const thetaV = wrap180(deg([0, flipY]) - deg(eV));
  const diff = wrap180(thetaV - thetaH);
  const rot0 = wrap180(thetaH + diff / 2); // stred medzi odhadmi z oboch osí
  const toScreen = (p: [number, number]): [number, number] => [flipX * p[0], flipY * p[1]];

  // Sklon "druhej" osi voči hlavnej pre body, kde je hlavná os dostatočne výrazná (regresia cez počiatok)
  const slopeOf = (pts: [number, number][], rotDeg: number, main: 0 | 1, sign: 1 | -1): number => {
    const t = (rotDeg * Math.PI) / 180;
    const sc2 = pts.map((p) => toScreen([p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)]));
    const maxMain = Math.max(...sc2.map((p) => sign * p[main]));
    let spp = 0, sps = 0;
    for (const p of sc2) {
      if (sign * p[main] < 0.3 * maxMain) continue;
      spp += p[main] * p[main];
      sps += p[main] * p[1 - main];
    }
    return spp > 0 ? sps / spp : 0;
  };
  const clamp = (v: number) => Math.max(-0.6, Math.min(0.6, v));

  // Hore a doprava sa uhýnanie vyrovná zlomovým shear-om, dole a doľava nie (tie ostávajú ako chyba). Natočenie sa preto
  // dohľadá tak, aby bol zvyšok na týchto dvoch polosiach čo najmenší (pohľad ±15° okolo odhadu z osí).
  let rot = rot0, best = Infinity;
  for (let r = rot0 - 15; r <= rot0 + 15; r += 0.5) {
    const sd = slopeOf(steps.down, r, 1, 1);     // x per y, y>0
    const sl = slopeOf(steps.left, r, 0, -1);    // y per x, x<0
    const cost = sd * sd + sl * sl;
    if (cost < best) { best = cost; rot = r; }
  }
  const shearUp = clamp(-slopeOf(steps.up, rot, 1, -1)); // x uhýna pri pohybe hore: x = slope·y, y<0
  const shearRight = clamp(slopeOf(steps.right, rot, 0, 1)); // y uhýna pri pohybe doprava: y = slope·x, x>0

  // vyrovnanie dosahu: priemer najväčších výchyliek (horných 10 %) v každom smere po otočení a oprave oblúka
  const amp = (pts: [number, number][], proj: (p: [number, number]) => number): number => {
    const v = pts
      .map((p) => {
        const sc = toScreen([p[0] * Math.cos((rot * Math.PI) / 180) - p[1] * Math.sin((rot * Math.PI) / 180), p[0] * Math.sin((rot * Math.PI) / 180) + p[1] * Math.cos((rot * Math.PI) / 180)]);
        const sx = sc[0] + shearUp * Math.min(sc[1], 0);
        const sy = sc[1] - shearRight * Math.max(sc[0], 0);
        return proj([sx, sy]);
      })
      .sort((a, b) => b - a);
    const top = v.slice(0, Math.max(3, Math.round(v.length * 0.1)));
    return top.reduce((a, b) => a + b, 0) / top.length;
  };
  const A = {
    right: amp(steps.right, (p) => p[0]),
    left: amp(steps.left, (p) => -p[0]),
    up: amp(steps.up, (p) => -p[1]),
    down: amp(steps.down, (p) => p[1]),
  };
  const ref = (A.right + A.left + A.up + A.down) / 4;
  const g = (a: number) => (a > 0.08 ? Math.max(0.6, Math.min(2, ref / a)) : 1);
  const gains: Gains = { right: g(A.right), left: g(A.left), up: g(A.up), down: g(A.down) };

  return {
    ok: true,
    corr: { rot, shearUp, shearRight, gains },
    residualDeg: { horizontal: wrap180(thetaH - rot), vertical: wrap180(thetaV - rot) },
  };
}

// ---------- Profily osí podľa polohy rukavice ----------
// Po otočení rukavice (napr. o 90° okolo osi predlaktia) sa "vpravo/vľavo/hore/dole" robí iným pohybom zápästia, takže jedny osi
// nestačia. Kalibrácia osí v danej polohe uloží profil (3D osi "vpravo" a "dole" v súradniciach senzora + dosah); hra si pri
// recentre (stisk všetkých prstov) vyberie profil podľa uhla krútenia rukavice. Bez profilu platí pôvodný model (AxisCorr).
export type { AxisProfile };
type Vec3 = [number, number, number];
const PROFILE_KEY = 'rehapiano.axisProfiles.v1';

// Jednorazové zmazanie uloženej ručnej "Kalibrácie osí" (pokazila ovládanie). Označenie zabráni mazaniu pri každom načítaní.
(() => {
  try {
    const mark = 'rehapiano.axisCalibration.cleared.20261102';
    if (localStorage.getItem(mark)) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROFILE_KEY);
    localStorage.setItem(mark, '1');
  } catch {
    // ignore
  }
})();
const PROFILE_MERGE_DEG = 25; // nový profil nahradí uložený, ak sa uhly krútenia líšia menej než toto
const PROFILE_TARGET = 0.72;  // rad; najväčší nameraný pohyb sa zosilní tak, aby dosiahol ~90 % rozsahu (tiltClamp 0,8)

let profileCache: Partial<Record<HandKey, AxisProfile[]>> = {};

function readProfiles(): Partial<Record<HandKey, AxisProfile[]>> {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<HandKey, AxisProfile[]>>) : {};
  } catch {
    return {};
  }
}

/** Uložené profily (rovnaké pole, kým sa nezmenia – kontrolér podľa toho pozná zmenu). */
export function loadProfiles(hand: HandKey): AxisProfile[] {
  if (!profileCache[hand]) profileCache[hand] = readProfiles()[hand] ?? [];
  return profileCache[hand]!;
}

function writeProfiles(hand: HandKey, list: AxisProfile[]) {
  profileCache = { ...profileCache, [hand]: list };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...readProfiles(), [hand]: list }));
  } catch {
    // ignore
  }
}

export function saveProfile(hand: HandKey, profile: AxisProfile) {
  const kept = loadProfiles(hand).filter((p) => Math.abs(wrap180(p.roll - profile.roll)) > PROFILE_MERGE_DEG);
  writeProfiles(hand, [...kept, profile]);
}

export function clearProfiles(hand: HandKey) {
  writeProfiles(hand, []);
}

export function hasProfiles(hand: HandKey): boolean {
  return loadProfiles(hand).length > 0;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Hlavná os oblaku vektorov (vlastný vektor kovariancie, bez znamienka) – mocninová metóda. */
function principalAxis3(vs: Vec3[]): Vec3 {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const v of vs) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += v[i] * v[j];
  let e: Vec3 = [1, 0.37, 0.11];
  for (let it = 0; it < 100; it++) {
    e = unit3([dot3(C[0] as Vec3, e), dot3(C[1] as Vec3, e), dot3(C[2] as Vec3, e)]);
  }
  return e;
}

/** Priemer horných 10 % priemetov podľa veľkosti (so znamienkom): kde leží silný pohyb na danej osi. */
function strongProj(vs: Vec3[], e: Vec3): number {
  const t = vs.map((v) => dot3(v, e)).sort((a, b) => Math.abs(b) - Math.abs(a));
  const top = t.slice(0, Math.max(3, Math.round(t.length * 0.1)));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

/** Priemer najväčších hodnôt (kladný smer) priemetu v 10 % vzoriek – dosah pohybu v jednom smere. */
function reach(vs: Vec3[], e: Vec3, sign: 1 | -1): number {
  const t = vs.map((v) => sign * dot3(v, e)).sort((a, b) => b - a);
  const top = t.slice(0, Math.max(3, Math.round(t.length * 0.1)));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

export type ProfileFit = {
  ok: boolean;
  reason?: string;
  profile?: AxisProfile;
  /** rozlíšenie smerov na osi (°): vpravo−vľavo, dole−hore */
  separationDeg?: { horizontal: number; vertical: number };
};

/**
 * Z rotačných vektorov (rad, v osiach senzora, od nulového bodu daného kroku) pre štyri smery naučí osi "vpravo" a "dole" v tejto
 * polohe rukavice. Os je hlavný smer pohybu (nie extrém), znamienko určí rozdiel medzi opačnými smermi; zvislá os sa ortogonalizuje
 * voči vodorovnej. Dosah v každom smere sa vyrovná tak, aby najväčší pohyb dosiahol takmer celý rozsah.
 */
export function fitAxisProfile(steps: Record<Dir, Vec3[]>, restRollDeg: number): ProfileFit {
  for (const d of DIRS) {
    const pts = steps[d];
    if (!pts || pts.length < 30) return { ok: false, reason: `Málo dát pre smer ${d}` };
    const mag = Math.max(...pts.map((p) => Math.hypot(p[0], p[1], p[2])));
    if (mag < 0.15) return { ok: false, reason: `Pohyb "${d}" nebol zaznamenaný (príliš malé otočenie)` };
  }
  let eH = principalAxis3([...steps.right, ...steps.left]);
  const sepH = strongProj(steps.right, eH) - strongProj(steps.left, eH);
  if (sepH < 0) eH = [-eH[0], -eH[1], -eH[2]];

  const rest = (v: Vec3): Vec3 => {
    const c = dot3(v, eH);
    return [v[0] - c * eH[0], v[1] - c * eH[1], v[2] - c * eH[2]];
  };
  let eV = unit3(principalAxis3([...steps.up, ...steps.down].map(rest)));
  const cv = dot3(eV, eH);
  eV = unit3([eV[0] - cv * eH[0], eV[1] - cv * eH[1], eV[2] - cv * eH[2]]);
  const sepV = strongProj(steps.down, eV) - strongProj(steps.up, eV);
  if (sepV < 0) eV = [-eV[0], -eV[1], -eV[2]];

  const sep = { horizontal: (Math.abs(sepH) * 180) / Math.PI, vertical: (Math.abs(sepV) * 180) / Math.PI };
  if (sep.horizontal < 10) return { ok: false, reason: 'Pohyby vpravo a vľavo sa nedajú od seba rozlíšiť (sú na tej istej strane osi)', separationDeg: sep };
  if (sep.vertical < 10) return { ok: false, reason: 'Pohyby hore a dole sa nedajú od seba rozlíšiť (sú na tej istej strane osi)', separationDeg: sep };

  // Vyrovnanie: lineárny priemet na eH/eV nechá diagonálu (pohyb "hore" má aj bočnú zložku) a oblúk (osi sa pri väčšom uhle skladajú
  // nelineárne). Ridge regresia nad znakmi (profileFeatures) preto naučí, aby pohyby vpravo/vľavo mali zvislú zložku ~0 a hore/dole
  // vodorovnú ~0, pri zachovaní mierky pozdĺž hlavného smeru.
  const samples: { f: number[]; tx: number; ty: number }[] = [];
  const add = (pts: Vec3[], main: 'h' | 'v') => {
    for (const p of pts) {
      samples.push({
        f: profileFeatures(p),
        tx: main === 'h' ? dot3(p, eH) : 0,
        ty: main === 'v' ? dot3(p, eV) : 0,
      });
    }
  };
  add(steps.right, 'h'); add(steps.left, 'h'); add(steps.up, 'v'); add(steps.down, 'v');
  const mx = ridgeFit(samples.map((s2) => s2.f), samples.map((s2) => s2.tx));
  const my = ridgeFit(samples.map((s2) => s2.f), samples.map((s2) => s2.ty));
  const apply = (v: Vec3): [number, number] => {
    const f = profileFeatures(v);
    let x = 0, y = 0;
    for (let i = 0; i < f.length; i++) { x += mx[i] * f[i]; y += my[i] * f[i]; }
    return [x, y];
  };
  const out = (pts: Vec3[]) => pts.map(apply);
  const top = (vals: number[]) => {
    const t = [...vals].sort((a, b) => b - a);
    const k = t.slice(0, Math.max(3, Math.round(t.length * 0.1)));
    return k.reduce((a, b) => a + b, 0) / k.length;
  };
  const R = {
    right: top(out(steps.right).map((o) => o[0])),
    left: top(out(steps.left).map((o) => -o[0])),
    up: top(out(steps.up).map((o) => -o[1])),
    down: top(out(steps.down).map((o) => o[1])),
  };
  // ak naučená mapa nedáva zmysel (pohyb v svojom smere nevyšiel kladný), ostane len lineárny priemet
  const useFit = R.right > 0.08 && R.left > 0.08 && R.up > 0.08 && R.down > 0.08;
  const g = (a: number) => (a > 0.08 ? Math.max(0.3, Math.min(3, PROFILE_TARGET / a)) : 1);
  const gains: Gains = useFit
    ? { right: g(R.right), left: g(R.left), up: g(R.up), down: g(R.down) }
    : {
        right: g(reach(steps.right, eH, 1)),
        left: g(reach(steps.left, eH, -1)),
        up: g(reach(steps.up, eV, -1)),
        down: g(reach(steps.down, eV, 1)),
      };
  return {
    ok: true,
    profile: { roll: restRollDeg, eH, eV, gains, ...(useFit ? { mx, my } : {}) },
    separationDeg: sep,
  };
}

/** Ridge regresia (FᵀF/N + Λ)a = Fᵀt/N; kvadratické znaky sa regularizujú silnejšie než lineárne. */
function ridgeFit(F: number[][], t: number[]): number[] {
  const n = F[0].length, N = F.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < n; i++) {
      b[i] += F[k][i] * t[k] / N;
      for (let j = 0; j < n; j++) A[i][j] += F[k][i] * F[k][j] / N;
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += i < 3 ? 1e-4 : 2e-2;
  // Gaussova eliminácia s čiastočným pivotovaním
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const m = A[r][c] / d;
      for (let k = c; k < n; k++) A[r][k] -= m * A[c][k];
      b[r] -= m * b[c];
    }
  }
  const a = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let k = i + 1; k < n; k++) sum -= A[i][k] * a[k];
    a[i] = sum / (A[i][i] || 1e-12);
  }
  return a;
}
