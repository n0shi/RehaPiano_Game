// cursorInput.ts
// Kurzorové ovládanie rukavicou: pohyb kurzora otvorenou dlaňou, zachytenie bloku pod kurzorom plným stiskom (> 200 ms),
// plynulé otáčanie zápästím (gyro Z) a prevrátenie (diagonálna os gyra X/Y).
// Port z Tangram `rehapianoInput.js` – bez závislosti od Reactu aj DOM, takže sa dá testovať samostatne.

export type Vec2 = { x: number; y: number };

export type GestureConfig = {
  ROTATION_START_DPS?: number;   // minimálna rýchlosť gyro Z, od ktorej sa otočenie vôbec berie do úvahy
  ROTATION_STOP_DPS?: number;    // po potvrdení otočenia sa rýchlosti pod touto hodnotou ignorujú (mŕtva zóna)
  ROTATION_CONFIRM_MS?: number;  // ako dlho musí gesto držať jeden smer, aby sa potvrdilo
  ROTATION_DOMINANCE?: number;   // |gyro Z| musí byť aspoň toľkokrát väčší ako hypot(gyro X, gyro Y)
};

/** Akcie, ktoré vstup vykonáva nad hrou (implementuje ich PieceManipulator). */
export interface CursorActions {
  cursor?(position: Vec2, grip: boolean): void;
  hideCursor?(): void;
  /** Zachytenie bloku pod kurzorom v polohe `position`. false = pod kurzorom nič nie je. */
  begin(position: Vec2): boolean;
  move(position: Vec2): void;
  /** Počas otáčania sa blok nehýbe: nová referenčná poloha, aby po otočení nenastal skok. */
  rebaseMove?(position: Vec2): void;
  isRotationSettling?(): boolean;
  rotate(degrees: number): boolean;
  flip(): boolean;
  settleRotation?(): void;
  finish(): void;
}

const FLIP_STEP_DEG = 70;          // flip až keď sa ruka reálne otočí o toľko stupňov (akumulácia, nie jednorazový prah)
const FLIP_DEADZONE_DPS = 50;      // pod touto rýchlosťou sa flipová os nezapočítava
const FLIP_DOMINANCE = 1.6;        // flipová os musí byť toľkokrát väčšia ako kolmá zložka aj gyro Z
const FLIP_IDLE_RESET_MS = 400;    // pauza, po ktorej sa nedokončený flip zahodí
const FLIP_COOLDOWN_MS = 800;      // pauza medzi dvoma flipmi
const GRAB_HOLD_MS = 200;          // stisk dlhší ako toto = zachytenie bloku (kratší = len ťuk)
const ROTATION_SETTLE_IDLE_MS = 700; // pauza v otáčaní, po ktorej sa blok prichytí na najbližší krok

const ROTATION_DEFAULTS = { ROTATION_START_DPS: 20, ROTATION_STOP_DPS: 8, ROTATION_CONFIRM_MS: 80, ROTATION_DOMINANCE: 1.5 };

const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

export type InputFrame = {
  grip: boolean;                          // všetkých 5 prstov stisnutých
  position: Vec2;                         // poloha kurzora -1..1 (už v súradniciach obrazovky)
  gyro: { x: number; y: number; z: number }; // °/s
};

export class CursorGripInput {
  private rot: Required<GestureConfig>;

  gripping = false;
  moving = false;
  transformed = false;
  waitForRelease = true;

  private lastSampleAt: number | null = null;
  private lastGesture = -Infinity;
  private moveAttempted = false;
  private gripAt = 0;
  private gripPosition: Vec2 = { x: 0, y: 0 };
  private cursorPosition: Vec2 | null = null;
  private cursorOffset: Vec2 = { x: 0, y: 0 };
  /** Posun zobrazeného kurzora oproti vstupnej polohe (zahodený náklon počas otáčania). */
  get offset(): Vec2 { return { ...this.cursorOffset }; }
  /** Zahodí posun (volajúci ho zapracoval do vlastnej polohy, napr. po pustení bloku). */
  clearOffset() { this.cursorOffset = { x: 0, y: 0 }; }

  private rotationDegrees = 0;
  private previousRotationRate = 0;
  private rotationActiveAt: number | null = null;
  private rotationCandidateAt: number | null = null;
  private rotationCandidateDegrees = 0;

  private flipDirection = 0;
  private flipDegrees = 0;
  private flipActiveAt: number | null = null;

  constructor(private actions: CursorActions, config: GestureConfig = {}) {
    this.rot = {
      ROTATION_START_DPS: positive(config.ROTATION_START_DPS, ROTATION_DEFAULTS.ROTATION_START_DPS),
      ROTATION_STOP_DPS: positive(config.ROTATION_STOP_DPS, ROTATION_DEFAULTS.ROTATION_STOP_DPS),
      ROTATION_CONFIRM_MS: positive(config.ROTATION_CONFIRM_MS, ROTATION_DEFAULTS.ROTATION_CONFIRM_MS),
      ROTATION_DOMINANCE: positive(config.ROTATION_DOMINANCE, ROTATION_DEFAULTS.ROTATION_DOMINANCE),
    };
    this.rot.ROTATION_STOP_DPS = Math.min(this.rot.ROTATION_STOP_DPS, this.rot.ROTATION_START_DPS);
    this.cancel();
  }

