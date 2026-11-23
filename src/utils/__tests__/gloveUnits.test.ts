// UNIT (čisté funkcie): prevod surových hodnôt rukavice na fyzikálne jednotky (utils/imuNormalize.ts) a spojenie dvoch rúk
// (utils/dualHands.ts). Prečo: všetky prahy v hre (stisk, otočenie, pokoj) sú v týchto jednotkách – zmena deliteľa ich potichu rozbije.
import { describe, it, expect } from 'vitest';
import { normalizeImuSample, normalizeAdc, scaleGyro, GYRO_DIVISOR, ADC_FULL_SCALE } from '../imuNormalize';
import { fuseSigned } from '../dualHands';

describe('normalizeImuSample', () => {
  it('uhly ostávajú v stupňoch, gyro sa delí deliteľom, zrýchlenie a gravitácia stomi', () => {
    const s = normalizeImuSample({ pitch: -103.5, roll: 25.5, yaw: 180, gyroX: 160, linAccX: 250, gravZ: -981 });
    expect(s.pitchDeg).toBe(-103.5);
    expect(s.rollDeg).toBe(25.5);
    expect(s.yawDeg).toBe(180);
    expect(s.gyroX_dps).toBe(160 / GYRO_DIVISOR);
    expect(s.linAccX).toBe(2.5);
    expect(s.gravZ).toBe(-9.81);
  });

  it('streamer, ktorý už posiela °/s, sa nastaví deliteľom 1', () => {
    expect(normalizeImuSample({ gyroZ: 42 }, 1).gyroZ_dps).toBe(42);
  });

  it('chýbajúca alebo poškodená vzorka dá nuly, nie NaN (kurzor neodletí)', () => {
    for (const raw of [undefined, null, {}, { pitch: 'abc', gyroX: NaN, linAccY: null }]) {
      const s = normalizeImuSample(raw);
      for (const v of [s.pitchDeg, s.rollDeg, s.yawDeg, s.gyroX_dps, s.gyroY_dps, s.gyroZ_dps, s.linAccX, s.linAccY, s.gravX]) expect(v).toBe(0);
      expect(s.quat).toBeUndefined();
    }
  });

  it('čísla poslané ako text sa prečítajú', () => {
    expect(scaleGyro('32')).toBe(2);
  });

  it('kvaternión sa odovzdá len ak ho vzorka má', () => {
    expect(normalizeImuSample({ quatW: 1, quatX: 0, quatY: 0, quatZ: 0 }).quat).toEqual({ w: 1, x: 0, y: 0, z: 0 });
  });
});

describe('normalizeAdc', () => {
  it('veľkosť stisku je kladná bez ohľadu na znamienko kanála', () => {
    expect(normalizeAdc(ADC_FULL_SCALE)).toBe(1);
    expect(normalizeAdc(-ADC_FULL_SCALE / 2)).toBe(0.5);
  });
});

describe('fuseSigned (obe ruky naraz)', () => {
  it('ruky idú rovnakým smerom: platí pomalšia z nich', () => {
    expect(fuseSigned(30, 50)).toBe(30);
    expect(fuseSigned(-80, -20)).toBe(-20);
  });

  it('ruky idú proti sebe alebo jedna stojí: žiadna akcia', () => {
    expect(fuseSigned(30, -50)).toBe(0);
    expect(fuseSigned(30, 0)).toBe(0);
  });

  it('zrkadlovo namontovaný senzor sa opraví znamienkom', () => {
    expect(fuseSigned(30, -50, 1, -1)).toBe(30);
  });
});
