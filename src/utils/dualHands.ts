// Pomocné funkcie pre ovládanie DVOMA rukami naraz (Pentomino).
// Princíp: obe ruky robia ten istý pohyb spolu – akcia sa započíta len ak oba senzory súhlasia.

/**
 * Spojí dve hodnoty (napr. gyro z ľavej a pravej ruky): ak majú rovnaké znamienko,
 * vráti tú s menšou veľkosťou (obe ruky sa musia hýbať aspoň tak rýchlo); ak sa líšia, 0.
 * `signA` / `signB` umožňujú zrkadlenie osi jednej z rúk (ak senzory hlásia opačné znamienko).
 */
export function fuseSigned(a: number, b: number, signA = 1, signB = 1): number {
  const x = a * signA;
  const y = b * signB;
  if (x * y <= 0) return 0;
  return Math.sign(x) * Math.min(Math.abs(x), Math.abs(y));
}

export type DualHand = 'left' | 'right';
export const DUAL_HANDS: DualHand[] = ['left', 'right'];

/**
 * Znamienka osí gyra ľavej ruky vzhľadom na pravú. Ak by pri rovnakom pohybe oboch rúk
 * jedna z nich hlásila opačné znamienko (zrkadlová montáž senzora), prepíš tu -1.
 * Overenie: `python3 tools/axis_test.py --hand left` a `--hand right` a porovnaj znamienka.
 */
export const DUAL_LEFT_GYRO_SIGN = { x: 1, y: 1, z: 1 };
