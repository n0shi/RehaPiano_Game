// UNIT: dt medzi vzorkami podľa hodín streamera (utils/sampleClock.ts).
// Prečo: dt z času prehliadača je pri dávkach správ nerovnomerný; od dt závisí otáčanie bloku (integrácia gyra) a zosilnenie podľa rýchlosti.
import { describe, it, expect } from 'vitest';
import { SampleClock, sampleDt, SAMPLE_DT_MAX, SAMPLE_DT_MIN } from '../sampleClock';

describe('SampleClock', () => {
  it('berie sys_mono streamera, nie čas príchodu do prehliadača (dávka správ)', () => {
    const c = new SampleClock();
    expect(c.dt({ port: 'a', sys_mono: 10.000 }, 1000)).toBeNull();
    // tri vzorky po 8 ms prídu naraz (rovnaký čas prehliadača)
    expect(c.dt({ port: 'a', sys_mono: 10.008 }, 1030)).toBeCloseTo(0.008, 6);
    expect(c.dt({ port: 'a', sys_mono: 10.016 }, 1030)).toBeCloseTo(0.008, 6);
    expect(c.dt({ port: 'a', sys_mono: 10.024 }, 1030)).toBeCloseTo(0.008, 6);
  });

  it('dve zariadenia majú vlastný čas', () => {
    const c = new SampleClock();
    c.dt({ port: 'L', sys_mono: 5 }, 0);
    c.dt({ port: 'R', sys_mono: 100 }, 0);
    expect(c.dt({ port: 'L', sys_mono: 5.01 }, 0)).toBeCloseTo(0.01, 6);
    expect(c.dt({ port: 'R', sys_mono: 100.008 }, 0)).toBeCloseTo(0.008, 6);
  });

  it('epochový ts, ktorý cúvne, sa nepoužije (záloha čas prehliadača)', () => {
    const c = new SampleClock();
    c.dt({ ts: 100.010 }, 1000);
    expect(c.dt({ ts: 100.005 }, 1012)).toBeCloseTo(0.012, 6);
    expect(c.dt({ ts: 100.015 }, 1020)).toBeCloseTo(0.010, 6);
  });

  it('výpadok sa obmedzí (gyro sa neintegruje cez celú pauzu) a dt nie je nikdy 0', () => {
    const c = new SampleClock();
    c.dt({ sys_mono: 1 }, 0);
    expect(c.dt({ sys_mono: 4 }, 3000)).toBe(SAMPLE_DT_MAX);
    // rovnaký čas streamera aj prehliadača (duplicitná vzorka): najmenšie dt, nie 0 ani delenie nulou
    expect(c.dt({ sys_mono: 4 }, 3000)).toBe(SAMPLE_DT_MIN);
  });

  it('bez času streamera sa správa ako doteraz (čas prehliadača)', () => {
    const c = new SampleClock();
    c.dt({}, 1000);
    expect(c.dt({}, 1008)).toBeCloseTo(0.008, 6);
  });

  it('sampleDt: detail.dt má prednosť, inak pôvodný výpočet z Date.now', () => {
    expect(sampleDt({ dt: 0.008 }, 40)).toBe(0.008);
    expect(sampleDt({ dt: null }, 40)).toBe(0.04);
    expect(sampleDt({}, 0)).toBe(0.001);
  });
});
