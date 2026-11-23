// Zosilnenie kurzora podľa rýchlosti ruky (ako "zrýchlenie ukazovateľa" pri myši): pomalý pohyb posúva kurzor menej (presné
// dosadnutie bloku, menej chvenia v pokoji), rýchly viac (dosah cez celé pole bez veľkého náklonu).
// Pracuje s prírastkami polohy: výstup = súčet prírastkov vstupu násobených zosilnením, takže kurzor neskáče pri zmene zosilnenia.

export type SpeedGainConfig = {
  slowSpeed: number; // rozsah/s: pod touto rýchlosťou platí slowGain
  fastSpeed: number; // rozsah/s: nad touto rýchlosťou platí fastGain
  slowGain: number;
  fastGain: number;
  smoothMs: number;  // časová konštanta vyhladenia rýchlosti (surová rýchlosť z jednej vzorky je hlavne šum)
  // Splácanie posunu (pozri apply). Bez nich (0) sa rozdiel výstup − vstup hromadí bez obmedzenia.
  driftBudget?: number; // rozsah: takýto rozdiel medzi kurzorom a "poctivou" polohou ruky je dovolený (presnosť pomalého / dosah rýchleho pohybu)
  driftRepay?: number;  // 0..1: najviac taký podiel prírastku ruky sa použije na splatenie rozdielu nad driftBudget
};

// Pentomino: pole má 20 buniek na rozsah 2, t. j. 0,1 na bunku. Dosadanie bloku ide rýchlosťou ~1–3 bunky/s, presun cez pole 10+ buniek/s.
// driftBudget 0,2 = 2 bunky Pentomina: jeden rýchly prejazd cez pole (vstup ~1,0 -> výstup +0,3) si dosah zachová takmer celý.
export const PENTOMINO_SPEED_GAIN: SpeedGainConfig = {
  slowSpeed: 0.3, fastSpeed: 1.5, slowGain: 0.6, fastGain: 1.3, smoothMs: 80, driftBudget: 0.2, driftRepay: 0.35,
};

export class SpeedGain {
  private prev: { x: number; y: number } | null = null;
  private out = { x: 0, y: 0 };
  private vx = 0;
  private vy = 0;
  private speed = 0;
  constructor(public cfg: SpeedGainConfig) {}

  /** Aktuálne zosilnenie (na ladenie / zobrazenie). */
  gain(): number {
    const { slowSpeed, fastSpeed, slowGain, fastGain } = this.cfg;
    const u = Math.max(0, Math.min(1, (this.speed - slowSpeed) / Math.max(1e-6, fastSpeed - slowSpeed)));
    return slowGain + (fastGain - slowGain) * u * u * (3 - 2 * u); // plynulý prechod bez zlomu
  }

  /**
   * Vstupná poloha -> poloha so zosilnením podľa rýchlosti. `reset` = vstup skočil (vynulovanie náklonu): výstup sa nastaví na vstup
   * a prírastok sa nepočíta.
   */
  apply(pos: { x: number; y: number }, dtSec: number, reset = false): { x: number; y: number } {
    if (reset || !this.prev) {
      this.prev = { ...pos }; this.out = { ...pos }; this.vx = this.vy = this.speed = 0;
      return { ...this.out };
    }
    const dx = pos.x - this.prev.x, dy = pos.y - this.prev.y;
    this.prev = { ...pos };
    const dt = Math.max(0.001, Math.min(0.1, dtSec));
    const a = 1 - Math.exp(-(dt * 1000) / this.cfg.smoothMs);
    // vyhladzuje sa vektor rýchlosti, nie jeho veľkosť: chvenie ruky (sem-tam) sa tak vyruší a nepôsobí ako rýchly pohyb
    this.vx += a * (dx / dt - this.vx); this.vy += a * (dy / dt - this.vy);
    this.speed = Math.hypot(this.vx, this.vy);
    const g = this.gain();
    let sx = g * dx, sy = g * dy;
    // Splácanie posunu. Výstup je súčet prírastkov × zosilnenie, takže pomalý pohyb tam (×0,6) a rýchly späť (×1,3) posunul kurzor
    // voči ruke natrvalo: pri rovnakej polohe zápästia stál kurzor inde a jedna strana poľa sa stávala nedosiahnuteľnou.
    // Rozdiel výstup − vstup do driftBudget ostáva (to je zmysel zosilnenia); časť nad ním sa spláca, len keď sa ruka hýbe, a len
    // pozdĺž smeru pohybu (krok sa predĺži/skráti najviac o driftRepay·|prírastok|): smer pohybu sa nemení a v pokoji kurzor nestojí inde.
    const budget = this.cfg.driftBudget ?? 0, repay = this.cfg.driftRepay ?? 0;
    const d = Math.hypot(dx, dy);
    if (repay > 0 && d > 1e-9) {
      const ux = dx / d, uy = dy / d;
      const along = (this.out.x + sx - pos.x) * ux + (this.out.y + sy - pos.y) * uy; // + = kurzor predbieha ruku v smere pohybu
      const excess = along - Math.max(-budget, Math.min(budget, along));
      const c = Math.max(-repay * d, Math.min(repay * d, excess));
      sx -= c * ux; sy -= c * uy;
    }
    this.out.x += sx; this.out.y += sy;
    return { ...this.out };
  }
}
