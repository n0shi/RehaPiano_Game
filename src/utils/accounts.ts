// Používateľské účty. Aplikácia nemá server, takže účty žijú v prehliadači tohto počítača (localStorage).
// Každý účet má heslo, aby sa nikto neprihlásil do cudzieho profilu; po PASS_MAX_FAILS nesprávnych pokusoch sa účet na chvíľu zamkne.
// Ukladá sa len odtlačok hesla (PBKDF2-SHA256 so soľou; mimo zabezpečeného kontextu slabšia náhrada). Nie je to ochrana pred niekým,
// kto má prístup k súborom prehliadača na tomto počítači.

export type Account = {
  id: string;
  /** meno a priezvisko alebo prezývka; slúži aj ako prihlasovacie meno (jedinečné) */
  name: string;
  heightCm: number | null;
  weightKg: number | null;
  createdAt: number;
  /** posledná voľba "zaznamenávať dáta z rukavice" – len predvyplní voľbu pri ďalšej relácii */
  recordDefault: boolean;
  pass: { algo: 'pbkdf2' | 'weak'; salt: string; hash: string } | null;
};

export type ProfileInput = { name: string; heightCm: number | null; weightKg: number | null; password?: string };

const KEY = 'rehapiano.accounts.v1';
export const HEIGHT_RANGE = [50, 250] as const;
export const WEIGHT_RANGE = [10, 300] as const;
export const PASS_MIN_LENGTH = 6;
export const PASS_MAX_FAILS = 5;       // toľko nesprávnych pokusov po sebe zamkne účet
export const PASS_LOCK_MS = 60_000;    // na takto dlho
const FAILS_KEY = 'rehapiano.loginFails.v1';

export function loadAccounts(): Account[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string') : [];
  } catch {
    return [];
  }
}

