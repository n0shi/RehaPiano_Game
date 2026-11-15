// Spojenie so streamerom rukavice, ktoré sa samo obnovuje. Prehliadačový WebSocket sa po zatvorení znova nepripojí:
// po reštarte streamera alebo odpojení rukavice ostala aplikácia "WS odpojený", kým sa stránka neobnovila.
// Tu sa po každom zatvorení/chybe naplánuje nový pokus (1 s, potom dlhšie až po 5 s; po úspešnom pripojení zase od 1 s).
// Bez Reactu; WebSocket aj časovač sa dajú vymeniť, takže sa to dá testovať bez siete.

export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 5000;
export const RECONNECT_FACTOR = 1.5;

/** Časť WebSocketu, ktorú spojenie používa. */
export type SocketLike = {
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  close(): void;
};

export type ReconnectingSocketOptions = {
  url: string;
  onStatus(connected: boolean): void;   // volá sa len pri zmene stavu
  onMessage(data: unknown): void;
  createSocket?(url: string): SocketLike;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
};

export class ReconnectingSocket {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private delay = RECONNECT_MIN_MS;
  private connected = false;
  private disposed = false;
  private createSocket: (url: string) => SocketLike;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;

  constructor(private opts: ReconnectingSocketOptions) {
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.connect();
  }

  private setConnected(v: boolean) {
    if (v === this.connected) return;
    this.connected = v;
    this.opts.onStatus(v);
  }

  private connect() {
    if (this.disposed) return;
    this.timer = null;
    let s: SocketLike;
    try {
      s = this.createSocket(this.opts.url);
    } catch {
      this.retry(); // napr. neplatná adresa: skúšaj ďalej, adresa sa môže v konfigurácii opraviť až po obnovení stránky
      return;
    }
    this.socket = s;
    // Udalosti starého socketu (ktorý sa medzitým nahradil alebo zrušil) sa ignorujú
    const mine = () => this.socket === s && !this.disposed;
    s.onopen = () => { if (!mine()) return; this.delay = RECONNECT_MIN_MS; this.setConnected(true); };
    s.onmessage = (ev) => { if (mine()) this.opts.onMessage(ev?.data); };
    // chyba aj zatvorenie môžu prísť obe: druhý pokus sa neplánuje (socket je už null)
    const lost = () => {
      if (!mine()) return;
      this.socket = null;
      try { s.close(); } catch { /* ignore */ }
      this.setConnected(false);
      this.retry();
    };
    s.onerror = lost;
    s.onclose = lost;
  }

  private retry() {
    if (this.disposed || this.timer !== null) return;
    const wait = this.delay;
    this.delay = Math.min(RECONNECT_MAX_MS, Math.round(this.delay * RECONNECT_FACTOR));
    this.timer = this.setTimer(() => this.connect(), wait);
  }

  /** Ukončí spojenie natrvalo (odmontovanie komponentu, zmena adresy). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const s = this.socket;
    this.socket = null;
    try { s?.close(); } catch { /* ignore */ }
    this.setConnected(false);
  }
}
