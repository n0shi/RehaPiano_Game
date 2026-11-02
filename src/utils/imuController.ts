// imuController.ts
// Single-IMU controller for mapping IMU+tensometer -> normalized cursor + gestures
import { normalizeImuSample, normalizeAdc, GYRO_DIVISOR, type RawIMU } from './imuNormalize';
export type { RawIMU };

export type Sample = {
  imu: RawIMU;
  adc: number[];
  ts?: number;
};

type Quat = { w: number; x: number; y: number; z: number };
type Vec3 = [number, number, number];

function ema(prev: number, cur: number, alpha: number) {
  return prev + alpha * (cur - prev);
}

/** One Euro filter: silné vyhladenie pri pomalom pohybe (žiadne chvenie), takmer nulové oneskorenie pri rýchlom. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private dtS = 0; // vyhladený krok: časové pečiatky v prehliadači chodia v dávkach (1 ms, 15 ms, …), surové dt by rozhádzalo filter
  constructor(public minCutoff = 1.5, public beta = 4, public dCutoff = 1.5) {}
  reset(v: number | null = null) { this.x = v; this.dx = 0; }
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, dt: number) {
    const raw = Math.max(0.002, Math.min(0.1, dt));
    this.dtS = this.dtS ? this.dtS + 0.1 * (raw - this.dtS) : raw;
    const d = this.dtS;
    if (this.x === null) { this.x = v; return v; }
    const rawDx = (v - this.x) / d;
    this.dx += OneEuro.alpha(this.dCutoff, d) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, d) * (v - this.x);
    return this.x;
  }
}

function quatConjugate(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function rotateVecByQuat(q: Quat, v: Vec3): Vec3 {
  const qv: Quat = { w: 0, x: v[0], y: v[1], z: v[2] };
  const tmp = quatMultiply(q, qv);
  const res = quatMultiply(tmp, quatConjugate(q));
  return [res.x, res.y, res.z];
}

/** Jednotkový vektor "hore" v súradniciach senzora (z kvaterniona), nezávislý od yaw. */
function upInSensor(q: Quat): Vec3 {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return rotateVecByQuat(quatConjugate({ w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n }), [0, 0, 1]);
}

function gravityAngles(q: Quat) {
  const [ux, uy, uz] = upInSensor(q);
  return { rho: Math.atan2(uy, ux), e: Math.asin(Math.max(-1, Math.min(1, uz))), xy: Math.hypot(ux, uy) };
}

/**
 * Vstavané osi pre otočenú rukavicu (cca 60–90° okolo osi predlaktia oproti základnej polohe z globálnej kalibrácie), naučené z čistého
 * záznamu pohybov v tejto polohe: "vpravo" = otočenie okolo -X senzora, "dole" = pokles prstov (os (-0,15; -0,74; 0,66)). Zosilnenie hore/dole bolo
 * pôvodne 2,6 (zo staršieho záznamu so zvislým pohybom ~±11°); nový záznam (pose_20261102) ukazuje zvislý aj vodorovný pohyb
 * ~±20–28°, takže 2,6 rozťahovalo zvislú os a krivilo smer pohybu. Teraz 1 = rovnaký dosah v oboch osiach.
 */
export const ROLLED_PROFILE: AxisProfile = {
  roll: -6,
  eH: [-0.96, 0.26, 0.08],
  eV: [-0.15, -0.74, 0.66],
  gains: { right: 1, left: 1, up: 1.0, down: 1.0 },
};
/**
 * Otočená poloha sa pozná podľa absolútneho krútenia rukavice (uhol vektora "hore" v rovine X/Y senzora, nezávislý od yaw a kalibrácie):
 * základná poloha má ~+52° (namerané 50–56°), otočená ~-6…-25°. Hranica medzi nimi je ROLLED_ROLL_MAX_DEG.
 */
export const ROLLED_ROLL_MAX_DEG = 20;
export const ROLLED_ROLL_MIN_DEG = -120;
const isRolledRoll = (rollRad: number) => {
  const d = (rollRad * 180) / Math.PI;
  return d < ROLLED_ROLL_MAX_DEG && d > ROLLED_ROLL_MIN_DEG;
};

/**
 * Oblúk zápästia v otočenej polohe: pri pohybe doprava kurzor uhýna dole (namerané y/x = +0,43, ~23°), doľava je pohyb rovný (±0,04).
 * Korekcia v súradniciach obrazovky ako shear v pôvodnom modeli: y -= ROLLED_SHEAR_RIGHT * max(x, 0).
 * Pôvodne 0,43 (zo staršieho záznamu). Na zázname pose_20261102_110016 (plný rozsah) oblúk takmer nie je (y/x = -0,12) a 0,43 kurzor
 * pri pohybe doprava stáčalo hore (y/x = -0,51, ~27°), preto 0. Oblúk sa medzi sedeniami mení; pre konkrétneho človeka: "Kalibrácia osí" v otočenej polohe.
 */
export const ROLLED_SHEAR_RIGHT = 0;
let rolledShearRightCache = { t: 0, v: ROLLED_SHEAR_RIGHT };
/** Laditeľné bez prebuildu: localStorage.setItem('rehapiano.rolledShearRight', '0.2') a obnoviť stránku. */
function rolledShearRight(): number {
  const now = Date.now();
  if (now - rolledShearRightCache.t > 1000) {
    let v = ROLLED_SHEAR_RIGHT;
    try {
      const raw = localStorage.getItem('rehapiano.rolledShearRight');
      const n = raw === null ? NaN : parseFloat(raw);
      if (Number.isFinite(n)) v = Math.max(0, Math.min(1, n));
    } catch { /* bez localStorage platí predvolená hodnota */ }
    rolledShearRightCache = { t: now, v };
  }
  return rolledShearRightCache.v;
}

/**
 * Šikmý zvislý pohyb v otočenej polohe: pri pohybe dole kurzor uhýna doľava a hore doprava (pozorované na reálnom používaní, záznam to
 * nezachytil, preto sa nedá odvodiť zo záznamu). Korekcia v súradniciach obrazovky: x += k * y (y smerom dole). Ladí sa bez prebuildu v konzole
 * prehliadača: localStorage.setItem('rehapiano.rolledShearVert', '0.3') a obnoviť stránku (kladné = viac doprava pri pohybe dole).
 */
export const ROLLED_SHEAR_VERT = 0.2;
let rolledShearVertCache = { t: 0, v: ROLLED_SHEAR_VERT };
function rolledShearVert(): number {
  const now = Date.now();
  if (now - rolledShearVertCache.t > 1000) {
    let v = ROLLED_SHEAR_VERT;
    try {
      const raw = localStorage.getItem('rehapiano.rolledShearVert');
      const n = raw === null ? NaN : parseFloat(raw);
      if (Number.isFinite(n)) v = Math.max(-1, Math.min(1, n));
    } catch { /* bez localStorage platí predvolená hodnota */ }
    rolledShearVertCache = { t: now, v };
  }
  return rolledShearVertCache.v;
}

