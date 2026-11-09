// pieceManip.ts
// Plynulé ovládanie pentomín: kurzor, zachytenie bloku pod kurzorom, ťahanie v desatinných bunkách, plynulé otáčanie
// (zápästie / klávesy R, E), prevrátenie s animáciou a prichytenie na mriežku po pustení.
// Port z Tangram `rehapiano.js` (akcie nad hrou) prerobený z polygónov na bunkové pentominá: otáčanie sa potvrdzuje
// po 90°, poloha sa po pustení zaokrúhli na bunku. Bez Reactu aj DOM – hra dostáva len snímky stavu na vykreslenie.
import { rotatePentomino, flipPentomino } from '../data/pentominoShapes';
import { findNearestValidPosition, fitsOnGrid, type PlacedPiece } from './pentominoUtils';
import { MOVE_START_CELLS, MOVE_STEP_MS, pieceStep } from './pieceMovement';
import type { CursorActions, Vec2 } from './cursorInput';

export const ROTATE_SPEED_DPS = 180;     // rýchlosť otáčania klávesom (°/s)
export const ROTATE_SETTLE_FACTOR = 2;   // o koľko rýchlejšie sa dobieha cieľový uhol po prichytení
export const ROTATE_TAP_MS = 150;        // krátke ťuknutie klávesu = celý krok 90°
export const ROTATE_MAX_KEY_DEG = 270;   // najviac 3 kroky počas jedného podržania klávesu
export const ROTATE_SMOOTH_MS = 45;      // časová konštanta vyhladenia zobrazeného uhla pri otáčaní zápästím
export const FLIP_ANIMATION_MS = 450;    // 3D prevrat (zrkadlenie okolo zvislej osi)
export const SNAP_SMOOTH_MS = 50;
const GLUE_SLACK_CELLS = 0.5;            // o koľko buniek sa kurzor počas držania môže vzdialiť od miesta zachytenia na bloku        // dobeh zobrazenej polohy na bunku po pustení
const AXIS_LOCK_MIN = 2;        // posun (bunky) v hlavnej osi, od ktorého sa zámok osi vôbec zvažuje
const AXIS_LOCK_RATIO = 2.2;     // hlavná os musí byť toľkokrát väčšia ako druhá, aby sa zamkla
const AXIS_UNLOCK_RATIO = 0.7;   // zámok sa uvoľní, keď druhá os dosiahne tento podiel hlavnej
// (MOVE_GAIN_RIGHT = 1,8 odstránené: blok išiel doprava 1,8× rýchlejšie než kurzor a doľava 1×, takže doľava pôsobil "po bunkách"
// a po pustení kurzor odskočil z bloku na skutočnú polohu ruky. Rozdiel dosahu vpravo/vľavo patrí do zosilnenia osí kurzora
// (applyAxisCorr / Kalibrácia osí), aby kurzor aj blok išli rovnako.)
export const DROP_MAX_SHIFT = 3;
export const GRAB_TOLERANCE = 0.6;      // kurzor do tejto vzdialenosti (bunky) od bloku ho ešte zachytí         // najviac o toľko buniek sa blok po pustení posunie do voľného miesta
const STEP_DEG = 90;

export type LiveView = {
  uid: string;
  grid: boolean[][];       // potvrdená orientácia bloku
  cx: number;              // zobrazený stred v bunkách (desatinný)
  cy: number;
  angle: number;           // zostatkový vizuálny uhol (°, v smere hodín) nad potvrdenou orientáciou
  flipScale: number;       // 1 = normálne; počas prevratu −1 → 1
  grabbed: boolean;        // blok drží ruka (kurzor)
  ghost: { grid: boolean[][]; row: number; col: number } | null; // kam blok po pustení dosadne
};

export type ManipSnapshot = {
  live: LiveView | null;
  cursor: { col: number; row: number; grip: boolean } | null; // poloha kurzora v bunkách
  hoverUid: string | null;
};

