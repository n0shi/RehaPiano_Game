// UNIT: nastavenie kontrolérov rukavice – cache korekcie osí (utils/axisCalibration.ts) a ľavá ruka v režime dvoch rúk (utils/gloveCursor.ts).
// Prečo: applyAxisCorr beží pri každej vzorke, takže cache nesmie vrátiť starú korekciu; ľavá ruka sa priemeruje s pravou,
// takže musí mať rovnaký model pohybu (inak kurzor pri stisku skočí a smery sa líšia).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from '../../__tests__/helpers/memoryStorage';
import { loadAxisCorr, saveAxisCorr, clearAxisCorr, DEFAULT_AXIS_CORR } from '../axisCalibration';
import { GloveCursor, createCursorController } from '../gloveCursor';
import { setUserScope } from '../userScope';

beforeEach(() => {
  installMemoryStorage();
  setUserScope(null);
});

describe('cache korekcie osí', () => {
  it('opakované čítanie nerobí JSON.parse, kým sa uložený text nezmení', () => {
    saveAxisCorr('right', { rot: 10, shearUp: 0, shearRight: 0 });
    loadAxisCorr('right');
    const spy = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 100; i++) loadAxisCorr('right');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('uloženie, zmazanie, iný používateľ aj ručná zmena v localStorage sa prejavia hneď', () => {
    expect(loadAxisCorr('right')).toEqual(DEFAULT_AXIS_CORR.right);
    saveAxisCorr('right', { rot: 10, shearUp: 0, shearRight: 0 });
    expect(loadAxisCorr('right').rot).toBe(10);
    setUserScope('u2');
    expect(loadAxisCorr('right')).toEqual(DEFAULT_AXIS_CORR.right);
    setUserScope(null);
    expect(loadAxisCorr('right').rot).toBe(10);
    localStorage.setItem('rehapiano.axisCalibration.v1', JSON.stringify({ right: { rot: 33, shearUp: 0, shearRight: 0 } }));
    expect(loadAxisCorr('right').rot).toBe(33);
    clearAxisCorr('right');
    expect(loadAxisCorr('right')).toEqual(DEFAULT_AXIS_CORR.right);
  });
});

describe('režim dvoch rúk: ľavá ruka', () => {
  it('má rovnaké nastavenia pohybu ako hlavná ruka a zrkadlenie ľavej ruky', () => {
    const left = new GloveCursor().ensureLeft();
    const ref = createCursorController();
    for (const k of ['gyroDivisor', 'linearTilt', 'angleTilt', 'precisionScale', 'tiltDeadzone', 'tiltMax', 'posLimit', 'posAlpha', 'posGain'] as const) {
      expect(left[k], k).toBe(ref[k]);
    }
    expect(left.precisionScale).toBe(1); // stisk nemení citlivosť (predtým 1,5)
    expect(left.screenFlipX).toBe(false);
    expect(left.screenFlipY).toBe(true);
  });
});
