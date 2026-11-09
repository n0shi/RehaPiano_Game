// Spoločná logika presunu bloku rukou (PentominoGame + cvičenie v kalibrácii).
export const MOVE_START_CELLS = 1;       // ruka sa musí posunúť aspoň o toľko buniek (nezaokrúhlene), aby sa blok začal presúvať (bolo 2 so zaokrúhlením = 1,5 bunky: blok aj kurzor "lepili")
export const MOVE_AXIS_MIN_CELLS = 1;    // posun v osi pod touto hodnotou (bunky) sa ignoruje (náklon ruky ťahá aj druhú os)
export const MOVE_AXIS_DOMINANCE = 0.75; // druhá os sa použije len ak je aspoň tento podiel dominantnej osi (inak sa blok hýbe čisto po jednej osi)
export const MOVE_STEP_MS = 55;          // blok sa posunie najviac o 1 bunku za tento interval (bolo 85: blok zaostával za rukou)
export const MOVE_HOLD_MS = 200;         // grip musí trvať dlhšie než toto, aby sa z neho stal presun (kratšie = tap)

export const MOVE_FAST_DIST = 4;         // od tejto vzdialenosti (bunky) od cieľa v osi sa robí krok o 2 bunky, od dvojnásobku o 3

const unit = (v: number) => Math.sign(v);
const fastSize = (d: number) => {
  const a = Math.abs(d);
  return a >= 2 * MOVE_FAST_DIST ? 3 : a >= MOVE_FAST_DIST ? 2 : 1;
};

/**
 * Kroky bloku k cieľu v poradí preferencie (volajúci vezme prvý, ktorý sa zmestí): veľký krok, jednotkový krok, potom len
 * jedna os (kĺzanie pozdĺž steny/bloku). dCol/dRow = vzdialenosť od cieľa v bunkách. diagonal=true povolí obe osi naraz.
 * Vedľajšia os sa použije len ak je zhruba rovnako výrazná ako hlavná – nepatrný bočný posun ruky blok nesťahuje do strany.
 */
export function pieceStep(dCol: number, dRow: number, stepDue: boolean, diagonal = false): { dc: number; dr: number }[] {
  if (!stepDue) return [];
  const aC = Math.abs(dCol), aR = Math.abs(dRow);
  const dom = diagonal ? 0 : MOVE_AXIS_DOMINANCE;
  const dominant = Math.max(aC, aR);
  const used = (a: number) => a >= MOVE_AXIS_MIN_CELLS && (a === dominant || a >= dom * dominant + 1);
  const useCol = used(aC), useRow = used(aR);
  const out: { dc: number; dr: number }[] = [];
  const add = (dc: number, dr: number) => {
    if ((dc || dr) && !out.some((o) => o.dc === dc && o.dr === dr)) out.push({ dc, dr });
  };
  add(useCol ? unit(dCol) * fastSize(dCol) : 0, useRow ? unit(dRow) * fastSize(dRow) : 0);
  add(useCol ? unit(dCol) : 0, useRow ? unit(dRow) : 0);
  // Kĺzanie pozdĺž steny len pri zámernom diagonálnom pohybe; inak by blok pri náraze do steny "ušiel" bokom
  if (useCol && useRow) {
    add(unit(dCol), 0);
    add(0, unit(dRow));
  }
  return out;
}
