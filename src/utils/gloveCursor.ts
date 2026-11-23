// Pohyb ruky -> poloha kurzora (-1..1), spoločný pre Pentomino, Tetris a "Presúvanie blokov". Bez Reactu a DOM.
//
// Pôvodne žil priamo v PentominoGame (a jeho predloha v "Skúške kreslenia"), kde vpravo/vľavo/hore/dole funguje dobre:
// lineárny náklon z uhla (bez krivky odozvy a mŕtvej zóny), kotva kurzora (poloha = kotva + náklon), zosilnenie podľa rýchlosti ruky,
// zmrazenie kurzora pri stisku a uvoľnení prstov, vynulovanie náklonu pri stisku a po uvoľnení a 3 s držanie = nový nulový bod.
// Staršie hry (Tetris, presúvanie blokov) mali vlastný, horší model (pôvodný náklon, deliteľ gyra 16, stisk z pevného prahu);
// teraz používajú tento.
//
// "Stisk" (hold) určuje hra: Pentomino a Tetris = celá ruka (gripOf), presúvanie blokov = aktívny prst. Vrstva podľa neho zmrazí
// kurzor a vynuluje náklon; čo stisk v hre znamená, rieši hra.
import SingleIMUController, { type Sample } from './imuController';
import { applyAxisCorr } from './axisCalibration';
import { applyCursorModel } from './cursorModel';
import { normalizeImuSample } from './imuNormalize';
import { SpeedGain, PENTOMINO_SPEED_GAIN } from './speedGain';
import { fuseSigned, DUAL_LEFT_GYRO_SIGN } from './dualHands';

// Pohyb ruky -> kurzor je rovnaký ako v "Skúške kreslenia" (ShapeTraceModal), kde vpravo/vľavo/hore/dole funguje dobre:
// lineárne (bez krivky odozvy), bez mŕtvej zóny, zosilnenie 1 v oboch osiach, bez One Euro filtra.
// Predtým: zosilnenie 1,5 + krivka 0,5 + zvislá os ×1/1,5 + mŕtva zóna 0,05 – smery mali rozdielnu citlivosť a začiatok pohybu "lepil".
export const HAND_POS_GAIN = 1;
// Vľavo/vpravo silnejšie: plátno kreslenia je široké (vodorovne w/2 px na jednotku, ~1,7× viac ako zvisle), hracie pole
// Pentomina je štvorcové (20×20), takže pri rovnakom zosilnení bol vodorovný pohyb ~1,7× slabší. Zápästie má navyše
// vodorovne menší rozsah. Hore/dole ostáva 1 (funguje dobre).
export const HAND_X_GAIN = 1.7;
export const HAND_Y_SCALE = 1;
// Zosilnenie podľa rýchlosti ruky (utils/speedGain.ts): pomalý pohyb ×0,6 (presné dosadnutie, menej chvenia), rýchly ×1,3 (dosah).
export const HAND_SPEED_GAIN = true;
export const HAND_RESPONSE_CURVE = 0;
export const HAND_TILT_DEADZONE = 0;
// Menej vyhladenia ako v kreslení (0,35 + posAlpha 0,28 dávalo ~50 ms oneskorenia); bloky idú po bunkách s hysteréziou,
// takže tremor sa na nich neprejaví.
export const CURSOR_SMOOTH = 0.6;
export const HAND_POS_ALPHA = 0.45;
export const GRIP_RECENTER_MS = 180; // po stisku prstov (ruka sa pri stisku hýbe) sa náklon vynuluje v aktuálnej polohe: tak sa rozpozná aj otočená ruka ("kosť") a korekcie osí platia okolo skutočného nuly
export const CALIB_HOLD_MS = 3000;   // stisk bez pohybu takto dlho (ak to hra povolí) = nový nulový bod ruky a kurzor do stredu (3 s, aby sa nezamenilo s bežným stiskom)
export const CALIB_STILL = 0.12;     // 'bez pohybu': kurzor (rozsah -1..1) sa nesmie pohnúť o viac ako toľko, inak odmeriavanie začína odznova
export const CALIB_SHOW_MS = 500;    // priebeh sa ukazuje až po tomto čase (krátky stisk ho neukáže)
// Stisk aj uvoľnenie prstov samo nakloní rukavicu (na záznamoch 3–7°, t. j. ~1–2 bunky). Pri stisku to pohltí vynulovanie
// po GRIP_RECENTER_MS; pri uvoľnení nie, preto kurzor po pustení bloku "uletel". Počas oboch prechodov kurzor stojí.
export const GRIP_FREEZE_MS = GRIP_RECENTER_MS + 60; // od začiatku stisku do vynulovania (s rezervou, aby vynulovanie padlo ešte do zmrazenia)
export const RELEASE_FREEZE_MS = 350;   // po uvoľnení: prsty sa otvárajú postupne (stisk končí už prvým uvoľneným prstom)
export const RELEASE_LOOKBACK_MS = 80;  // poloha pred uvoľnením: naklonenie začína ešte pred tým, ako prst klesne pod prah
const HISTORY_MS = 300;

