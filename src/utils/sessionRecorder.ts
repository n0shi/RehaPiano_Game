// Záznam dát z rukavice počas kreslenia a hry Pentomino (len ak s tým prihlásený používateľ pri vstupe do relácie súhlasil).
// Ukladá sa do IndexedDB (utils/recordingStore.ts); export do súboru JSON je v profile používateľa.
//
// Aby záznam stál málo (pamäť, disk, výpočet):
//   - vzorky sa riedia na ~40 za sekundu (rukavica posiela ~125),
//   - ukladajú sa ako 32-bitové čísla v blokoch (76 B na vzorku, t. j. ~190 kB za minútu nepretržitého pohybu),
//   - keď ruka stojí a nič nedrží, nezapisuje sa nič,
//   - na používateľa platí strop MAX_USER_SAMPLES; po jeho dosiahnutí sa nové záznamy nezačínajú (staré treba stiahnuť a vymazať).
import { createRecording, putChunk, finishRecording, deleteRecording, readSamples, userSampleCount, type RecordingHeader } from './recordingStore';
import type { Account } from './accounts';

/**
 * Stĺpce jednej vzorky. t = ms od začiatku záznamu; x, y = poloha kurzora (kreslenie: px plátna, Pentomino: -1..1);
 * active = pero dole (kreslenie) alebo držaný blok (Pentomino).
 */
export const REC_COLUMNS = [
  't', 'quatW', 'quatX', 'quatY', 'quatZ', 'gyroX', 'gyroY', 'gyroZ',
  'adc1', 'adc2', 'adc3', 'adc4', 'adc5', 'fingers', 'grip', 'active', 'x', 'y', 'rolled',
];
const COLS = REC_COLUMNS.length;
const SAMPLE_INTERVAL_MS = 19;   // pri 125 vzorkách/s z rukavice sa uloží každá tretia (~40/s)
const IDLE_GYRO_DPS = 5;         // pod touto rýchlosťou otáčania ruka "stojí"
const IDLE_KEEP_MS = 1500;       // po poslednom pohybe/stisku sa ešte takto dlho zapisuje
const CHUNK_ROWS = 500;          // ~10 s
const MIN_SAMPLES = 50;          // kratší záznam (~1 s) sa zahodí
export const MAX_USER_SAMPLES = 1_000_000; // ~7 h nepretržitého pohybu, ~76 MB

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export class SessionRecorder {
  private buf = new Float32Array(CHUNK_ROWS * COLS);
  private rows = 0;
  private idx = 0;
  private count = 0;
  private events: Record<string, unknown>[] = [];
  private recId: Promise<number>;
  private stopped = false;
  private t0 = Date.now();
  private lastT = 0;
  private lastActive = 0;
  private budget = Infinity;
  // Zatvorenie karty / obnovenie stránky nespustí odmontovanie Reactu (stop()): bez tohto sa stratil rozpracovaný blok
  // (až ~10 s) a hlavička ostala "neukončená" so sampleCount 0, takže sa záznam nerátal ani do stropu úložiska.
  private onPageHide = () => this.checkpoint();

  constructor(userId: string, kind: RecordingHeader['kind'], meta: Record<string, unknown>) {
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
    this.recId = userSampleCount(userId)
      .then((used) => {
        this.budget = MAX_USER_SAMPLES - used;
        if (this.budget <= 0) return -1; // úložisko používateľa je plné
        return createRecording({ userId, kind, startedAt: this.t0, endedAt: null, sampleCount: 0, columns: REC_COLUMNS, meta, events: [] });
      })
      .catch((e) => { console.warn('Záznam dát sa nepodarilo založiť', e); return -1; });
  }

  /** Jedna vzorka z rukavice: detail udalosti 'imu-sample' + stav hry. Lacné: väčšina volaní skončí hneď na prvých podmienkach. */
  add(t: number, detail: any, s: { grip: boolean; active: boolean; x: number; y: number; rolled: boolean }) {
    if (this.stopped || t - this.lastT < SAMPLE_INTERVAL_MS || this.count >= this.budget) return;
    const i = detail?.imu || {};
    const gx = n(i.gyroX), gy = n(i.gyroY), gz = n(i.gyroZ);
    if (s.grip || s.active || Math.abs(gx) > IDLE_GYRO_DPS || Math.abs(gy) > IDLE_GYRO_DPS || Math.abs(gz) > IDLE_GYRO_DPS) this.lastActive = t;
    else if (t - this.lastActive > IDLE_KEEP_MS) return; // ruka stojí a nič nedrží
    this.lastT = t;
    const a = Array.isArray(detail?.adc) ? detail.adc : [];
    const b = this.buf, o = this.rows * COLS;
    b[o] = t - this.t0; b[o + 1] = n(i.quatW); b[o + 2] = n(i.quatX); b[o + 3] = n(i.quatY); b[o + 4] = n(i.quatZ);
    b[o + 5] = gx; b[o + 6] = gy; b[o + 7] = gz;
    b[o + 8] = n(a[1]); b[o + 9] = n(a[2]); b[o + 10] = n(a[3]); b[o + 11] = n(a[4]); b[o + 12] = n(a[5]);
    b[o + 13] = typeof detail?.fingers?.count === 'number' ? detail.fingers.count : -1;
    b[o + 14] = s.grip ? 1 : 0; b[o + 15] = s.active ? 1 : 0; b[o + 16] = s.x; b[o + 17] = s.y; b[o + 18] = s.rolled ? 1 : 0;
    this.count++;
    if (++this.rows >= CHUNK_ROWS) this.flush();
  }

  event(e: Record<string, unknown>) {
    if (!this.stopped) this.events.push({ t: Date.now() - this.t0, ...e });
  }

  private flush() {
    if (!this.rows) return;
    const data = this.buf.slice(0, this.rows * COLS), idx = this.idx++;
    this.rows = 0;
    void this.recId.then((id) => (id >= 0 ? putChunk(id, idx, COLS, data) : undefined)).catch((e) => console.warn('Záznam dát: zápis zlyhal', e));
  }

  /**
   * Zapíše rozpracovaný blok a priebežnú hlavičku, záznam však beží ďalej (stránka sa môže vrátiť z bfcache; vtedy ho neskôr
   * ukončí stop()). Krátky záznam sa tu nemaže – o tom rozhodne až stop().
   */
  checkpoint() {
    if (this.stopped) return;
    this.flush();
    const patch = { endedAt: Date.now(), sampleCount: this.count, events: [...this.events] };
    void this.recId
      .then((id) => (id >= 0 && this.count > 0 ? finishRecording(id, patch) : undefined))
      .catch((e) => console.warn('Záznam dát: priebežné uloženie zlyhalo', e));
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    this.flush();
    try {
      const id = await this.recId;
      if (id < 0) return;
      if (this.count < MIN_SAMPLES) await deleteRecording(id);
      else await finishRecording(id, { endedAt: Date.now(), sampleCount: this.count, events: this.events });
    } catch (e) {
      console.warn('Záznam dát: ukončenie zlyhalo', e);
    }
  }
}

/** Obsah súboru na export: hlavička, údaje o používateľovi potrebné na analýzu a všetky vzorky. */
export async function buildExport(rec: RecordingHeader, user: Account) {
  return {
    format: 'rehapiano-recording-v2',
    kind: rec.kind,
    user: { id: user.id, name: user.name, heightCm: user.heightCm, weightKg: user.weightKg },
    startedAt: new Date(rec.startedAt).toISOString(),
    endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
    meta: rec.meta,
    events: rec.events,
    columns: rec.columns,
    samples: rec.id !== undefined ? await readSamples(rec.id) : [],
  };
}

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
