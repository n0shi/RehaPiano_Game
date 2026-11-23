// UNIT (čistá funkcia): ktorým krokom sa držaný blok posunie za rukou (utils/pieceMovement.ts).
// Prečo: chyby tu sa na rukavici prejavujú ako "blok ide šikmo / lepí sa / zaostáva" – a bez rukavice sa inak nedajú zopakovať.
import { describe, it, expect } from 'vitest';
import { pieceStep, MOVE_FAST_DIST } from '../pieceMovement';

describe('pieceStep', () => {
  it('kým neuplynul interval kroku, blok sa nehýbe', () => {
    expect(pieceStep(5, 5, false)).toEqual([]);
  });

  it('ruka posunutá o menej než bunku blok nepohne', () => {
    expect(pieceStep(0.6, -0.9, true)).toEqual([]);
  });

  it('blízko cieľa ide blok po jednej bunke', () => {
    expect(pieceStep(2, 0, true)).toEqual([{ dc: 1, dr: 0 }]);
    expect(pieceStep(0, -3, true)).toEqual([{ dc: 0, dr: -1 }]);
  });

  it('ďaleko od cieľa robí väčší krok, s jednotkovým krokom ako záložnou možnosťou', () => {
    expect(pieceStep(MOVE_FAST_DIST, 0, true)).toEqual([{ dc: 2, dr: 0 }, { dc: 1, dr: 0 }]);
    expect(pieceStep(-2 * MOVE_FAST_DIST, 0, true)).toEqual([{ dc: -3, dr: 0 }, { dc: -1, dr: 0 }]);
  });

  it('malý bočný posun ruky blok nesťahuje do strany', () => {
    for (const s of pieceStep(5, 1, true)) expect(s.dr).toBe(0);
  });

  it('zámerný šikmý pohyb: najprv obe osi, potom kĺzanie po jednej osi (popri stene)', () => {
    expect(pieceStep(3, 3, true)).toEqual([{ dc: 1, dr: 1 }, { dc: 1, dr: 0 }, { dc: 0, dr: 1 }]);
  });

  it('diagonal=true povolí obe osi aj pri nerovnakom posune', () => {
    expect(pieceStep(3, 1, true)[0]).toEqual({ dc: 1, dr: 0 });
    expect(pieceStep(3, 1, true, true)[0]).toEqual({ dc: 1, dr: 1 });
  });
});