export type Pos = { x: number; y: number };
export type Hand = 'left' | 'right';

/** Kontrolér hlavnej ruky nastavený ako v "Skúške kreslenia" (izotropný lineárny náklon z uhla, gyro v °/s). */
export function createCursorController(): SingleIMUController {
  const c = new SingleIMUController();
  c.gyroDivisor = 1; // streamer posiela gyro už v °/s
  c.linearTilt = true;
  c.angleTilt = true;
  c.precisionScale = 1; // stisk prstov nesmie meniť polohu kurzora pri rovnakom náklone
  c.posGain = HAND_POS_GAIN;
  // bez One Euro filtra, lineárna odozva, bez mŕtvej zóny (kurzor ide presne za rukou)
  c.oneEuro = false;
  c.posAlpha = HAND_POS_ALPHA;
  c.responseCurve = HAND_RESPONSE_CURVE;
  c.cellHysteresis = 0.3;
  c.tiltDeadzone = HAND_TILT_DEADZONE;
  // Otočená poloha ako v kreslení: pevné vstavané osi bez priebežného učenia (cukalo kurzorom) a pevné zosilnenie bez vyrovnávania dosahu.
  c.autoReach = false;
  c.autoReachTarget = 0.6;
  c.autoAxes = false;
  applyCursorModel(c); // model pohyb -> kurzor: prepína sa v utils/cursorModel.ts
  c.rolledTune = { up: 1.4, down: 1.7, shear: -0.2, right: 1, left: 1 }; // len otočená poloha; ladenie: localStorage 'rehapiano.drawRolled' (rovnaké ako v kreslení)
  try {
    const raw = localStorage.getItem('rehapiano.drawRolled');
    if (raw) c.rolledTune = { ...c.rolledTune, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  c.tiltMax = 4; // bez saturácie nakláňania a polohy: kurzor ide plynule až na okraj a nezasekne sa
  c.posLimit = 4;
  return c;
}

/** Bunka mriežky (desatinná, 0..n-1) <-> poloha kurzora -1..1. */
export const posToCell = (v: number, n: number) => ((v + 1) / 2) * (n - 1);
export const cellToPos = (c: number, n: number) => (n > 1 ? (c / (n - 1)) * 2 - 1 : 0);

export type GloveCursorHooks = {
  /** Pri uvoľnení: kde má kurzor ostať (Pentomino: na bloku, ktorý sa držal); null = poloha ruky tesne pred uvoľnením. */
  heldCursor?: () => Pos | null;
  /** Volá sa, keď sa pri uvoľnení použil heldCursor (Pentomino: zahodí posun z otáčania v inpute). */
  onHeldRelease?: () => void;
  /** Smie sa po GRIP_RECENTER_MS stisku vynulovať náklon? (Pentomino: nie, ak sa blok už pohol alebo otočil.) */
  canGripRecenter?: () => boolean;
  /** Smie sa dlhý stisk bez pohybu považovať za nový nulový bod? Bez tejto funkcie nie (Tetris a presúvanie blokov držia stisk pri presune). */
  canCalibrate?: () => boolean;
};

export type GloveCursorInput = {
  sample: Sample;
  /** ruka hlavného kontroléra (podľa zariadenia, záložne podľa voľby v menu) */
  hand: Hand;
  /** stisk podľa hry */
  hold: boolean;
  dt: number;
  /** režim dvoch rúk: posledná vzorka a výstup kontroléra ľavej ruky (pozri feedLeft) */
  left?: { sample: any; out: any } | null;
  now?: number;
};

export type GloveCursorStep = {
  position: Pos;
  out: ReturnType<SingleIMUController['update']>;
  rolled: boolean;
  /** gyro °/s; dve ruky: len pohyb, na ktorom sa obe zhodnú */
  gyro: { x: number; y: number; z: number };
  /** 0..1 priebeh dlhého stisku (nový nulový bod), 0 = nič */
  calibProg: number;
  /** v tejto vzorke sa dokončil nový nulový bod (kurzor je v strede) */
  calibrated: boolean;
};

export class GloveCursor {
  readonly ctrl: SingleIMUController = createCursorController();
  ctrlL: SingleIMUController | null = null;
  private anchor: Pos = { x: 0, y: 0 };
  private last: Pos = { x: 0, y: 0 };
  private prevGrip = false;
  private freeze: { pos: Pos | null; until: number; release: boolean } = { pos: null, until: 0, release: false };
  private hist: { t: number; x: number; y: number }[] = [];
  private gripStart = 0;
  private gripRecentered = false;
  private calibStart = 0;
  private calibPos: Pos = { x: 0, y: 0 };
  private speed = new SpeedGain(PENTOMINO_SPEED_GAIN);
  private speedSeq = -1;

  constructor(public hooks: GloveCursorHooks = {}) {}

  /**
   * Kontrolér ľavej ruky pre režim dvoch rúk (vytvorí sa pri prvej potrebe). Nastavený rovnako ako hlavný (createCursorController):
   * predtým to bol holý SingleIMUController so starým modelom (tanh, mŕtva zóna 0,05, saturácia na ±1, precisionScale 1,5 = stisk
   * zmenil citlivosť ľavej ruky 1,5× a kurzor pri stisku skočil) a bez korekcie osí ľavej ruky – a jeho poloha sa priemerovala s pravou.
   */
  ensureLeft(): SingleIMUController {
    if (!this.ctrlL) {
      this.ctrlL = createCursorController();
      applyAxisCorr(this.ctrlL, 'left');
    }
    return this.ctrlL;
  }

  get position(): Pos { return { ...this.last }; }

  /** Kurzor do stredu (nová kalibrácia, nový level). */
  reset() {
    this.anchor = { x: 0, y: 0 };
    this.last = { x: 0, y: 0 };
  }

  /**
   * Presunie kurzor na `p` bez skoku pri ďalšom pohybe ruky (posunie sa kotva). Hry s relatívnym presunom (Tetris, presúvanie blokov)
   * tak pri začiatku stisku "položia" kurzor na blok: blok ide za rukou od svojej polohy a okraj kurzora je okraj poľa.
   */
  setPosition(p: Pos) {
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    this.last = { ...p };
    this.anchor = { x: this.anchor.x + dx, y: this.anchor.y + dy };
    if (this.freeze.pos) this.freeze.pos = { ...p };
    this.hist = [];
  }

  private recenterAll(sample: Sample, left: { sample: any } | null | undefined) {
    this.ctrl.recenter(sample.imu);
    if (left) this.ctrlL?.recenter(left.sample.imu);
  }

  /** Jedna vzorka hlavnej ruky. */
  step(inp: GloveCursorInput): GloveCursorStep {
    const ctrl = this.ctrl;
    const now = inp.now ?? performance.now();
    const grip = inp.hold;
    const dualL = inp.left ?? null;

    applyAxisCorr(ctrl, inp.hand);
    // počas stisku sa nulový bod (a rozpoznanie otočenej ruky) nesmie meniť, inak vznikne neviditeľná stena
    ctrl.freezePose = grip;
    if (this.ctrlL) this.ctrlL.freezePose = grip; // dve ruky: platí aj pre ľavú (jej vzorky idú cez feedLeft)
    const seqBefore = ctrl.recenterSeq;
    const out = ctrl.update(inp.sample, inp.dt);
    if (ctrl.recenterSeq !== seqBefore) this.anchor = { ...this.last };

    // Gyro (°/s). Dve ruky: započíta sa len keď sa obe hýbu rovnakým smerom.
    const nMain = normalizeImuSample(inp.sample.imu, 1);
    const nLeft = dualL ? normalizeImuSample(dualL.sample.imu, 1) : null;
    const gyro = {
      x: nLeft ? fuseSigned(nMain.gyroX_dps, nLeft.gyroX_dps, 1, DUAL_LEFT_GYRO_SIGN.x) : nMain.gyroX_dps,
      y: nLeft ? fuseSigned(nMain.gyroY_dps, nLeft.gyroY_dps, 1, DUAL_LEFT_GYRO_SIGN.y) : nMain.gyroY_dps,
      z: nLeft ? fuseSigned(nMain.gyroZ_dps, nLeft.gyroZ_dps, 1, DUAL_LEFT_GYRO_SIGN.z) : nMain.gyroZ_dps,
    };

    // Poloha -1..1 v súradniciach obrazovky. Zrkadlenie osí ako v menu a v "Skúške kreslenia":
    // ľavá ruka (x, -y), pravá (-x, y). Dve ruky: priemer polôh oboch rúk.
    const mainPos = inp.hand === 'right'
      ? { x: -out.posNorm.x, y: out.posNorm.y }
      : { x: out.posNorm.x, y: -out.posNorm.y };
    const rawBoth = dualL
      ? { x: (mainPos.x + dualL.out.posNorm.x) / 2, y: (mainPos.y - dualL.out.posNorm.y) / 2 }
      : mainPos;
    const rawLin = { x: rawBoth.x * HAND_X_GAIN, y: rawBoth.y * HAND_Y_SCALE };
    // po vynulovaní náklonu surová poloha skočí k nule: zosilnenie podľa rýchlosti sa vtedy začína odznova
    const seqNow = ctrl.recenterSeq;
    const rawPos = HAND_SPEED_GAIN ? this.speed.apply(rawLin, inp.dt, this.speedSeq !== seqNow) : rawLin;
    this.speedSeq = seqNow;
    const anchor = this.anchor;

    // Zmrazenie kurzora pri prechode stisk <-> uvoľnenie: kotva sa dorovná tak, aby poloha ostala stáť; potom kurzor pokračuje plynulo.
    const fr = this.freeze;
    if (grip !== this.prevGrip) {
      if (grip) {
        fr.pos = { ...this.last };
        fr.until = now + GRIP_FREEZE_MS;
        fr.release = false;
      } else {
        const held = this.hooks.heldCursor?.() ?? null;
        let back: Pos;
        if (held) {
          back = { x: held.x, y: held.y };
          this.hooks.onHeldRelease?.();
        } else {
          const hist = this.hist;
          back = hist[hist.length - 1] ?? { ...this.last };
          for (let i = hist.length - 1; i >= 0 && hist[i].t >= now - RELEASE_LOOKBACK_MS; i--) back = hist[i];
        }
        fr.pos = { x: back.x, y: back.y };
        fr.until = now + RELEASE_FREEZE_MS;
        fr.release = true;
        this.last = { ...fr.pos }; // bez dobehu vyhladenia: kurzor ostane presne tam, kde bol
      }
      this.prevGrip = grip;
    }
    let recenterAfterRelease = false;
    if (fr.pos && (now < fr.until || fr.release)) {
      anchor.x = fr.pos.x - rawPos.x; anchor.y = fr.pos.y - rawPos.y;
      // Koniec zmrazenia po uvoľnení: nulový bod sa vynuluje aj v polohe OTVORENEJ ruky (pri stisku sa vynuluje v polohe stisku).
      if (now >= fr.until) { recenterAfterRelease = true; fr.pos = null; fr.release = false; }
    } else fr.pos = null;
    const tgtX = anchor.x + rawPos.x, tgtY = anchor.y + rawPos.y;
    const clamped = { x: Math.max(-1, Math.min(1, tgtX)), y: Math.max(-1, Math.min(1, tgtY)) };
    // pri okraji sa kotva posúva s kurzorom, aby sa nenahromadil náklon a kurzor sa dal vždy odtiahnuť od steny
    anchor.x += clamped.x - tgtX; anchor.y += clamped.y - tgtY;
    const prevPos = this.last;
    const position = {
      x: prevPos.x + CURSOR_SMOOTH * (clamped.x - prevPos.x),
      y: prevPos.y + CURSOR_SMOOTH * (clamped.y - prevPos.y),
    };
    this.last = position;
    this.hist.push({ t: now, x: position.x, y: position.y });
    while (this.hist.length && this.hist[0].t < now - HISTORY_MS) this.hist.shift();

    // Otočená ruka ("kosť"): ako v kreslení sa nula nevynuluje ani pri stisku, ani po uvoľnení (korekcie osí sú navrhnuté okolo
    // neutrálnej polohy zápästia). Kurzor ostáva spojitý cez kotvu.
    const rolledNow = !!out.rolled;
    if (recenterAfterRelease && !rolledNow) {
      this.recenterAll(inp.sample, dualL);
      this.anchor = { ...position };
    }

    // Vynulovanie náklonu pri každom stisku: nula sa berie v pozícii ruky pri stisku, nie v kalibračnej. Poloha ostáva spojitá.
    if (grip) {
      if (!this.gripStart) this.gripStart = now;
      if (!this.gripRecentered && now - this.gripStart >= GRIP_RECENTER_MS && (this.hooks.canGripRecenter?.() ?? true)) {
        this.gripRecentered = true;
        if (!rolledNow) {
          this.recenterAll(inp.sample, dualL);
          this.anchor = { ...this.last };
        }
      }
    } else {
      this.gripStart = 0;
      this.gripRecentered = false;
    }

    // Nový nulový bod: stisk bez pohybu CALIB_HOLD_MS (len ak to hra povolí, napr. Pentomino mimo blokov)
    let calibProg = 0;
    let calibrated = false;
    if (grip && this.hooks.canCalibrate?.()) {
      const cp = this.calibPos;
      if (!this.calibStart || Math.hypot(position.x - cp.x, position.y - cp.y) > CALIB_STILL) {
        this.calibStart = now;
        this.calibPos = { ...position };
      }
      const held = now - this.calibStart;
      calibProg = held > CALIB_SHOW_MS ? Math.min(1, held / CALIB_HOLD_MS) : 0;
      if (held >= CALIB_HOLD_MS) {
        this.recenterAll(inp.sample, dualL);
        // nový nulový bod v tejto polohe ruky a kurzor do stredu; zmrazenie pri uvoľnení ho tam udrží
        this.anchor = { x: 0, y: 0 };
        this.last = { x: 0, y: 0 };
        this.hist = [];
        this.calibStart = 0;
        calibProg = 0;
        calibrated = true;
      }
    } else {
      this.calibStart = 0;
    }

    return { position: { ...this.last }, out, rolled: rolledNow, gyro, calibProg, calibrated };
  }

  /** Režim dvoch rúk: vzorka ľavej ruky len aktualizuje jej kontrolér; výsledok sa odovzdá do step() ako `left`. */
  feedLeft(sample: Sample, dt: number) {
    const c = this.ensureLeft();
    applyAxisCorr(c, 'left'); // uložená "Kalibrácia osí" ľavej ruky, zrkadlenie osí ľavej ruky
    return c.update(sample, dt);
  }
}

/**
 * Relatívny presun bloku stiskom (Tetris, presúvanie blokov): pri začiatku stisku sa kurzor položí na blok, potom cieľová bunka bloku
 * = bunka pod kurzorom. Blok tak ide za rukou rovnako ako v Pentomine a okraj dosahu ruky je okraj poľa.
 */
export class HoldFollow {
  private offset: Pos | null = null;
  constructor(public cols: number, public rows: number) {}

  get active() { return this.offset !== null; }

  /** Začiatok stisku: blok je na bunke (x, y). */
  begin(glove: GloveCursor, x: number, y: number) {
    const cx = Math.max(0, Math.min(this.cols - 1, x));
    const cy = Math.max(0, Math.min(this.rows - 1, y));
    glove.setPosition({ x: cellToPos(cx, this.cols), y: cellToPos(cy, this.rows) });
    this.offset = { x: x - cx, y: y - cy }; // blok, ktorého súradnica leží mimo 0..n-1 (napr. tetromino s prázdnym stĺpcom vľavo)
  }

  /** Cieľová bunka bloku pre aktuálnu polohu kurzora (null mimo stisku). */
  target(pos: Pos): Pos | null {
    if (!this.offset) return null;
    return {
      x: Math.round(posToCell(pos.x, this.cols)) + this.offset.x,
      y: Math.round(posToCell(pos.y, this.rows)) + this.offset.y,
    };
  }

  end() { this.offset = null; }
}
