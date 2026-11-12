// Záznam dát z rukavice počas kreslenia (len ak s tým prihlásený používateľ pri vstupe do relácie súhlasil).
// Ukladá sa do IndexedDB (utils/recordingStore.ts); export do súboru JSON je v profile používateľa.
import { createRecording, putChunk, finishRecording, deleteRecording, readSamples, type RecordingHeader } from './recordingStore';
import type { Account } from './accounts';

/** Stĺpce jednej vzorky. t = čas prijatia (ms), kurzor v px plátna (rozmer plátna je v udalosti 'shape'). */
export const DRAW_COLUMNS = [
  't', 'quatW', 'quatX', 'quatY', 'quatZ', 'gyroX', 'gyroY', 'gyroZ', 'linAccX', 'linAccY', 'linAccZ',
  'adc1', 'adc2', 'adc3', 'adc4', 'adc5', 'fingers', 'grip', 'pen', 'cursorX', 'cursorY', 'rolled',
];
const CHUNK_ROWS = 1000;      // ~8 s pri 125 vzorkách/s
const MIN_SAMPLES = 125;      // kratší záznam (~1 s) sa zahodí

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export class DrawingRecorder {
  private rows: number[][] = [];
  private idx = 0;
  private count = 0;
  private events: Record<string, unknown>[] = [];
  private recId: Promise<number>;
  private stopped = false;

  constructor(userId: string, meta: Record<string, unknown>) {
    this.recId = createRecording({
      userId, kind: 'drawing', startedAt: Date.now(), endedAt: null, sampleCount: 0, columns: DRAW_COLUMNS, meta, events: [],
    }).catch((e) => { console.warn('Záznam dát sa nepodarilo založiť', e); return -1; });
  }

  /** Jedna vzorka z rukavice: detail udalosti 'imu-sample' + stav kreslenia. */
  add(t: number, detail: any, s: { grip: boolean; pen: boolean; x: number; y: number; rolled: boolean }) {
    if (this.stopped) return;
    const i = detail?.imu || {}, a = Array.isArray(detail?.adc) ? detail.adc : [];
    this.rows.push([
      t, n(i.quatW), n(i.quatX), n(i.quatY), n(i.quatZ), n(i.gyroX), n(i.gyroY), n(i.gyroZ), n(i.linAccX), n(i.linAccY), n(i.linAccZ),
      n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5]), typeof detail?.fingers?.count === 'number' ? detail.fingers.count : -1,
      s.grip ? 1 : 0, s.pen ? 1 : 0, Math.round(s.x * 10) / 10, Math.round(s.y * 10) / 10, s.rolled ? 1 : 0,
    ]);
    this.count++;
    if (this.rows.length >= CHUNK_ROWS) this.flush();
  }

  event(e: Record<string, unknown>) {
    if (!this.stopped) this.events.push({ t: Date.now(), ...e });
  }

  private flush() {
    if (!this.rows.length) return;
    const rows = this.rows, idx = this.idx++;
    this.rows = [];
    void this.recId.then((id) => (id >= 0 ? putChunk(id, idx, rows) : undefined)).catch((e) => console.warn('Záznam dát: zápis zlyhal', e));
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
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
    format: 'rehapiano-drawing-v1',
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
