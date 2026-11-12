// Prepínač modelu "pohyb ruky -> kurzor" pre menu, skúšku kreslenia a Pentomino (na porovnanie na rukavici).
//
//   'legacy'  – pôvodný model: zložky X/Y rotačného vektora otočené o 62° + shear; otočená poloha má vlastné osi
//   'axes3d'  – zvyčajná poloha cez pevné 3D osi (priemer zo záznamov); otočená poloha ako v 'legacy'
//   'gravity' – osi z gravitácie: vodorovne = otočenie okolo zvislice, zvisle = okolo vodorovnej osi kolmej na predlaktie.
//               Jedna konštanta (os predlaktia v senzore), rovnaký výpočet pre zvyčajnú aj otočenú polohu.
//
// Zmena: prepíšte CURSOR_MODEL nižšie a prebuildujte, alebo bez prebuildu v konzole prehliadača:
//   localStorage.setItem('rehapiano.cursorModel', 'gravity')   a obnoviť stránku   (späť: localStorage.removeItem('rehapiano.cursorModel'))
export type CursorModel = 'legacy' | 'axes3d' | 'gravity';
export const CURSOR_MODEL: CursorModel = 'axes3d';

const MODELS: CursorModel[] = ['legacy', 'axes3d', 'gravity'];

export function currentCursorModel(): CursorModel {
  try {
    const v = localStorage.getItem('rehapiano.cursorModel') as CursorModel | null;
    if (v && MODELS.includes(v)) return v;
  } catch { /* bez localStorage platí CURSOR_MODEL */ }
  return CURSOR_MODEL;
}

/** Nastaví na kontroléri zvolený model (volať raz pri vytvorení kontroléra). */
export function applyCursorModel(ctrl: { axes3d: boolean; gravityAxes: boolean }, model: CursorModel = currentCursorModel()) {
  ctrl.axes3d = model === 'axes3d';
  ctrl.gravityAxes = model === 'gravity';
}