/** Smer osi Z senzora vo svete: azimut, výška a dĺžka vodorovného priemetu (pri zvislej osi je azimut nedefinovaný). */
function pointerAngles(q: Quat) {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  const [px, py, pz] = rotateVecByQuat({ w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n }, [0, 0, 1]);
  return { az: Math.atan2(py, px), el: Math.asin(Math.max(-1, Math.min(1, pz))), xy: Math.hypot(px, py) };
}

export type AxisProfile = {
  roll: number;                 // ° – uhol krútenia rukavice (roll okolo Z) pri kalibrácii tohto profilu
  eH: Vec3;                     // os "vpravo" v osiach senzora (jednotkový vektor)
  eV: Vec3;                     // os "dole"
  // Naučené vyrovnanie (9 koeficientov nad profileFeatures): lineárna časť odstráni bočnú zložku ("diagonálu"), kvadratická "oblúk".
  // Bez nich (staršie uložené profily) platí len priemet na eH/eV.
  mx?: number[];
  my?: number[];
  gains: { right: number; left: number; up: number; down: number };
};

/** Znaky pre naučenú mapu rotačný vektor -> obrazovka: lineárne zložky a ich kvadratické súčiny. */
export function profileFeatures(rv: Vec3): number[] {
  const c = (v: number) => Math.max(-1.5, Math.min(1.5, v)); // mimo namerané rozsahy sa kvadratický člen nemá rozbehnúť
  const a = c(rv[0]), b = c(rv[1]), d = c(rv[2]);
  return [a, b, d, a * a, b * b, d * d, a * b, a * d, b * d];
}

/** Rotačný vektor (os·uhol, rad) kvaterniona; q a -q sú to isté otočenie. */
function rotVec(q: Quat): Vec3 {
  const sgn = q.w < 0 ? -1 : 1;
  const x = sgn * q.x, y = sgn * q.y, z = sgn * q.z;
  const n = Math.hypot(x, y, z);
  if (n < 1e-9) return [0, 0, 0];
  const ang = 2 * Math.atan2(n, sgn * q.w);
  return [(x / n) * ang, (y / n) * ang, (z / n) * ang];
}

const vDot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vLen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const vSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const vAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vUnit = (a: Vec3): Vec3 => { const n = vLen(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const vAngleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, vDot(vUnit(a), vUnit(b))))) * 180) / Math.PI;

/**
 * Automaticky naučené osi pre otočenú polohu (pozri SingleIMUController.autoAxes). Zdieľané medzi kontrolérmi v jednej stránke (menu, kreslenie,
 * hry) a uložené v localStorage podľa ruky, aby sa nemuseli učiť odznova. Platia len pre vstavaný profil ROLLED_PROFILE, nie pre ručnú "Kalibráciu osí".
 */
type AutoAxes = { eH: Vec3; eV: Vec3 };
const AUTO_AXES_KEY = 'rehapiano.autoAxes.v2'; // v1 bolo naučené bez korekcie oblúka doprava (pravá strana bola šikmá)
const autoAxesShared: Partial<Record<'left' | 'right', AutoAxes>> = {};
let autoAxesLoaded = false;
let autoAxesSavedAt = 0;
function loadAutoAxes() {
  if (autoAxesLoaded) return;
  autoAxesLoaded = true;
  try {
    const raw = localStorage.getItem(AUTO_AXES_KEY);
    const o = raw ? JSON.parse(raw) : {};
    for (const h of ['left', 'right'] as const) {
      const a = o?.[h];
      if (a && Array.isArray(a.eH) && Array.isArray(a.eV) && a.eH.length === 3 && a.eV.length === 3 && [...a.eH, ...a.eV].every(Number.isFinite)) {
        autoAxesShared[h] = { eH: a.eH as Vec3, eV: a.eV as Vec3 };
      }
    }
  } catch { /* bez localStorage sa osi učia len pre túto stránku */ }
}
function saveAutoAxes(now: number) {
  if (now - autoAxesSavedAt < 5000) return;
  autoAxesSavedAt = now;
  try { localStorage.setItem(AUTO_AXES_KEY, JSON.stringify(autoAxesShared)); } catch { /* ignore */ }
}
/** Zabudne naučené osi (jednej ruky alebo oboch) – ďalšie používanie sa učí odznova z ROLLED_PROFILE. */
export function resetAutoAxes(hand?: 'left' | 'right') {
  loadAutoAxes();
  if (hand) delete autoAxesShared[hand]; else { delete autoAxesShared.left; delete autoAxesShared.right; }
  autoAxesSavedAt = 0;
  saveAutoAxes(Date.now() + 6000);
}

/**
 * Adaptívne vyrovnanie dosahu (SingleIMUController.autoReach). Pre každú ruku a polohu ("normal"/"rolled") sa pre štyri smery [vpravo, vľavo, hore, dole]
 * pamätá typický vrchol výchylky P (priemer posledných vrcholov, EMA), počet pozorovaní n a zosilnenie g. Zdieľané medzi kontrolérmi, uložené v localStorage.
 */
type ReachStats = { P: number[]; n: number[]; g: number[] };
const REACH_KEY = 'rehapiano.autoReach.v1';
const reachShared: Record<string, ReachStats> = {};
let reachLoaded = false;
let reachSavedAt = 0;
const reachBlank = (): ReachStats => ({ P: [0, 0, 0, 0], n: [0, 0, 0, 0], g: [1, 1, 1, 1] });
function reachStats(key: string): ReachStats {
  if (!reachLoaded) {
    reachLoaded = true;
    try {
      const o = JSON.parse(localStorage.getItem(REACH_KEY) || '{}');
      for (const k of Object.keys(o || {})) {
        const r = o[k];
        if (r && ['P', 'n', 'g'].every((f) => Array.isArray(r[f]) && r[f].length === 4 && r[f].every(Number.isFinite))) reachShared[k] = r;
      }
    } catch { /* bez localStorage sa dosah učí len pre túto stránku */ }
  }
  return (reachShared[key] ??= reachBlank());
}
function saveReach(now: number) {
  if (now - reachSavedAt < 5000) return;
  reachSavedAt = now;
  try { localStorage.setItem(REACH_KEY, JSON.stringify(reachShared)); } catch { /* ignore */ }
}
/** Zabudne naučený dosah (celý alebo jednej ruky). */
export function resetAutoReach(hand?: 'left' | 'right') {
  reachStats('x');
  for (const k of Object.keys(reachShared)) if (!hand || k.startsWith(hand + ':')) delete reachShared[k];
  reachSavedAt = 0;
  saveReach(Date.now() + 6000);
}

/** Hladká verzia max(x, 0) (zaoblený zlom v nule, aby korekcia jednej strany nerobila "hranu" v trajektórii). */
const SMOOTH_POS_EPS = 0.08;
const smoothPos = (x: number) => (x + Math.sqrt(x * x + SMOOTH_POS_EPS * SMOOTH_POS_EPS)) / 2 - SMOOTH_POS_EPS / 2;