  /** Úplný reset (nová kalibrácia, nový level): dokončí rozpracovaný presun a čaká na uvoľnenie prstov. */
  reset() {
    this.cancel();
    this.lastSampleAt = null;
    this.lastGesture = -Infinity;
  }

  /** Preruší gesto (strata dát, myš, modal). Rozpracovaný presun sa dokončí a pred ďalším stiskom treba prsty uvoľniť. */
  cancel() {
    if (this.moving || this.transformed) this.actions.finish();
    this.actions.hideCursor?.();
    this.gripping = false;
    this.moving = false;
    this.moveAttempted = false;
    this.transformed = false;
    this.rotationDegrees = 0;
    this.previousRotationRate = 0;
    this.rotationActiveAt = null;
    this.rotationCandidateAt = null;
    this.rotationCandidateDegrees = 0;
    this.cursorPosition = null;
    this.cursorOffset = { x: 0, y: 0 };
    this.flipDegrees = 0;
    this.flipDirection = 0;
    this.flipActiveAt = null;
    this.waitForRelease = true;
  }

  private updateRotation(gyro: InputFrame['gyro'], now: number, dt: number, grip: boolean) {
    const s = this.rot;
    const rate = Math.abs(gyro.z) >= s.ROTATION_STOP_DPS ? gyro.z : 0;
    if (this.rotationActiveAt !== null) {
      // lichobežníková integrácia uhla z rýchlosti
      this.rotationDegrees += (this.previousRotationRate + rate) * 0.5 * dt;
      this.previousRotationRate = rate;
      if (rate !== 0) this.rotationActiveAt = now;
      return;
    }
    // Bežný náklon X/Y a náhodný šum Z ostávajú pohybom bloku, nie otáčaním.
    // Ak stisk nezachytil žiadny blok (začal mimo bloku), otáčanie sa vôbec nezačne.
    const missed = this.moveAttempted && !this.moving;
    const deliberate = grip && !missed && Math.abs(rate) >= s.ROTATION_START_DPS &&
      Math.abs(rate) >= s.ROTATION_DOMINANCE * Math.hypot(gyro.x, gyro.y);
    if (!deliberate) {
      this.rotationCandidateAt = null;
      this.rotationCandidateDegrees = 0;
      this.previousRotationRate = 0;
      return;
    }
    if (this.rotationCandidateAt === null || Math.sign(rate) !== Math.sign(this.previousRotationRate)) {
      this.rotationCandidateAt = now;
      this.rotationCandidateDegrees = 0;
    } else {
      this.rotationCandidateDegrees += (this.previousRotationRate + rate) * 0.5 * dt;
    }
    this.previousRotationRate = rate;
    if (now - this.rotationCandidateAt >= s.ROTATION_CONFIRM_MS) {
      this.rotationDegrees = this.rotationCandidateDegrees;
      this.rotationActiveAt = now;
      this.rotationCandidateAt = null;
    }
  }

