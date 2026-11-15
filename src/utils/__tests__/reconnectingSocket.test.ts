// Spojenie so streamerom rukavice: po strate sa musí samo obnoviť (bez siete: falošný socket a ručne spúšťané časovače).
import { describe, it, expect } from 'vitest';
import { ReconnectingSocket, RECONNECT_MIN_MS, RECONNECT_MAX_MS, type SocketLike } from '../reconnectingSocket';

class FakeSocket implements SocketLike {
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  closed = false;
  close() { this.closed = true; }
}

function setup(failCreate = () => false) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const status: boolean[] = [];
  const messages: unknown[] = [];
  let nextId = 1;
  const rs = new ReconnectingSocket({
    url: 'ws://test',
    onStatus: (v) => status.push(v),
    onMessage: (d) => messages.push(d),
    createSocket: () => { if (failCreate()) throw new Error('bad url'); const s = new FakeSocket(); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  /** Spustí naplánovaný pokus o pripojenie; vráti čakanie v ms. */
  const fire = () => { const t = timers.shift()!; t.fn(); return t.ms; };
  return { rs, sockets, timers, status, messages, fire, last: () => sockets[sockets.length - 1] };
}

describe('ReconnectingSocket', () => {
  it('pripojí sa hneď a ohlási stav až po otvorení', () => {
    const h = setup();
    expect(h.sockets).toHaveLength(1);
    expect(h.status).toEqual([]);
    h.last().onopen!({});
    expect(h.status).toEqual([true]);
  });

  it('po zatvorení (reštart streamera) ohlási odpojenie a pripojí sa znova', () => {
    const h = setup();
    h.last().onopen!({});
    h.last().onclose!({});
    expect(h.status).toEqual([true, false]);
    expect(h.timers).toHaveLength(1);
    expect(h.fire()).toBe(RECONNECT_MIN_MS);
    expect(h.sockets).toHaveLength(2);
    h.last().onopen!({});
    expect(h.status).toEqual([true, false, true]);
  });

  it('chyba aj zatvorenie toho istého socketu naplánujú len jeden pokus', () => {
    const h = setup();
    const s = h.last();
    s.onopen!({});
    s.onerror!({}); s.onclose!({});
    expect(h.timers).toHaveLength(1);
    expect(h.status).toEqual([true, false]);
    expect(s.closed).toBe(true);
  });

  it('kým streamer nebeží, skúša ďalej s dlhším čakaním (najviac RECONNECT_MAX_MS) a stav neopakuje', () => {
    const h = setup();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) { h.last().onerror!({}); waits.push(h.fire()); }
    expect(waits[0]).toBe(RECONNECT_MIN_MS);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    expect(waits[waits.length - 1]).toBe(RECONNECT_MAX_MS);
    expect(h.status).toEqual([]); // nikdy nebol pripojený: žiadne falošné "odpojený"
    expect(h.sockets).toHaveLength(9);
  });

  it('po úspešnom pripojení sa čakanie vráti na najkratšie', () => {
    const h = setup();
    for (let i = 0; i < 6; i++) { h.last().onerror!({}); h.fire(); }
    h.last().onopen!({});
    h.last().onclose!({});
    expect(h.fire()).toBe(RECONNECT_MIN_MS);
  });

  it('správy odovzdáva len z aktuálneho socketu', () => {
    const h = setup();
    const old = h.last();
    old.onopen!({});
    old.onmessage!({ data: 'a' });
    old.onclose!({}); h.fire();
    old.onmessage?.({ data: 'stará' });
    old.onclose?.({});
    h.last().onopen!({});
    h.last().onmessage!({ data: 'b' });
    expect(h.messages).toEqual(['a', 'b']);
    expect(h.timers).toHaveLength(0); // neskoré udalosti starého socketu nenaplánovali nič
  });

  it('dispose zatvorí socket, zruší čakajúci pokus a už sa nepripája', () => {
    const h = setup();
    h.last().onopen!({});
    h.rs.dispose();
    expect(h.last().closed).toBe(true);
    expect(h.status).toEqual([true, false]);
    h.last().onclose?.({});
    expect(h.timers).toHaveLength(0);

    const g = setup();
    g.last().onclose!({});
    expect(g.timers).toHaveLength(1);
    g.rs.dispose();
    expect(g.timers).toHaveLength(0);
    expect(g.sockets).toHaveLength(1);
  });

  it('keď sa socket nedá vytvoriť, skúša ďalej', () => {
    let fail = true;
    const h = setup(() => fail);
    expect(h.sockets).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    fail = false; h.fire();
    expect(h.sockets).toHaveLength(1);
  });
});