export type CommitInfo = {
  uid: string;
  grid: boolean[][];
  row: number;
  col: number;
  changed: boolean;       // zmenila sa poloha, orientácia alebo prevrátenie oproti stavu pred zachytením
};

export interface ManipHost {
  rows(): number;
  cols(): number;
  pieces(): PlacedPiece[];                 // poradie = poradie vykresľovania (posledný je navrchu)
  selected(): string | null;
  select(uid: string | null): void;
  commit(info: CommitInfo): void;
  render(snapshot: ManipSnapshot): void;
  /** Ide o stav hry, v ktorom sa bloky smú hýbať (level beží, žiadny modal)? */
  playing?(): boolean;
  /** true = pôvodné ťahanie po bunkách (cieľ z posunu ruky, najviac 1 krok za MOVE_STEP_MS); false = plynulé desatinné ťahanie. */
  stepMove?: boolean;
}

type Session = {
  uid: string;
  grid: boolean[][];
  cx: number; cy: number;                  // logický stred v bunkách
  shownX: number; shownY: number;          // zobrazený stred (po pustení dobieha cx, cy)
  orig: { grid: boolean[][]; row: number; col: number };
  grabbed: boolean;
  snapping: boolean;                       // už potvrdené; dobieha sa len vizuálna poloha/uhol
  dirty: boolean;                          // orientácia sa zmenila (rotácia / flip) – aj keď poloha ostane
  moveStarted: boolean;                    // režim krokov: ruka sa už posunula aspoň o MOVE_START_CELLS
  lastStepAt: number;
  occ: boolean[][] | null;                 // režim krokov: zaplnenie bez tohto bloku (iné bloky sa počas ťahania nehýbu)
};

const sameGrid = (a: boolean[][], b: boolean[][]) =>
  a.length === b.length && a.every((row, r) => row.length === b[r].length && row.every((v, c) => v === b[r][c]));

export function rotateSteps(grid: boolean[][], steps: number): boolean[][] {
  const quarter = ((steps % 4) + 4) % 4;
  let g = grid;
  for (let i = 0; i < quarter; i++) g = rotatePentomino(g);
  return g;
}

/** Zaplnenie mriežky všetkými blokmi okrem `skipUid`. */
export function occupancyWithout(rows: number, cols: number, pieces: PlacedPiece[], skipUid: string | undefined): boolean[][] {
  const occ: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  for (const p of pieces) {
    if (p.uid === skipUid) continue;
    for (let r = 0; r < p.grid.length; r++) {
      for (let c = 0; c < p.grid[r].length; c++) {
        if (p.grid[r][c] && occ[p.row + r] && p.col + c < cols) occ[p.row + r][p.col + c] = true;
      }
    }
  }
  return occ;
}

/** Ktorý blok je v bunke (col,row)? Hľadá od najvrchnejšieho (posledného vykresleného). */
export function hitTest(pieces: PlacedPiece[], col: number, row: number): PlacedPiece | null {
  const cc = Math.floor(col), rr = Math.floor(row);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    const r = rr - p.row, c = cc - p.col;
    if (r >= 0 && c >= 0 && r < p.grid.length && c < (p.grid[r]?.length ?? 0) && p.grid[r][c]) return p;
  }
  return null;
}

