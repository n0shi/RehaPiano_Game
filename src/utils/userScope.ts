// Údaje viazané na prihláseného používateľa (kalibrácia prstov, kalibrácia osí, výsledky): kľúče v localStorage dostanú príponu
// s jeho id, takže každý účet má vlastné. Bez prihláseného používateľa platia pôvodné spoločné kľúče.
let userId: string | null = null;
const listeners = new Set<() => void>();

export function scopedKey(base: string): string {
  return userId ? `${base}:u:${userId}` : base;
}

export function currentUserScope(): string | null {
  return userId;
}

/** Nastaví aktuálneho používateľa (null = nikto). Moduly s vlastnou pamäťou (cache) sa o zmene dozvedia cez onUserScopeChange. */
export function setUserScope(id: string | null) {
  if (id === userId) return;
  userId = id;
  for (const fn of listeners) fn();
}

export function onUserScopeChange(fn: () => void) {
  listeners.add(fn);
}

/** Zmaže všetky údaje používateľa uložené pod jeho príponou (pri zmazaní účtu). */
export function removeUserScopedData(id: string) {
  try {
    const suffix = `:u:${id}`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.endsWith(suffix)) keys.push(k); }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