function saveAccounts(list: Account[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

const hex = (buf: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(buf as ArrayBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
function randomHex(bytes: number) {
  const a = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return hex(a);
}

async function hashPassword(password: string, salt: string, algo: 'pbkdf2' | 'weak'): Promise<string> {
  if (algo === 'pbkdf2') {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
  }
  // Náhrada bez WebCrypto (stránka otvorená cez http z inej adresy než localhost): opakovaný FNV-1a, len proti zámene profilov
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = salt + password;
  for (let r = 0; r < 2000; r++) {
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (s.charCodeAt(i) + r), 0x811c9dc5) >>> 0;
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

async function makePass(password: string): Promise<Account['pass']> {
  if (!password) return null;
  const algo: 'pbkdf2' | 'weak' = globalThis.crypto?.subtle ? 'pbkdf2' : 'weak';
  const salt = randomHex(16);
  return { algo, salt, hash: await hashPassword(password, salt, algo) };
}

/**
 * Overí vstup; vracia text chyby (po slovensky) alebo null. `selfId` = účet, ktorý sa upravuje (jeho meno sa nepovažuje za obsadené).
 * Heslo je povinné pri novom účte; pri úprave `password === undefined` znamená "bez zmeny".
 */
export function validateProfile(p: ProfileInput, selfId?: string): string | null {
  const name = p.name.trim();
  if (name.length < 2) return 'Zadajte meno alebo prezývku (aspoň 2 znaky).';
  if (name.length > 40) return 'Meno je príliš dlhé (najviac 40 znakov).';
  if (loadAccounts().some((a) => a.id !== selfId && a.name.toLowerCase() === name.toLowerCase())) return 'Účet s týmto menom už existuje.';
  if (p.heightCm !== null && !(p.heightCm >= HEIGHT_RANGE[0] && p.heightCm <= HEIGHT_RANGE[1])) return `Výška musí byť ${HEIGHT_RANGE[0]}–${HEIGHT_RANGE[1]} cm (alebo nechajte prázdne).`;
  if (p.weightKg !== null && !(p.weightKg >= WEIGHT_RANGE[0] && p.weightKg <= WEIGHT_RANGE[1])) return `Hmotnosť musí byť ${WEIGHT_RANGE[0]}–${WEIGHT_RANGE[1]} kg (alebo nechajte prázdne).`;
  if (p.password === undefined ? !selfId : p.password.length < PASS_MIN_LENGTH) return `Heslo musí mať aspoň ${PASS_MIN_LENGTH} znakov.`;
  return null;
}

export async function createAccount(p: ProfileInput): Promise<Account> {
  const err = validateProfile(p);
  if (err) throw new Error(err);
  const acc: Account = {
    id: randomHex(8),
    name: p.name.trim(),
    heightCm: p.heightCm,
    weightKg: p.weightKg,
    createdAt: Date.now(),
    recordDefault: false,
    pass: await makePass(p.password ?? ''),
  };
  saveAccounts([...loadAccounts(), acc]);
  return acc;
}

export async function checkPassword(acc: Account, password: string): Promise<boolean> {
  if (!acc.pass) return false; // účet bez hesla (zo staršej verzie) si heslo musí najprv nastaviť
  if (acc.pass.algo === 'pbkdf2' && !globalThis.crypto?.subtle) return false; // heslo vzniklo v zabezpečenom kontexte, tu sa overiť nedá
  return (await hashPassword(password, acc.pass.salt, acc.pass.algo)) === acc.pass.hash;
}

type Fails = Record<string, { n: number; until: number }>;
function readFails(): Fails {
  try { return JSON.parse(localStorage.getItem(FAILS_KEY) || '{}') || {}; } catch { return {}; }
}
/** Koľko ms je účet ešte zamknutý po nesprávnych pokusoch (0 = nie je). */
export function lockRemainingMs(id: string, now = Date.now()): number {
  return Math.max(0, (readFails()[id]?.until ?? 0) - now);
}

/** Prihlásenie heslom s počítaním nesprávnych pokusov. */
export async function tryLogin(acc: Account, password: string, now = Date.now()): Promise<{ ok: boolean; lockedMs: number; attemptsLeft: number }> {
  const fails = readFails();
  const f = fails[acc.id] ?? { n: 0, until: 0 };
  if (f.until > now) return { ok: false, lockedMs: f.until - now, attemptsLeft: 0 };
  const ok = await checkPassword(acc, password);
  if (ok) delete fails[acc.id];
  else {
    f.n++;
    if (f.n >= PASS_MAX_FAILS) { f.n = 0; f.until = now + PASS_LOCK_MS; }
    fails[acc.id] = f;
  }
  try { localStorage.setItem(FAILS_KEY, JSON.stringify(fails)); } catch { /* ignore */ }
  return { ok, lockedMs: Math.max(0, f.until - now), attemptsLeft: ok ? PASS_MAX_FAILS : PASS_MAX_FAILS - f.n };
}

/** Zmení údaje účtu. `password`: undefined = bez zmeny, inak nové heslo. */
export async function updateAccount(id: string, patch: Partial<ProfileInput> & { recordDefault?: boolean }): Promise<Account> {
  const list = loadAccounts();
  const cur = list.find((a) => a.id === id);
  if (!cur) throw new Error('Účet neexistuje.');
  const next: Account = { ...cur };
  if (patch.name !== undefined || patch.heightCm !== undefined || patch.weightKg !== undefined || patch.password !== undefined) {
    const merged: ProfileInput = {
      name: patch.name ?? cur.name,
      heightCm: patch.heightCm !== undefined ? patch.heightCm : cur.heightCm,
      weightKg: patch.weightKg !== undefined ? patch.weightKg : cur.weightKg,
      password: patch.password,
    };
    const err = validateProfile(merged, id);
    if (err) throw new Error(err);
    next.name = merged.name.trim(); next.heightCm = merged.heightCm; next.weightKg = merged.weightKg;
    if (patch.password !== undefined) next.pass = await makePass(patch.password);
  }
  if (patch.recordDefault !== undefined) next.recordDefault = patch.recordDefault;
  saveAccounts(list.map((a) => (a.id === id ? next : a)));
  return next;
}

export function removeAccount(id: string) {
  saveAccounts(loadAccounts().filter((a) => a.id !== id));
}

/** Text z poľa formulára -> číslo alebo null (prázdne = neuvedené). NaN = neplatný vstup. */
export function parseOptionalNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
