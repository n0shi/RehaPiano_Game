// Zosilnenie kurzora podľa rýchlosti ruky (ako "zrýchlenie ukazovateľa" pri myši): pomalý pohyb posúva kurzor menej (presné
// dosadnutie bloku, menej chvenia v pokoji), rýchly viac (dosah cez celé pole bez veľkého náklonu).
// Pracuje s prírastkami polohy: výstup = súčet prírastkov vstupu násobených zosilnením, takže kurzor neskáče pri zmene zosilnenia.

export type SpeedGainConfig = {
  slowSpeed: number; // rozsah/s: pod touto rýchlosťou platí slowGain
  fastSpeed: number; // rozsah/s: nad touto rýchlosťou platí fastGain
  slowGain: number;
  fastGain: number;
  smoothMs: number;  // časová konštanta vyhladenia rýchlosti (surová rýchlosť z jednej vzorky je hlavne šum)
};

// Pentomino: pole má 20 buniek na rozsah 2, t. j. 0,1 na bunku. Dosadanie bloku ide rýchlosťou ~1–3 bunky/s, presun cez pole 10+ buniek/s.
export const PENTOMINO_SPEED_GAIN: SpeedGainConfig = { slowSpeed: 0.3, fastSpeed: 1.5, slowGain: 0.6, fastGain: 1.3, smoothMs: 80 };

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
    this.out.x += g * dx; this.out.y += g * dy;
    return { ...this.out };
  }
}