  /**
   * Spracuje jednu vzorku. `ready` = hra je pripravená prijímať vstup (kalibrované, bez modalu, hráč nepoužíva myš);
   * ak nie, rozpracované gesto sa preruší.
   * Vracia true, ak vzorka odštartovala flip (volajúci môže „spotrebovať“ gyro X na kontroléri).
   */
  update(frame: InputFrame, now: number, ready: boolean): boolean {
    const dt = this.lastSampleAt === null ? 0 : Math.max(0, (now - this.lastSampleAt) / 1000);
    this.lastSampleAt = now;
    const { grip, gyro } = frame;
    if (!ready) { this.cancel(); return false; }
    // Po (re)kalibrácii a po strate dát treba najprv uvoľniť prsty, aby stisk z kalibrácie nechytil blok.
    if (this.waitForRelease) {
      if (grip) return false;
      this.waitForRelease = false;
    }
    const raw = frame.position;
    const startingGrip = grip && !this.gripping;
    if (startingGrip) {
      this.gripping = true;
      this.gripAt = now;
      this.transformed = false;
      this.flipDirection = 0;
      this.flipDegrees = 0;
      this.flipActiveAt = null;
      this.moveAttempted = false;
      this.rotationDegrees = 0;
      this.previousRotationRate = 0;
      this.rotationActiveAt = null;
      this.rotationCandidateAt = null;
      this.rotationCandidateDegrees = 0;
    }
    if (this.gripping) this.updateRotation(gyro, now, startingGrip ? 0 : dt, grip);

    // Od prvej vzorky nad prahom otáčania (potvrdzovanie, pauza zápästia, dorovnanie) kurzor aj blok stoja.
    const rotating = this.rotationCandidateAt !== null || this.rotationActiveAt !== null ||
      !!this.actions.isRotationSettling?.();
    if (rotating && this.cursorPosition) {
      // Zmeny náklonu počas otáčania sa zahodia: po otočení kurzor pokračuje od miesta, kde stál.
      this.cursorOffset = { x: this.cursorPosition.x - raw.x, y: this.cursorPosition.y - raw.y };
    }
    const position: Vec2 = rotating && this.cursorPosition ? { ...this.cursorPosition } : {
      x: Math.max(-1, Math.min(1, raw.x + this.cursorOffset.x)),
      y: Math.max(-1, Math.min(1, raw.y + this.cursorOffset.y)),
    };
    this.cursorPosition = position;
    // Zachytenie sa vyhodnocuje v polohe kurzora na ZAČIATKU stisku (stisk sám pohne rukou).
    if (startingGrip) this.gripPosition = position;
    this.actions.cursor?.(position, grip);

    if (!grip && this.gripping) {
      if (this.moving || this.transformed) {
        if (this.transformed || Math.abs(this.rotationDegrees) > 0.01) this.actions.rotate(this.rotationDegrees);
        this.actions.finish();
      }
      this.gripping = false;
      this.moving = false;
      this.transformed = false;
      this.rotationActiveAt = this.rotationCandidateAt = null;
      this.rotationDegrees = this.previousRotationRate = 0;
      return false;
    }
    if (!grip) return false;

    if (now - this.gripAt > GRAB_HOLD_MS) {
      if (!this.moveAttempted) {
        this.moveAttempted = true;
        this.moving = this.actions.begin(this.gripPosition) !== false;
      }
      if (this.moving) {
        if (rotating) this.actions.rebaseMove?.(position);
        else this.actions.move(position);
      }
      // Otáčanie a flip platia len pre blok, ktorý stisk naozaj zachytil (nie pre predtým vybraný blok mimo kurzora).
      if (this.moving && Math.abs(this.rotationDegrees) > 0.01 && this.actions.rotate(this.rotationDegrees) !== false) {
        this.transformed = true;
      } else if (this.transformed) {
        // Návrat zápästia na pôvodný uhol tiež aktualizuje náhľad.
        this.actions.rotate(this.rotationDegrees);
      }
      // Po pauze v otáčaní sa blok prichytí; zachytenie ostáva, pohyb sa odomkne po dobehnutí animácie.
      if (this.rotationActiveAt !== null && now - this.rotationActiveAt > ROTATION_SETTLE_IDLE_MS) {
        if (Math.abs(this.rotationDegrees) > 0.01) this.actions.settleRotation?.();
        this.rotationDegrees = 0;
        this.previousRotationRate = 0;
        this.rotationActiveAt = null;
      }
    }

    // Flip: diagonálna os senzora (kyvnutie zápästia K sebe / OD seba sa rozloží na gyro X a Y s opačným znamienkom).
    const flipRate = (gyro.y - gyro.x) / Math.SQRT2;
    const perpendicularRate = (gyro.y + gyro.x) / Math.SQRT2;
    const flipDominant = Math.abs(flipRate) > FLIP_DOMINANCE * Math.abs(perpendicularRate) &&
      Math.abs(flipRate) > FLIP_DOMINANCE * Math.abs(gyro.z);
    if (Math.abs(this.rotationDegrees) >= 20) {
      this.flipDegrees = 0;
      this.flipActiveAt = null;
    } else if (flipDominant && Math.abs(flipRate) > FLIP_DEADZONE_DPS) {
      // opačný smer (návrat ruky) akumulátor skôr zruší, než by sa nabil
      if (this.flipDegrees !== 0 && Math.sign(flipRate) !== Math.sign(this.flipDegrees)) this.flipDegrees = 0;
      this.flipDegrees += flipRate * (now === this.gripAt ? 0 : Math.min(dt, 0.1));
      this.flipActiveAt = now;
    } else if (this.flipActiveAt !== null && now - this.flipActiveAt > FLIP_IDLE_RESET_MS) {
      this.flipDegrees = 0;
    }
    if (this.moving && now - this.gripAt > GRAB_HOLD_MS && now - this.lastGesture >= FLIP_COOLDOWN_MS &&
        Math.abs(this.flipDegrees) >= FLIP_STEP_DEG) {
      const direction = Math.sign(this.flipDegrees);
      this.flipDegrees = 0;
      // Návrat zápästia po flipe blok nesmie prevrátiť späť.
      if ((!this.flipDirection || this.flipDirection === direction) && this.actions.flip()) {
        this.flipDirection = direction;
        this.lastGesture = now;
        this.transformed = true;
        return true;
      }
    }
    return false;
  }
}