const wrapPi = (a: number) => {
  let d = a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// 46° bolo namerané skôr; záznam pose_20261102 (základná poloha) dáva ~62°: pri 46° uhýnal pohyb dole doľava (~45 % dĺžky), pri 62° ~5 %
export const TILT_ROTATION_RIGHT_DEG = 62; // korekcia natočenia senzora pravej rukavice (pozri tiltRotationDeg)

// Bolo 0,23 (pre natočenie 46°). Po zmene natočenia na 62° by ho zvyšok korekcie ťahal pri pohybe hore doľava (záznam pose_20261102: x = -0,19 pri y = -0,25);
// s 0 je krivka hore rovná (±0,1). Pri pohybe hore ruka uhýna doprava len pri starom natočení.
export const SHEAR_UP_RIGHT_HAND = 0;
export const SHEAR_RIGHT_RIGHT_HAND = 0.18; // pri pohybe doprava ruka uhýna dole: y -= 0.18*max(x,0)

export class SingleIMUController {
  private fPitch = 0;
  private fRoll = 0;
  private fGyroX = 0;
  private fGyroY = 0;
  private fGyroZ = 0;
  private lpLinAccX = 0;
  private lpLinAccY = 0;

  private posX = 0; // normalized -1..1
  private posY = 0;

  // === Plynulá interpolácia grid pozície ===
  private targetGridX = 0;
  private targetGridY = 0;
  private smoothGridX = 0;
  private smoothGridY = 0;
  private lastEmittedGridX = -1;
  private lastEmittedGridY = -1;
  public gridSmoothAlpha = 0.12; // Nižšia hodnota = plynulejší pohyb (0.08-0.2)
  public cellHysteresis = 0.25; // o koľko bunky za hranicu musí vyhladená poloha prejsť, aby sa bunka zmenila (0.2-0.3)

  // === Gyro hysterézia pre lepšiu separáciu akcií ===
  private gyroZWasReleased = true;
  private gyroXWasReleased = true;
  private gyroYWasReleased = true;
  private gyroZReleasedAt = 0; // Kedy začal byť gyroskop pod thresholdom
  private gyroXReleasedAt = 0;
  private gyroYReleasedAt = 0;
  public gyroReleaseThreshold = 8; // °/s - gyroskop musí klesnúť pod túto hodnotu
  public gyroReleaseTimeMs = 500; // ms - ako dlho musí byť pod thresholdom

  // quaternion calibration: neutral pose (nulový bod náklonu; mení ho aj recenter)
  private qNeutralInv: Quat | null = null;
  private restQuat: Quat | null = null; // poloha pri poslednom recentre/kalibrácii (z nej sa vyberá profil osí)
  // Profily osí (z "Kalibrácie osí") pre rôzne polohy rukavice. Po otočení rukavice (napr. o 90°) sa "vpravo/hore" robí iným pohybom,
  // preto sa profil vyberá podľa uhla krútenia rukavice (roll) pri recentre. Bez zhodného profilu platí pôvodný model.
  public axisProfiles: AxisProfile[] = [];
  // true = kurzor sleduje, kam v priestore ukazuje os Z senzora (ako laserové ukazovátko): vodorovne azimut, zvisle výška. Otočenie
  // rukavice okolo tejto osi (napr. o 90°) ukazovanie nemení, takže smery ostávajú správne; staré korekcie (natočenie 46°, shear,
  // gains) a naučené profily sa v tomto režime nepoužijú (patria k modelu viazanému na osi senzora).
  public pointerTilt = false;
  public pointerGainX = 1;
  public pointerGainY = 1;
  // Po otočení rukavice je zvislý pohyb zápästia (vychýlenie k palcu/malíčku) oveľa menší než ohyb (cca 15° vs 45°): zvislé zosilnenie
  // rastie z 1 (základná poloha) až na tento pomer pri otočení o 90°. Nameraných ~±11° v otočenej polohe voči ~±30° v základnej.
  public pointerRolledRatio = 3;
  /** true = automatické prepočítanie nulového bodu pri zmene otočenia sa pozastaví (napr. počas ťahu perom: nulový bod uprostred ťahu by vytvoril "neviditeľnú stenu") */
  public freezePose = false;
  /** Doladenie otočenej polohy (len pre tento kontrolér): zosilnenie hore/dole a dodatočný bočný skos (x += k·y, y dole). Predvolene nič nemení. */
  public rolledTune: { up: number; down: number; shear: number; right?: number; left?: number; m?: [number, number, number, number] } = { up: 1, down: 1, shear: 0 };
  private stillMs = 0;     // ako dlho je ruka nehybná (na automatické rozpoznanie otočenej polohy)
  private isRolled = false; // rukavica je pri poslednom recentre otočená oproti základnej polohe -> vstavané osi ROLLED_PROFILE
  private refRoll: number | null = null; // krútenie (rad) v základnej polohe z globálnej kalibrácie
  private restAz = 0;
  private restEl = 0;
  private profilesSeen: AxisProfile[] | null = null;
  private activeProfile: AxisProfile | null = null;
  private lastRv: Vec3 = [0, 0, 0]; // otočenie od nulového bodu (rotačný vektor, rad) v osiach senzora
  private restRoll = 0;             // rad
  public recenterSeq = 0;           // počet recentrov (aj automatických pri rozpoznaní otočenej polohy) – volajúci podľa toho vie, že sa nulový bod zmenil

  // tuning
  public gyroDivisor = GYRO_DIVISOR; // 1 = streamer už posiela gyro v °/s
  public alphaOrient = 0.18;
  public deadzoneDeg = 3;
  public maxTiltDeg = 25;
  public maxSpeed = 1.0;
  public gridSize = 20;
  public precisionScale = 1.5;
  public lpAlphaHP = 0.18;
  public posAlpha = 0.28;


  public tiltClamp = 0.8;
  public tiltGain = 1.35;     
  public tiltDeadzone = 0.05;  
  // Horná hranica veľkosti vektora náklonu (1 = saturácia na okraji rozsahu) a výsledného posNorm. Kreslenie ich zvyšuje,
  // aby za okrajom rozsahu nebola "neviditeľná stena".
  public tiltMax = 1;
  public posLimit = 1;
  // true = izotropný náklon (kruhová mŕtva zóna a kruhové obmedzenie, žiadne tanh po osiach),
  // takže diagonály sú rovnako dosiahnuteľné ako osi. Používa kurzor v menu/kalibrácii; hry ostávajú na false.
  public linearTilt = false;
  // Otočenie vektora náklonu (°) v rovine X/Y: senzor v rukavici je voči ruke natočený (~46°), takže pohyb doprava
  // išiel šikmo dole a hore/dole šikmo do strán. Namerané z nahrávky (zhoda všetkých 4 smerov). 0 = bez korekcie.
  public tiltRotationDeg = 0;
  // true = náklon sa berie z uhla otočenia (rotačný vektor) namiesto priemetu osi Z. Priemet má tvar sin(uhol): pri veľkom
  // náklone saturuje a nakoniec obráti smer (čiara sa pri dlhom ťahu "zalomí"). Uhol je lineárny a otočenie okolo Z
  // (rotácia zápästia) kurzor nehýbe. Pri malých uhloch je výsledok rovnaký ako pri priemete.
  public angleTilt = false;
  // Doladenie po otočení (súradnice obrazovky: x doprava, y dole): oblúk zápästia ťahá pri pohybe hore doprava a pri pohybe
  // doprava dole. Opravuje sa len príslušná polovica osi (dole/doľava namerané sedeli). Hodnoty sú pre pravú ruku.
  public shearUp = 0;
  // Zosilenie náklonu (po korekciách, pred obmedzením na ±1): bežný náklon ruky dá len ~±0,5, takže 2 dosiahne celý rozsah.
  public posGain = 1;
  // Krivka odozvy: 0 = lineárna. Hodnota c>0: malý náklon dá jemnejší pohyb (sklon 1-c v strede), okraje ostávajú dosiahnuteľné
  // (r(m) = m·(1-c + c·m), r(1)=1). Presnosť pri pomalom navádzaní bez straty dosahu.
  public responseCurve = 0;
  // true = polohu filtruje One Euro filter (namiesto dvoch EMA + hysterézie): menej chvenia a menej oneskorenia zároveň.
  public oneEuro = false;
  public euroMinCutoff = 1.5; // Hz: čím nižšie, tým silnejšie vyhladenie pri pomalom pohybe
  public euroBeta = 40;      // čím vyššie, tým rýchlejšie sa vyhladenie uvoľní pri rýchlom pohybe (menšie oneskorenie)
  private euroX = new OneEuro();
  private euroY = new OneEuro();
  // Mapovanie na obrazovku pre korekcie (shear): pravá ruka x = -nx, ľavá y = -ny (rovnako ako v hrách/kreslení).
  public screenFlipX = true;
  public screenFlipY = false;
  public shearRight = 0;
  // Rôzny dosah zápästia v jednotlivých smeroch (pravá ruka: doľava býva len ~40 % dosahu doprava): zosilnenie podľa polosi,
  // aby rovnaké úsilie dalo rovnaký posun všade (inak sa kruh v slabšej polovici "zmenšuje" k stredu). 1 = bez zmeny.
  public gainRight = 1;
  public gainLeft = 1;
  public gainUp = 1;
  public gainDown = 1;

  private lastGestureTs = 0;
  private gestureCooldownMs = 300;

  public pickThreshold = 0.4;
  public releaseThreshold = 0.25;
  private gripActive = false;

  // === Automatické učenie osí pre otočenú polohu ===
  // true = z "ťahov" (priamych pohybov ruky ~250 ms) sa za chodu spresňujú osi vstavaného profilu ROLLED_PROFILE. Ťah, ktorý je na obrazovke
  // väčšinou vodorovný, má v rotačnom vektore smer h; väčšinou zvislý smer v. Os "vpravo" (eH) sa urobí kolmou na v a os "dole" (eV) kolmou na h,
  // takže zvislý pohyb nepúšťa do x a vodorovný do y (diagonála). Zosilnenie pozdĺž zamýšľaného smeru ostáva. Odchýlka od vstavaných osí je
  // obmedzená, učenie sa deje len mimo stisku prstov a len keď už je dosť ťahov oboch typov. Vypnuté = správanie ako doteraz.
  public autoAxes = false;
  public autoLearnedSeq = 0; // počet aplikovaných aktualizácií osí (na ladenie/zobrazenie)
  private autoBuf: { t: number; rv: Vec3; path: number }[] = [];
  private autoPath = 0;
  private autoLastTakeT = 0;
  private autoH: Vec3 = [0, 0, 0];
  private autoV: Vec3 = [0, 0, 0];
  private autoNH = 0;
  private autoNV = 0;
  private autoSince = 0;

  // === Adaptívne vyrovnanie dosahu ===
  // true = dosah výchylky sa vyrovná medzi smermi (vpravo/vľavo/hore/dole) aj medzi polohami (zvyčajná/otočená). Pre každý smer sa sleduje typický vrchol
  // výchylky ruky (pred zosilnením polohy) a zosilnenie sa nastaví tak, aby tento vrchol dal výchylku `autoReachTarget` (1 = okraj rozsahu). Ruka s malým
  // rozsahom v jednom smere (napr. doľava) tak dosiahne okraj rovnako ako v druhom. Vypnuté = správanie ako doteraz.
  public autoReach = false;
  public autoReachTarget = 0.9;   // vrchol výchylky -> tejto veľkosti (platí pred posGain; pri posGain 1,5 dajte 0,6)
  public autoReachMin = 0.5;      // medze zosilnenia: slabý smer sa nezosilní do šumu a silný sa nepotlačí do nuly
  public autoReachMax = 2.5;
  private reachActive = [false, false, false, false];
  private reachPeak = [0, 0, 0, 0];

  constructor() {}

  private reachKey() { return `${this.screenFlipX ? 'right' : 'left'}:${this.isRolled ? 'rolled' : 'normal'}`; }

  /** Sleduje výchylky v smeroch [vpravo, vľavo, hore, dole] (súradnice obrazovky, pred zosilnením) a vracia aktuálne zosilnenia. */
  private reachStep(sx: number, sy: number, observe: boolean): number[] {
    const st = reachStats(this.reachKey());
    if (!observe) { this.reachActive.fill(false); return st.g; }
    const ax = Math.abs(sx), ay = Math.abs(sy);
    const vals = [Math.max(0, sx), Math.max(0, -sx), Math.max(0, -sy), Math.max(0, sy)];
    for (let i = 0; i < 4; i++) {
      const dominant = i < 2 ? ax >= 1.5 * ay : ay >= 1.5 * ax; // diagonálne priechody sa do dosahu nepočítajú
      const v = vals[i];
      if (!dominant && v > 0) continue;
      if (v > 0.12) { this.reachActive[i] = true; this.reachPeak[i] = Math.max(this.reachPeak[i], v); }
      else if (this.reachActive[i] && v <= Math.max(0.06, 0.35 * this.reachPeak[i])) { // výchylka skončila: ruka sa vrátila (aj nie úplne k nule)
        const peak = this.reachPeak[i];
        this.reachActive[i] = false; this.reachPeak[i] = 0;
        if (peak < 0.15) continue;
        // horná obálka vrcholov: rastie rýchlo, klesá pomaly (cieľom je najväčší bežný výklon, nie priemer)
        st.P[i] = st.n[i] ? st.P[i] + (peak > st.P[i] ? 0.6 : 0.15) * (peak - st.P[i]) : peak;
        st.n[i]++;
        if (st.n[i] >= 3) {
          const want = Math.max(this.autoReachMin, Math.min(this.autoReachMax, this.autoReachTarget / st.P[i]));
          st.g[i] += 0.5 * (want - st.g[i]);
        }
        saveReach(Date.now());
      }
    }
    return st.g;
  }

  private autoHand(): 'left' | 'right' { return this.screenFlipX ? 'right' : 'left'; }

  /** Aktuálne osi pre vstavaný profil: naučené, ak existujú, inak ROLLED_PROFILE. */
  private autoCurrent(): AutoAxes {
    loadAutoAxes();
    return autoAxesShared[this.autoHand()] ?? { eH: ROLLED_PROFILE.eH, eV: ROLLED_PROFILE.eV };
  }

  /** Jeden krok učenia: zbiera ťahy a občas upraví osi. Volá sa len pri vstavanom profile a vypnutom stisku. */
  private autoStep(t: number) {
    const W = 250;
    const rv = this.lastRv;
    const prev = this.autoBuf[this.autoBuf.length - 1];
    if (prev) this.autoPath += vLen(vSub(rv, prev.rv));
    this.autoBuf.push({ t, rv, path: this.autoPath });
    while (this.autoBuf.length > 2 && t - this.autoBuf[1].t >= W) this.autoBuf.shift();
    const first = this.autoBuf[0];
    if (t - first.t < W * 0.8 || t - this.autoLastTakeT < W / 2) return;
    const D = vSub(rv, first.rv);
    const dist = vLen(D), pathLen = this.autoPath - first.path;
    if (dist < 0.07 || dist / Math.max(pathLen, 1e-6) < 0.85) return; // príliš malý alebo nepriamy pohyb
    this.autoLastTakeT = t;
    const cur = this.autoCurrent();
    // Učí sa v priestore po korekcii oblúka doprava (ta ostáva zapnutá): z ťahu sa odpočíta ten posun, ktorý jej shear odstráni
    const dx0 = vDot(D, cur.eH);
    const eVn2 = vDot(cur.eV, cur.eV) || 1;
    const Dadj = vSub(D, vScale(cur.eV, (rolledShearRight() * Math.max(dx0, 0)) / eVn2));
    const dx = vDot(Dadj, cur.eH), dy = vDot(Dadj, cur.eV);
    const RATIO = 0.6; // ťah je "vodorovný"/"zvislý", ak druhá zložka je pod 60 % hlavnej (~31°)
    const DECAY = 0.97;
    if (Math.abs(dy) <= RATIO * Math.abs(dx)) {
      this.autoH = vAdd(vScale(this.autoH, DECAY), vScale(Dadj, Math.sign(dx)));
      this.autoNH = this.autoNH * DECAY + 1;
    } else if (Math.abs(dx) <= RATIO * Math.abs(dy)) {
      this.autoV = vAdd(vScale(this.autoV, DECAY), vScale(Dadj, Math.sign(dy)));
      this.autoNV = this.autoNV * DECAY + 1;
    } else return; // diagonálny ťah sa do učenia nezapočítava
    this.autoSince++;
    if (this.autoNH < 5 || this.autoNV < 5 || this.autoSince < 4) return;
    this.autoSince = 0;
    // aplikuj len blízko nulového bodu, aby kurzor pri zmene osí neskočil
    if (vLen(rv) > 0.2) return;
    const h = vUnit(this.autoH), v = vUnit(this.autoV);
    if (Math.abs(vDot(h, v)) > 0.9) return; // ťahy ležia na jednej osi: smery sa nedajú rozlíšiť
    const e0H = ROLLED_PROFILE.eH, e0V = ROLLED_PROFILE.eV;
    const MAX_DEV = 40;
    const fix = (e0: Vec3, other: Vec3, own: Vec3): Vec3 | null => {
      const ortho = vSub(e0, vScale(other, vDot(e0, other)));      // kolmá na druhý smer
      const proj = vDot(ortho, own);
      const want = vDot(e0, own);                                   // zosilnenie pozdĺž zamýšľaného smeru ostáva ako vo vstavanom profile
      if (proj < 0.15 || want < 0.3) return null;
      const out = vScale(ortho, Math.max(0.5, Math.min(2, want / proj)));
      return vAngleDeg(out, e0) <= MAX_DEV ? out : null;
    };
    const nH = fix(e0H, v, h), nV = fix(e0V, h, v);
    if (!nH || !nV) return;
    const old = autoAxesShared[this.autoHand()] ?? { eH: e0H, eV: e0V };
    autoAxesShared[this.autoHand()] = { eH: vAdd(vScale(old.eH, 0.5), vScale(nH, 0.5)), eV: vAdd(vScale(old.eV, 0.5), vScale(nV, 0.5)) };
    this.autoLearnedSeq++;
    saveAutoAxes(Date.now());
  }

  public calibrateNeutral(qCurrent: Quat) {
    this.qNeutralInv = quatConjugate(qCurrent);
    this.setRest(qCurrent);
    this.refRoll = this.restRoll;
    this.updateRolled();
  }

  private updateRolled() {
    this.isRolled = isRolledRoll(this.restRoll);
  }

  /** Základná poloha rukavice (globálna kalibrácia) bez zmeny nulového bodu – podľa nej sa určí, o koľko je rukavica otočená. */
  public setReferenceQuat(q: Quat) {
    this.refRoll = gravityAngles(q).rho;
    this.updateRolled();
  }

  private setRest(q: Quat) {
    this.restQuat = q;
    this.restRoll = gravityAngles(q).rho;
    const pa = pointerAngles(q);
    this.restAz = pa.az;
    this.restEl = pa.el;
    if (this.refRoll === null) this.refRoll = this.restRoll;
    this.updateRolled();
    this.selectProfile();
  }

  /** Vyberie profil osí, ktorého uhol krútenia je najbližší aktuálnemu (max. 40°); inak null = pôvodný model. */
  private selectProfile() {
    let best: AxisProfile | null = null, bd = Infinity;
    for (const pr of this.axisProfiles) {
      const d = Math.abs(wrapPi(this.restRoll - (pr.roll * Math.PI) / 180));
      if (d < bd) { bd = d; best = pr; }
    }
    this.activeProfile = best && bd <= (40 * Math.PI) / 180 ? best : null;
  }

  /** Uhol krútenia rukavice okolo osi Z pri poslednom recentre/kalibrácii (°). */
  public get restRollDeg() { return (this.restRoll * 180) / Math.PI; }

  // Offsety pre fallback (pitch/roll) – nastavuje recenter()
  private pitchOffset = 0;
  private rollOffset = 0;

  /**
   * Prenastaví neutrálnu pozíciu na aktuálnu polohu ruky (volať pri stlačení všetkých prstov),
   * aby sa náklon nevzďaľoval od nuly a minimálny pohyb nespúšťal veľký posun/otočenie.
   */
  public recenter(rawImu: any) {
    this.recenterSeq++;
    const imu = normalizeImuSample(rawImu, this.gyroDivisor);
    if (imu.quat && imu.quat.w !== undefined) {
      this.qNeutralInv = quatConjugate(imu.quat);
      this.setRest(imu.quat);
    }
    this.pitchOffset = imu.pitchDeg;
    this.rollOffset = imu.rollDeg;
    this.fPitch = imu.pitchDeg;
    this.fRoll = imu.rollDeg;
    this.posX = 0;
    this.posY = 0;
    this.reachActive.fill(false); this.reachPeak.fill(0); // výchylka sa meria od nového nulového bodu
    this.euroX.reset(0);
    this.euroY.reset(0);
    this.resetPosition(); // kurzor ihneď na stred, aby sa po recentre nešmýkal
  }

  public update(sample: Sample, dtSec: number) {
    const t = sample.ts ?? performance.now();
    const imu = normalizeImuSample(sample.imu, this.gyroDivisor);

    this.fPitch = ema(this.fPitch, imu.pitchDeg, this.alphaOrient);
    this.fRoll = ema(this.fRoll, imu.rollDeg, this.alphaOrient);
    this.fGyroX = ema(this.fGyroX, imu.gyroX_dps, 0.12);
    this.fGyroY = ema(this.fGyroY, imu.gyroY_dps, 0.12);
    this.fGyroZ = ema(this.fGyroZ, imu.gyroZ_dps, 0.12);

    // HP on linAcc
    const aX = imu.linAccX;
    const aY = imu.linAccY;
    this.lpLinAccX = ema(this.lpLinAccX, aX, this.lpAlphaHP);
    this.lpLinAccY = ema(this.lpLinAccY, aY, this.lpAlphaHP);
    const hpX = aX - this.lpLinAccX;
    const hpY = aY - this.lpLinAccY;

        const fingers = (sample.adc || []).slice(1,5);
    const maxGrip = fingers.length ? Math.max(...fingers.map(normalizeAdc)) : 0;
    if (!this.gripActive && maxGrip > this.pickThreshold) this.gripActive = true;
    else if (this.gripActive && maxGrip < this.releaseThreshold) this.gripActive = false;

    const precision = this.gripActive ? this.precisionScale : 1.0;

  // Quaternion mapovanie kurzora
    // Rozpoznanie otočenej polohy: keď ruka chvíľu stojí (a nedrží), pozrie sa na aktuálne krútenie rukavice; ak sa líši od uloženého
    // stavu, urobí recenter v tejto polohe. Počas pohybu sa stav nemení (pri geste "vpravo" sa krútenie mení o desiatky stupňov).
    const stillNow = Math.abs(this.fGyroX) < 12 && Math.abs(this.fGyroY) < 12 && Math.abs(this.fGyroZ) < 12;
    this.stillMs = stillNow && !this.freezePose ? this.stillMs + dtSec * 1000 : 0;
    if (this.stillMs > 700 && !this.gripActive && imu.quat && imu.quat.w !== undefined) {
      this.stillMs = 0;
      if (isRolledRoll(gravityAngles(imu.quat).rho) !== this.isRolled) {
        this.recenter(sample.imu); // nový nulový bod v zistenej polohe; ďalej pokračuje tento istý update
      }
    }

    let nx = 0, ny = 0;
    let legacyCorr = true; // staré korekcie osí (natočenie, shear, gains) platia len pre pôvodný model náklonu
    if (imu.quat && imu.quat.w !== undefined) {
      
      let q = imu.quat;
      if (this.profilesSeen !== this.axisProfiles) {
        this.profilesSeen = this.axisProfiles;
        if (this.restQuat) this.selectProfile();
      }
      if (!this.restQuat) { this.qNeutralInv = quatConjugate(q); this.setRest(q); }
      if (this.qNeutralInv) {
        q = quatMultiply(this.qNeutralInv, q);
      }
      this.lastRv = rotVec(q);
      const builtin = !this.activeProfile && this.isRolled;
      const prof = this.activeProfile ?? (builtin ? ROLLED_PROFILE : null);
      if (this.pointerTilt) {
        legacyCorr = false;
        const pa = pointerAngles(imu.quat);
        // pri takmer zvislej osi Z azimut nie je definovaný -> plynulo vypnúť vodorovnú zložku
        const w = Math.max(0, Math.min(1, (pa.xy - 0.2) / 0.2));
        const dAz = wrapPi(pa.az - this.restAz) * w;
        const dEl = pa.el - this.restEl;
        const th = wrapPi(this.restRoll - (this.refRoll ?? this.restRoll)); // o koľko je rukavica otočená oproti základnej polohe
        const rolledGain = Math.hypot(Math.cos(th), Math.sin(th) * this.pointerRolledRatio);
        const sxv = -dAz * this.pointerGainX;              // + = vpravo (azimút klesá)
        const syv = -dEl * this.pointerGainY * rolledGain; // + = dole (výška rastie pri pohybe hore)
        const vx = ((this.screenFlipX ? -1 : 1) * sxv) / this.tiltClamp;
        const vy = ((this.screenFlipY ? -1 : 1) * syv) / this.tiltClamp;
        const mag = Math.hypot(vx, vy);
        const dzr = this.tiltDeadzone / this.tiltClamp;
        if (mag > dzr) {
          const k = Math.min(this.tiltMax, (mag - dzr) / (1 - dzr)) / mag;
          nx = vx * k * precision;
          ny = vy * k * precision;
        }
      } else if (prof) {
        if (builtin) legacyCorr = false; // vstavané osi sú už zarovnané s obrazovkou: bez natočenia 46°, shear a gains
        // osi "vpravo" a "dole" naučené z pohybov v tejto polohe rukavice (promietnutie rotačného vektora)
        let rx: number, ry: number;
        if (prof.mx && prof.my) {
          const f = profileFeatures(this.lastRv);
          rx = 0; ry = 0;
          for (let i = 0; i < f.length; i++) { rx += prof.mx[i] * f[i]; ry += prof.my[i] * f[i]; }
        } else {
          let eHv = prof.eH, eVv = prof.eV;
          if (builtin && this.autoAxes) {
            if (!this.gripActive) this.autoStep(t);
            const a = this.autoCurrent();
            eHv = a.eH; eVv = a.eV;
          }
          rx = this.lastRv[0] * eHv[0] + this.lastRv[1] * eHv[1] + this.lastRv[2] * eHv[2];
          ry = this.lastRv[0] * eVv[0] + this.lastRv[1] * eVv[1] + this.lastRv[2] * eVv[2];
        }
        const sxv = rx * (rx > 0 ? prof.gains.right : prof.gains.left);
        const syv = ry * (ry > 0 ? prof.gains.down : prof.gains.up);
        const vx = ((this.screenFlipX ? -1 : 1) * sxv) / this.tiltClamp;
        const vy = ((this.screenFlipY ? -1 : 1) * syv) / this.tiltClamp;
        const mag = Math.hypot(vx, vy);
        const dzr = this.tiltDeadzone / this.tiltClamp;
        if (mag > dzr) {
          const k = Math.min(this.tiltMax, (mag - dzr) / (1 - dzr)) / mag;
          nx = vx * k * precision;
          ny = vy * k * precision;
        }
        if (builtin) {
          const fx = this.screenFlipX ? -1 : 1, fy = this.screenFlipY ? -1 : 1;
          const sx0 = fx * nx, sy0 = fy * ny; // súradnice obrazovky (x doprava, y dole)
          const tg = this.rolledTune;
          if (tg.m) {
            // čisto lineárna korekcia (matica 2x2 v súradniciach obrazovky): nezávisí od toho, kde sa nula vynulovala, a zachová kruh ako kruh
            nx = fx * (tg.m[0] * sx0 + tg.m[1] * sy0);
            ny = fy * (tg.m[2] * sx0 + tg.m[3] * sy0);
          } else {
          // zosilnenie vpravo/vľavo plynule cez nulu (bez hrany): zápästie má v otočenej polohe na jednu stranu menší dosah
          const sxg = sx0 + ((tg.right ?? 1) - 1) * smoothPos(sx0) - ((tg.left ?? 1) - 1) * smoothPos(-sx0);
          nx = fx * (sxg + (this.autoAxes && autoAxesShared[this.autoHand()] ? 0 : rolledShearVert()) * sy0); // s naučenými osami sa perekos rieši osami
          const t = this.rolledTune;
          if (t.shear !== 0) nx = fx * (fx * nx + t.shear * sy0);
          ny = fy * ((sy0 - rolledShearRight() * smoothPos(sx0)) * (sy0 > 0 ? t.down : t.up)); // oblúk zápästia je jednostranný (len doprava): lineárne naučené osi ho nevedia nahradiť, preto platí vždy
          }
        }
      } else {
      // To find tilt, rotate the world "up" vector by the INVERSE of device orientation
      // This tells us which way "up" points in the device's local frame
      const qInv = quatConjugate(q);
      const worldUp: Vec3 = [0, 0, 1]; // world frame: Z is up
      const deviceUp = rotateVecByQuat(qInv, worldUp);
      let tiltX = deviceUp[1]; // horizontal
      let tiltY = deviceUp[0]; // vertical
      if (this.angleTilt) {
        const sgn = q.w < 0 ? -1 : 1; // q a -q sú to isté otočenie
        const vx = sgn * q.x, vy = sgn * q.y, vz = sgn * q.z;
        const vn = Math.hypot(vx, vy, vz);
        if (vn > 1e-6) {
          const ang = 2 * Math.atan2(vn, sgn * q.w); // rad, 0..π
          tiltX = (vx / vn) * ang;
          tiltY = -(vy / vn) * ang;
        } else {
          tiltX = 0; tiltY = 0;
        }
      }
      
      // deviceUp now shows where world-up points in device coordinates
      // If device tilts right, deviceUp.y becomes negative (up is to the left in device frame)
      // If device tilts forward, deviceUp.x becomes negative (up is behind in device frame)
      
  if (this.linearTilt) {
    // Vektor náklonu (X,Y) sa škáluje ako celok: smer sa zachová (aj diagonálny), obmedzuje sa len dĺžka
    const vx = tiltX / this.tiltClamp;
    const vy = tiltY / this.tiltClamp;
    const mag = Math.hypot(vx, vy);
    const dzr = this.tiltDeadzone / this.tiltClamp;
    if (mag > dzr) {
      const k = Math.min(this.tiltMax, (mag - dzr) / (1 - dzr)) / mag;
      nx = vx * k * precision;
      ny = vy * k * precision;
    }
  } else {
  // Apply small deadzone to suppress noise
  const dz = this.tiltDeadzone;
  const upX = Math.abs(tiltX) < dz ? 0 : tiltX; // horizontal
  const upY = Math.abs(tiltY) < dz ? 0 : tiltY; // vertical

  // Clamp and shape: scale by tiltClamp (smaller -> more sensitive), then tanh with tiltGain
  const sx = upX / this.tiltClamp;
  const sy = upY / this.tiltClamp;
  const shapedX = Math.tanh(this.tiltGain * sx);
  const shapedY = Math.tanh(this.tiltGain * sy);

  nx = shapedX * precision;
  ny = shapedY * precision;
  }
      }
    } else {
      // Fallback: use pitch/roll (Euler-based) if no quat
      const pitch = Math.abs(this.fPitch - this.pitchOffset) < this.deadzoneDeg ? 0 : this.fPitch - this.pitchOffset;
      const roll = Math.abs(this.fRoll - this.rollOffset) < this.deadzoneDeg ? 0 : this.fRoll - this.rollOffset;

      const normTilt = (v: number) => {
        const c = Math.max(-1, Math.min(1, v / this.maxTiltDeg));
        return Math.sign(c) * Math.pow(Math.abs(c), 3);
      };

      nx = normTilt(roll) * precision;
      ny = normTilt(pitch) * precision;
    }

    if (legacyCorr && this.tiltRotationDeg !== 0 && imu.quat && imu.quat.w !== undefined) {
      const a = (this.tiltRotationDeg * Math.PI) / 180;
      const rx = nx * Math.cos(a) - ny * Math.sin(a);
      const ry = nx * Math.sin(a) + ny * Math.cos(a);
      nx = rx; ny = ry;
    }
    const asym = this.gainRight !== 1 || this.gainLeft !== 1 || this.gainUp !== 1 || this.gainDown !== 1;
    if (legacyCorr && (this.shearUp !== 0 || this.shearRight !== 0 || asym) && imu.quat && imu.quat.w !== undefined) {
      const fx = this.screenFlipX ? -1 : 1, fy = this.screenFlipY ? -1 : 1;
      const sx0 = fx * nx, sy0 = fy * ny; // súradnice obrazovky (x doprava, y dole)
      let sx = sx0 + this.shearUp * Math.min(sy0, 0);
      let sy = sy0 - this.shearRight * Math.max(sx0, 0);
      sx *= sx > 0 ? this.gainRight : this.gainLeft;
      sy *= sy > 0 ? this.gainDown : this.gainUp;
      nx = fx * sx;
      ny = fy * sy;
    }

    if (this.autoReach && imu.quat && imu.quat.w !== undefined) {
      const fx = this.screenFlipX ? -1 : 1, fy = this.screenFlipY ? -1 : 1;
      const sx0 = fx * nx, sy0 = fy * ny; // súradnice obrazovky (x doprava, y dole), po korekciách osí a pred zosilnením polohy
      const g = this.reachStep(sx0, sy0, !this.gripActive);
      nx = fx * sx0 * (sx0 > 0 ? g[0] : g[1]);
      ny = fy * sy0 * (sy0 > 0 ? g[3] : g[2]);
    }

    if (this.responseCurve > 0) {
      const m = Math.min(1, Math.hypot(nx, ny));
      if (m > 1e-6) {
        const c = this.responseCurve;
        const k = (m * (1 - c + c * m)) / m;
        nx *= k; ny *= k;
      }
    }
    nx *= this.posGain;
    ny *= this.posGain;

    // Smoothly move pos towards target normalized tilt
    if (this.oneEuro) {
      this.euroX.minCutoff = this.euroY.minCutoff = this.euroMinCutoff;
      this.euroX.beta = this.euroY.beta = this.euroBeta;
      this.posX = this.euroX.filter(nx, dtSec);
      this.posY = this.euroY.filter(ny, dtSec);
    } else {
      this.posX = ema(this.posX, nx, this.posAlpha);
      this.posY = ema(this.posY, ny, this.posAlpha);
    }
    this.posX = Math.max(-this.posLimit, Math.min(this.posLimit, this.posX));
    this.posY = Math.max(-this.posLimit, Math.min(this.posLimit, this.posY));

    // === Aktualizuj hysteréziu gyroskopu s časovou podmienkou ===
    // Gyroskop musí byť pod thresholdom aspoň gyroReleaseTimeMs pred ďalšou akciou
    if (Math.abs(this.fGyroZ) < this.gyroReleaseThreshold) {
      // Začalo uvoľňovanie - zapiš čas ak ešte nebol
      if (this.gyroZReleasedAt === 0) {
        this.gyroZReleasedAt = t;
      }
      // Skontroluj či už prešiel dostatočne dlhý čas
      if (t - this.gyroZReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroZWasReleased = true;
      }
    } else {
      // Gyroskop je nad thresholdom - resetuj čas
      this.gyroZReleasedAt = 0;
    }
    
    if (Math.abs(this.fGyroX) < this.gyroReleaseThreshold) {
      if (this.gyroXReleasedAt === 0) {
        this.gyroXReleasedAt = t;
      }
      if (t - this.gyroXReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroXWasReleased = true;
      }
    } else {
      this.gyroXReleasedAt = 0;
    }
    
    // Gyro Y hysterézia (pre prepínanie blokov)
    if (Math.abs(this.fGyroY) < this.gyroReleaseThreshold) {
      if (this.gyroYReleasedAt === 0) {
        this.gyroYReleasedAt = t;
      }
      if (t - this.gyroYReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroYWasReleased = true;
      }
    } else {
      this.gyroYReleasedAt = 0;
    }

    let gesture: string | null = null;
    if (t - this.lastGestureTs > this.gestureCooldownMs) {
      if (hpX > 0.9) { gesture = 'flick-right'; this.lastGestureTs = t; }
      else if (hpX < -0.9) { gesture = 'flick-left'; this.lastGestureTs = t; }
      else if (hpY > 1.0) { gesture = 'flick-up'; this.lastGestureTs = t; }
      else if (hpY < -1.0) { gesture = 'flick-down'; this.lastGestureTs = t; }
    }

    // === Plynulá interpolácia grid pozície s hysteréziou ===
    const rawGridX = ((this.posX * 0.5) + 0.5) * (this.gridSize - 1);
    const rawGridY = ((this.posY * 0.5) + 0.5) * (this.gridSize - 1);
    
    this.targetGridX = Math.max(0, Math.min(this.gridSize - 1, rawGridX));
    this.targetGridY = Math.max(0, Math.min(this.gridSize - 1, rawGridY));
    
    // Plynulý prechod k cieľovej pozícii pomocou EMA
    if (this.oneEuro) {
      this.smoothGridX = this.targetGridX; // vyhladenie už urobil One Euro filter
      this.smoothGridY = this.targetGridY;
    } else {
      this.smoothGridX = ema(this.smoothGridX, this.targetGridX, this.gridSmoothAlpha);
      this.smoothGridY = ema(this.smoothGridY, this.targetGridY, this.gridSmoothAlpha);
    }
    
    // Hysterézia: bunka sa zmení až keď vyhladená poloha prejde za hranicu o `cellHysteresis`
    // (0.5 = hranica susednej bunky + rezerva), takže chvenie na hranici bunky nič neprepína.
    let gx = this.lastEmittedGridX;
    let gy = this.lastEmittedGridY;

    if (this.lastEmittedGridX < 0) {
      gx = Math.round(this.smoothGridX);
      gy = Math.round(this.smoothGridY);
    } else {
      const limit = 0.5 + this.cellHysteresis;
      if (Math.abs(this.smoothGridX - gx) > limit) gx = Math.round(this.smoothGridX);
      if (Math.abs(this.smoothGridY - gy) > limit) gy = Math.round(this.smoothGridY);
    }

    gx = Math.max(0, Math.min(this.gridSize - 1, gx));
    gy = Math.max(0, Math.min(this.gridSize - 1, gy));
    this.lastEmittedGridX = gx;
    this.lastEmittedGridY = gy;

    return {
      posNorm: { x: this.posX, y: this.posY },
      grid: { x: gx, y: gy },
      smoothGrid: { x: this.smoothGridX, y: this.smoothGridY },
      grip: this.gripActive,
      precision,
      rolled: this.isRolled,
      rv: this.lastRv,
      restRollDeg: this.restRollDeg,
      profileActive: !!this.activeProfile,
      gesture,
      rotateGesture: Math.abs(this.fGyroZ) > 150 ? (this.fGyroZ > 0 ? 'rotate-cw' : 'rotate-ccw') : null,
      // expose smoothed gyro rates for external mapping (deg/s)
      gyro: { x: this.fGyroX, y: this.fGyroY, z: this.fGyroZ },
      // === Nové: Flagy pre hysteréziu gyroskopu ===
      gyroZWasReleased: this.gyroZWasReleased,
      gyroXWasReleased: this.gyroXWasReleased,
      gyroYWasReleased: this.gyroYWasReleased,
      snap: this.gripActive ? { snapX: gx, snapY: gy } : null,
    };
  }

  // === Metódy na označenie, že gesto bolo vykonané ===
  public consumeGyroZ() {
    this.gyroZWasReleased = false;
  }
  
  public consumeGyroX() {
    this.gyroXWasReleased = false;
  }
  
  public consumeGyroY() {
    this.gyroYWasReleased = false;
  }

  // === Reset pozície (volať pri zmene levelu) ===
  public resetPosition(gridX?: number, gridY?: number) {
    const x = gridX ?? (this.gridSize - 1) / 2;
    const y = gridY ?? (this.gridSize - 1) / 2;
    this.smoothGridX = x;
    this.smoothGridY = y;
    this.targetGridX = x;
    this.targetGridY = y;
    this.lastEmittedGridX = Math.round(x);
    this.lastEmittedGridY = Math.round(y);
  }

  public calibrateZero(pitchDeg: number, rollDeg: number) {
    this.fPitch = pitchDeg;
    this.fRoll = rollDeg;
  }
}

export default SingleIMUController;
