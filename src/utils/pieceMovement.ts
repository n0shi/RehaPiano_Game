// Spoločná logika presunu bloku rukou (PentominoGame + cvičenie v kalibrácii).
export const MOVE_START_CELLS = 3;       // ruka sa musí posunúť aspoň o toľko buniek, aby sa blok vôbec začal presúvať
export const MOVE_AXIS_MIN_CELLS = 1;    // posun v osi pod touto hodnotou (bunky) sa ignoruje (náklon ruky ťahá aj druhú os)
export const MOVE_AXIS_DOMINANCE = 0.5;  // druhá os sa použije len ak je aspoň tento podiel dominantnej osi (inak žiadna uhlopriečka)
export const MOVE_STEP_MS = 60;          // blok sa posunie najviac o 1 bunku za tento interval
export const MOVE_HOLD_MS = 200;         // grip musí trvať dlhšie než toto, aby sa z neho stal presun (kratšie = tap)

/** Jeden krok bloku k cieľu: dCol/dRow = vzdialenosť od cieľa v bunkách. diagonal=true povolí obe osi naraz. */
export function pieceStep(dCol: number, dRow: number, stepDue: boolean, diagonal = false) {
  const dom = diagonal ? 0 : MOVE_AXIS_DOMINANCE;
  const useCol = Math.abs(dCol) >= MOVE_AXIS_MIN_CELLS && Math.abs(dCol) >= dom * Math.abs(dRow);
  const useRow = Math.abs(dRow) >= MOVE_AXIS_MIN_CELLS && Math.abs(dRow) >= dom * Math.abs(dCol);
  return {
    dc: stepDue && useCol ? Math.sign(dCol) : 0,
    dr: stepDue && useRow ? Math.sign(dRow) : 0,
  };
}