/** Najbližší blok k bodu (col,row) – vzdialenosť od bodu k najbližšej vyplnenej bunke, najviac `maxDist` buniek. */
export function nearestPiece(pieces: PlacedPiece[], col: number, row: number, maxDist: number): PlacedPiece | null {
  let best: PlacedPiece | null = null;
  let bestD = maxDist;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    for (let r = 0; r < p.grid.length; r++) {
      for (let c = 0; c < (p.grid[r]?.length ?? 0); c++) {
        if (!p.grid[r][c]) continue;
        const x0 = p.col + c, y0 = p.row + r;
        const dx = Math.max(x0 - col, 0, col - (x0 + 1)), dy = Math.max(y0 - row, 0, row - (y0 + 1));
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
  }
  return best;
}

/** Rozsah vyplnených buniek bloku otočeného o `deg` okolo stredu (v bunkách od stredu). */
function rotatedExtent(grid: boolean[][], deg: number) {
  const h = grid.length, w = grid[0]?.length ?? 0;
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!grid[r][c]) continue;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = c + dx - w / 2, y = r + dy - h / 2;
        const rx = x * cos - y * sin, ry = x * sin + y * cos;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

type Scheduler = { request(cb: (time: number) => void): number; cancel(id: number): void; now(): number };

const browserScheduler: Scheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

export class PieceManipulator implements CursorActions {
  private session: Session | null = null;
  private cursorState: ManipSnapshot['cursor'] = null;
  private hoverUid: string | null = null;

  // Ťahanie
  private startPosition: Vec2 | null = null;
  private startCx = 0;
  private startCy = 0;
  private axisLock: 'x' | 'y' | null = null; // presun je zamknutý do jednej osi (tremor v druhej osi sa ignoruje)
  private grabDX = 0; // kde na bloku bol kurzor pri zachytení (v bunkách od stredu bloku)
  private grabDY = 0;

  // Otáčanie (rovnaký model ako Tangram: cieľový uhol + zobrazený uhol, ktorý sa k nemu plynulo blíži)
  private rotationAngle = 0;
  private displayedAngle = 0;
  private rotationSettling = false;
  private rotationKey: 'r' | 'e' | null = null;
  private rotationKeyStartedAt = 0;
  private flipStartedAt: number | null = null;

  private frame: number | null = null;
  private lastFrameAt: number | null = null;
  private ghostKey = '';
  private ghost: LiveView['ghost'] = null;

  constructor(private host: ManipHost, private scheduler: Scheduler = browserScheduler) {}

  // ---------- pomocné ----------

  private toCell(p: Vec2) {
    const cols = this.host.cols(), rows = this.host.rows();
    return {
      col: Math.max(0, Math.min(cols, cols / 2 + p.x * (cols / 2))),
      row: Math.max(0, Math.min(rows, rows / 2 + p.y * (rows / 2))),
    };
  }

  private ok() { return this.host.playing ? this.host.playing() : true; }

  /** Session nad vybraným blokom (ak ešte nie je). Dobiehajúcu (už potvrdenú) session zahodí a začne novú z uloženého stavu. */
  private ensureSession(): Session | null {
    if (this.session && !this.session.snapping) return this.session;
    this.session = null;
    const uid = this.host.selected();
    const piece = uid ? this.host.pieces().find((p) => p.uid === uid) : undefined;
    if (!piece || !piece.uid) return null;
    this.resetRotation();
    const h = piece.grid.length, w = piece.grid[0]?.length ?? 0;
    const cx = piece.col + w / 2, cy = piece.row + h / 2;
    this.session = {
      uid: piece.uid, grid: piece.grid, cx, cy, shownX: cx, shownY: cy,
      orig: { grid: piece.grid, row: piece.row, col: piece.col },
      grabbed: false, snapping: false, dirty: false, moveStarted: false, lastStepAt: 0, occ: null,
    };
    return this.session;
  }

  private resetRotation() {
    this.rotationAngle = 0;
    this.displayedAngle = 0;
    this.rotationSettling = false;
    this.rotationKey = null;
    this.flipStartedAt = null;
    this.ghostKey = '';
    this.ghost = null;
  }

  private clamp() {
    const s = this.session;
    if (!s) return;
    const e = rotatedExtent(s.grid, this.displayedAngle);
    const cols = this.host.cols(), rows = this.host.rows();
    s.cx += Math.max(0, -(s.cx + e.minX)) + Math.min(0, cols - (s.cx + e.maxX));
    s.cy += Math.max(0, -(s.cy + e.minY)) + Math.min(0, rows - (s.cy + e.maxY));
  }

  private invalidate() {
    if (this.frame === null) this.frame = this.scheduler.request((t) => this.tick(t));
  }

  /** Zobrazená poloha dobieha logickú (po pustení a v režime krokov – posun medzi bunkami je plynulý). */
  private smoothed(s: Session) { return s.snapping || (s.grabbed && !!this.host.stepMove); }

  private animating() {
    const s = this.session;
    if (!s) return false;
    return this.rotationKey !== null || this.displayedAngle !== this.rotationAngle || this.flipStartedAt !== null ||
      (this.smoothed(s) && (Math.abs(s.shownX - s.cx) > 0.004 || Math.abs(s.shownY - s.cy) > 0.004));
  }

  private computeGhost(s: Session): LiveView['ghost'] {
    const steps = Math.round(this.rotationAngle / STEP_DEG);
    const g = rotateSteps(s.grid, steps);
    const h = g.length, w = g[0]?.length ?? 0;
    const r0 = Math.round(s.cy - h / 2), c0 = Math.round(s.cx - w / 2);
    const key = `${s.uid}|${steps}|${r0}|${c0}|${s.dirty}|${s.grid === g}`;
    if (key === this.ghostKey) return this.ghost;
    this.ghostKey = key;
    const rows = this.host.rows(), cols = this.host.cols();
    const occ = occupancyWithout(rows, cols, this.host.pieces(), s.uid);
    const pos = findNearestValidPosition(occ, g, r0, c0, DROP_MAX_SHIFT);
    this.ghost = pos ? { grid: g, row: pos.row, col: pos.col } : null;
    return this.ghost;
  }

  private snapshot(): ManipSnapshot {
    const s = this.session;
    let live: LiveView | null = null;
    if (s) {
      const flipScale = this.flipStartedAt === null ? 1 :
        -Math.cos(Math.PI * Math.min(1, Math.max(0, (this.scheduler.now() - this.flipStartedAt) / FLIP_ANIMATION_MS)));
      live = {
        uid: s.uid, grid: s.grid, cx: s.shownX, cy: s.shownY, angle: this.displayedAngle, flipScale,
        grabbed: s.grabbed, ghost: s.grabbed ? this.computeGhost(s) : null,
      };
    }
    // Počas držania je kurzor pri bloku na mieste zachytenia, ale v rámci pol bunky ide plynulo za rukou (inak skákal po bunkách)
    const g = s?.grabbed ? this.gluedCursor(s) : null;
    const cursor = g && this.cursorState ? { col: g.col, row: g.row, grip: this.cursorState.grip } : this.cursorState;
    return { live, cursor, hoverUid: this.hoverUid };
  }

  // ---------- animačná slučka ----------

  tick(time: number) {
    this.frame = null;
    if (!this.ok()) { this.reset(); return; }
    const s = this.session;
    const elapsed = this.lastFrameAt === null ? 16 : Math.max(0, time - this.lastFrameAt);
    this.lastFrameAt = time;
    if (s) {
      const dt = Math.min(0.05, elapsed / 1000);
      if (this.rotationKey !== null) {
        const dir = this.rotationKey === 'r' ? 1 : -1;
        this.rotationAngle = Math.max(-ROTATE_MAX_KEY_DEG, Math.min(ROTATE_MAX_KEY_DEG, this.rotationAngle + dir * ROTATE_SPEED_DPS * dt));
        this.displayedAngle = this.rotationAngle;
      } else if (this.rotationSettling) {
        const diff = this.rotationAngle - this.displayedAngle;
        const step = ROTATE_SPEED_DPS * ROTATE_SETTLE_FACTOR * dt;
        this.displayedAngle += Math.sign(diff) * Math.min(Math.abs(diff), step);
      } else {
        this.displayedAngle += (this.rotationAngle - this.displayedAngle) * (1 - Math.exp(-elapsed / ROTATE_SMOOTH_MS));
      }
      if (Math.abs(this.rotationAngle - this.displayedAngle) < 0.01) this.displayedAngle = this.rotationAngle;
      if (this.flipStartedAt !== null && time - this.flipStartedAt >= FLIP_ANIMATION_MS) this.flipStartedAt = null;
      // Pri otáčaní pri okraji sa blok drží v poli.
      if (s.grabbed && !this.host.stepMove) this.clamp();
      if (this.smoothed(s)) {
        const k = 1 - Math.exp(-elapsed / SNAP_SMOOTH_MS);
        s.shownX += (s.cx - s.shownX) * k;
        s.shownY += (s.cy - s.shownY) * k;
        if (Math.abs(s.cx - s.shownX) <= 0.004) s.shownX = s.cx;
        if (Math.abs(s.cy - s.shownY) <= 0.004) s.shownY = s.cy;
      } else {
        s.shownX = s.cx;
        s.shownY = s.cy;
      }
      if (this.rotationAngle === this.displayedAngle && this.rotationSettling) this.rotationSettling = false;
    }
    const busy = this.animating();
    if (s && s.snapping && !busy) {
      // dobehlo: React už vykresľuje potvrdený stav na rovnakom mieste
      this.session = null;
      this.resetRotation();
    }
    this.host.render(this.snapshot());
    if (busy) this.invalidate();
    else this.lastFrameAt = null;
  }

  // ---------- CursorActions ----------

  cursor(position: Vec2, grip: boolean) {
    const { col, row } = this.toCell(position);
    this.cursorState = { col, row, grip };
    // Prejdenie kurzorom bez stisku len zvýrazní blok, výber nemení.
    // Zvýrazní blok, ktorý by stisk zachytil (rovnaké pravidlo ako begin: pod kurzorom alebo tesne vedľa)
    this.hoverUid = !grip && (!this.session || this.session.snapping)
      ? (hitTest(this.host.pieces(), col, row) ?? nearestPiece(this.host.pieces(), col, row, GRAB_TOLERANCE))?.uid ?? null : null;
    this.invalidate();
  }

  hideCursor() {
    if (!this.cursorState && !this.hoverUid) return;
    this.cursorState = null;
    this.hoverUid = null;
    this.invalidate();
  }

  begin(position: Vec2): boolean {
    if (!this.ok() || this.rotationKey !== null) return false;
    if (this.session && !this.session.snapping) this.finish();
    this.session = null;
    this.resetRotation();
    // Stisk zachytí blok POD KURZOROM (poloha na začiatku stisku); ak je kurzor tesne vedľa bloku, vezme sa najbližší
    // do GRAB_TOLERANCE buniek. Mimo blokov stisk nič nechytí.
    const { col, row } = this.toCell(position);
    const hit = hitTest(this.host.pieces(), col, row) ?? nearestPiece(this.host.pieces(), col, row, GRAB_TOLERANCE);
    if (!hit || !hit.uid) { this.invalidate(); return false; }
    this.host.select(hit.uid);
    const h = hit.grid.length, w = hit.grid[0]?.length ?? 0;
    const cx = hit.col + w / 2, cy = hit.row + h / 2;
    this.session = {
      uid: hit.uid, grid: hit.grid, cx, cy, shownX: cx, shownY: cy,
      orig: { grid: hit.grid, row: hit.row, col: hit.col },
      grabbed: true, snapping: false, dirty: false, moveStarted: false, lastStepAt: 0, occ: null,
    };
    this.startPosition = position;
    this.startCx = cx;
    this.startCy = cy;
    this.axisLock = null;
    this.grabDX = col - cx;
    this.grabDY = row - cy;
    this.invalidate();
    return true;
  }

  move(position: Vec2) {
    const s = this.session;
    if (!s || !s.grabbed || !this.startPosition) return;
    if (this.host.stepMove) { this.stepTo(s, position); return; }
    s.cx = this.startCx + (position.x - this.startPosition.x) * (this.host.cols() / 2);
    s.cy = this.startCy + (position.y - this.startPosition.y) * (this.host.rows() / 2);
    this.clamp();
    this.invalidate();
  }

  /**
   * Pôvodné ťahanie: cieľ = štart + posun ruky v bunkách; blok sa k nemu približuje najviac o jeden krok (2–3 pri veľkej
   * vzdialenosti) za MOVE_STEP_MS a berie prvý krok, ktorý sa zmestí (hranice, kolízie), takže kĺže popri stene aj bloku.
   */
  private stepTo(s: Session, position: Vec2) {
    const start = this.startPosition;
    if (!start) return;
    // rovnaká mierka ako toCell (cols/2 na jednotku polohy): blok ide s kurzorom 1:1 v oboch smeroch
    let gx = (position.x - start.x) * (this.host.cols() / 2);
    let gy = (position.y - start.y) * (this.host.rows() / 2);
    if (!s.moveStarted) {
      // Presun sa začne až keď sa ruka naozaj posunie; od tej chvíle sa počíta od aktuálnej polohy (bez skoku).
      // (predtým sa porovnávala zaokrúhlená hodnota, takže pri 2 bunkách musela ruka prejsť 1,5 bunky – blok "lepil")
      if (Math.max(Math.abs(gx), Math.abs(gy)) < MOVE_START_CELLS) return;
      // Bez prenesenia štartu na aktuálnu polohu (pri prahu 2 bunky bránilo skoku): pri prahu 1 bunka sa blok hneď posunie
      // o tú bunku, o ktorú sa ruka posunula; predtým sa prvá bunka "stratila" a blok sa pohol až po ~1,75 bunky.
      s.moveStarted = true;
      this.axisLock = null;
    }
    // Zámok osi: ak je pohyb jasne vodorovný (alebo zvislý), druhá os sa ignoruje, takže tremor ani šikmý náklon ruky blok nezosúvajú.
    // Zámok sa uvoľní, až keď druhá os dosiahne väčšiu časť hlavnej (zámerná zmena smeru).
    const ax = Math.abs(gx), ay = Math.abs(gy);
    if (this.axisLock === 'x') {
      if (ay > AXIS_UNLOCK_RATIO * ax && ay >= 1.5) this.axisLock = null; else gy = 0;
    } else if (this.axisLock === 'y') {
      if (ax > AXIS_UNLOCK_RATIO * ay && ax >= 1.5) this.axisLock = null; else gx = 0;
    }
    if (!this.axisLock) {
      if (ax >= AXIS_LOCK_MIN && ax > AXIS_LOCK_RATIO * ay) {
        this.axisLock = 'x';
        this.startPosition = { x: start.x, y: position.y }; // druhá os sa nuluje v súčasnej polohe: blok sa nevráti
        this.startCy = s.cy;
        gy = 0;
      } else if (ay >= AXIS_LOCK_MIN && ay > AXIS_LOCK_RATIO * ax) {
        this.axisLock = 'y';
        this.startPosition = { x: position.x, y: start.y };
        this.startCx = s.cx;
        gx = 0;
      }
    }
    const dX = Math.round(gx), dY = Math.round(gy);
    const now = this.scheduler.now();
    if (now - s.lastStepAt < MOVE_STEP_MS) return;
    const h = s.grid.length, w = s.grid[0]?.length ?? 0;
    const candidates = pieceStep(this.startCx + dX - s.cx, this.startCy + dY - s.cy, true);
    if (!candidates.length) return;
    s.occ ??= occupancyWithout(this.host.rows(), this.host.cols(), this.host.pieces(), s.uid);
    const row = Math.round(s.cy - h / 2), col = Math.round(s.cx - w / 2);
    const chosen = candidates.find((cd) => fitsOnGrid(s.occ!, s.grid, row + cd.dr, col + cd.dc));
    if (!chosen) return;
    s.cx += chosen.dc;
    s.cy += chosen.dr;
    s.lastStepAt = now;
    this.invalidate();
  }

  /**
   * Kurzor počas držania (v bunkách): miesto zachytenia na bloku + odchýlka ruky od neho, obmedzená na pol bunky.
   * Kurzor sa tak hýbe plynulo (neskáče po bunkách s blokom), ale nikdy sa od bloku nevzdiali – po pustení neodletí.
   */
  private gluedCursor(s: Session, shown = true) {
    const bx = (shown ? s.shownX : s.cx) + this.grabDX, by = (shown ? s.shownY : s.cy) + this.grabDY;
    const h = this.cursorState;
    const lim = (v: number) => Math.max(-GLUE_SLACK_CELLS, Math.min(GLUE_SLACK_CELLS, v));
    const cols = this.host.cols(), rows = this.host.rows();
    return {
      col: Math.max(0, Math.min(cols, bx + (h ? lim(h.col - bx) : 0))),
      row: Math.max(0, Math.min(rows, by + (h ? lim(h.row - by) : 0))),
    };
  }

  /** Poloha kurzora pri drženom bloku (rozsah -1..1), null ak sa nič nedrží. Po pustení na nej kurzor ostane. */
  heldCursor(): Vec2 | null {
    const s = this.session;
    if (!s || !s.grabbed || s.snapping) return null;
    const cols = this.host.cols(), rows = this.host.rows();
    const g = this.gluedCursor(s);
    return { x: (g.col - cols / 2) / (cols / 2), y: (g.row - rows / 2) / (rows / 2) };
  }

  rebaseMove(position: Vec2) {
    const s = this.session;
    if (!s || !s.grabbed) return;
    this.axisLock = null;
    this.startPosition = position;
    this.startCx = s.cx;
    this.startCy = s.cy;
  }

  isRotationSettling() {
    return this.rotationSettling || this.displayedAngle !== this.rotationAngle;
  }

  rotate(angle: number): boolean {
    if (!this.ok()) return false;
    // Opakované nulové vzorky nesmú prerušiť dobiehajúce prichytenie.
    if (angle === 0 && this.rotationSettling) return true;
    if (!this.ensureSession()) return false;
    this.rotationSettling = false;
    this.rotationAngle = angle;
    this.invalidate();
    return true;
  }

  settleRotation() {
    const s = this.session;
    if (!s || s.snapping) return;
    const steps = Math.round(this.rotationAngle / STEP_DEG);
    if (steps !== 0) {
      s.grid = rotateSteps(s.grid, steps);
      s.dirty = true;
    }
    // Zachová sa rovnaká viditeľná poloha: potvrdená geometria + zostatok uhla.
    this.displayedAngle -= steps * STEP_DEG;
    this.rotationAngle = 0;
    this.rotationSettling = true;
    this.ghostKey = '';
    if (this.host.stepMove) {
      // po otočení okolo stredu môže byť ľavý horný roh na polovici bunky: vráť ho na celé bunky
      const h = s.grid.length, w = s.grid[0]?.length ?? 0;
      s.cx = Math.round(s.cx - w / 2) + w / 2;
      s.cy = Math.round(s.cy - h / 2) + h / 2;
    } else if (s.grabbed) this.clamp();
    this.invalidate();
  }

  flip(): boolean {
    if (!this.ok()) return false;
    const s = this.ensureSession();
    if (!s) return false;
    const flipped = flipPentomino(s.grid);
    if (sameGrid(flipped, s.grid)) return false; // I a X sú osovo súmerné – prevrat by nebol vidieť
    s.grid = flipped;
    s.dirty = true;
    this.ghostKey = '';
    this.flipStartedAt = this.scheduler.now();
    this.invalidate();
    return true;
  }

  finish() {
    const s = this.session;
    this.startPosition = null;
    if (!s || s.snapping) return;
    this.settleRotation();
    const rows = this.host.rows(), cols = this.host.cols();
    const h = s.grid.length, w = s.grid[0]?.length ?? 0;
    const occ = occupancyWithout(rows, cols, this.host.pieces(), s.uid);
    const wantRow = Math.round(s.cy - h / 2), wantCol = Math.round(s.cx - w / 2);
    const pos = findNearestValidPosition(occ, s.grid, wantRow, wantCol, DROP_MAX_SHIFT);
    let grid = s.grid, row: number, col: number;
    if (pos) {
      row = pos.row; col = pos.col;
    } else {
      // Nikde v okolí sa nezmestí: blok sa vráti do pôvodného stavu spred zachytenia.
      grid = s.orig.grid; row = s.orig.row; col = s.orig.col;
      this.rotationAngle = 0;
      this.displayedAngle = 0;
      this.flipStartedAt = null;
    }
    const gh = grid.length, gw = grid[0]?.length ?? 0;
    // Zobrazený stred ostáva tam, kde blok práve je (aj pri návrate na pôvodnú orientáciu), dobieha ho animácia.
    s.grid = grid;
    s.cx = col + gw / 2;
    s.cy = row + gh / 2;
    s.grabbed = false;
    s.snapping = true;
    const changed = row !== s.orig.row || col !== s.orig.col || !sameGrid(grid, s.orig.grid);
    this.host.commit({ uid: s.uid, grid, row, col, changed });
    this.invalidate();
  }

  // ---------- klávesy R / E ----------

  keyDown(key: 'r' | 'e'): boolean {
    if (!this.ok() || this.rotationKey !== null || this.rotationSettling) return false;
    if (this.session && !this.session.snapping) return false; // blok práve drží ruka
    if (!this.ensureSession()) return false;
    this.rotationKey = key;
    this.rotationKeyStartedAt = this.lastFrameAt = this.scheduler.now();
    this.invalidate();
    return true;
  }

  keyUp(key?: string) {
    if (this.rotationKey === null || (key !== undefined && key !== this.rotationKey)) return;
    // Rýchle ťuknutie = jeden krok, podržanie sa prichytí na najbližší násobok 90°.
    if (this.scheduler.now() - this.rotationKeyStartedAt < ROTATE_TAP_MS && Math.round(this.rotationAngle / STEP_DEG) === 0) {
      this.rotationAngle = this.rotationKey === 'r' ? STEP_DEG : -STEP_DEG;
    }
    this.rotationKey = null;
    this.finish();
  }

  /** Klávesa F: okamžité prevrátenie vybraného bloku s animáciou. */
  flipSelected(): boolean {
    if (!this.ok() || this.rotationKey !== null) return false;
    if (this.session && !this.session.snapping) return false;
    if (!this.flip()) return false;
    this.finish();
    return true;
  }

  isKeyRotating() { return this.rotationKey !== null; }
  /** Držaný blok sa už pohol alebo otočil (vtedy sa polohy ruky nesmie vynulovať). */
  hasMoved() { const s = this.session; return !!s && (s.moveStarted || s.dirty || this.rotationAngle !== 0); }
  isGrabbed() { return !!this.session?.grabbed; }
  isBusy() { return !!this.session && !this.session.snapping; }

  /** Zahodí rozpracovaný stav bez potvrdenia (nový level, reštart, zmena ruky). */
  reset() {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
    this.lastFrameAt = null;
    this.session = null;
    this.startPosition = null;
    this.cursorState = null;
    this.hoverUid = null;
    this.resetRotation();
    this.host.render({ live: null, cursor: null, hoverUid: null });
  }

  dispose() {
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
  }
}
