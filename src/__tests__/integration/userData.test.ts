// INTEGRÁCIA (viac modulov spolu, bez obrazovky): účty + prihlásenie + údaje viazané na používateľa + výsledky nad jedným úložiskom
// (utils/accounts.ts, userScope.ts, results.ts). Prečo: každý modul sám funguje, ale chyba v ich spojení znamená, že pacient uvidí
// cudzie výsledky alebo že po zmazaní účtu ostanú jeho dáta v počítači.
import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from '../helpers/memoryStorage';
import { createAccount, loadAccounts, tryLogin, removeAccount, PASS_MAX_FAILS, PASS_LOCK_MS } from '../../utils/accounts';
import { setUserScope, removeUserScopedData } from '../../utils/userScope';
import { addResult, loadResults, summarize } from '../../utils/results';

const profile = (name: string) => ({ name, heightCm: null, weightKg: null, password: 'tajne-heslo' });
const level = (seconds: number) => ({ t: Date.now(), kind: 'pentomino' as const, level: 1, seconds });

beforeEach(() => {
  installMemoryStorage();
  setUserScope(null);
});

describe('účet a prihlásenie', () => {
  it('nový účet sa uloží a heslo sa neukladá v čitateľnej podobe', async () => {
    const acc = await createAccount(profile('Jana'));
    expect(loadAccounts().map((a) => a.name)).toEqual(['Jana']);
    expect(JSON.stringify(loadAccounts())).not.toContain('tajne-heslo');
    expect((await tryLogin(acc, 'tajne-heslo')).ok).toBe(true);
  });

  it('dva účty s rovnakým menom (bez ohľadu na veľkosť písmen) nevzniknú', async () => {
    await createAccount(profile('Jana'));
    await expect(createAccount(profile('JANA'))).rejects.toThrow('už existuje');
    expect(loadAccounts()).toHaveLength(1);
  });

  it(`po ${PASS_MAX_FAILS} nesprávnych heslách sa účet zamkne a po uplynutí času znova pustí`, async () => {
    const acc = await createAccount(profile('Jana'));
    const t0 = 1_000_000;
    for (let i = 1; i < PASS_MAX_FAILS; i++) {
      expect(await tryLogin(acc, 'zle', t0)).toEqual({ ok: false, lockedMs: 0, attemptsLeft: PASS_MAX_FAILS - i });
    }
    expect((await tryLogin(acc, 'zle', t0)).lockedMs).toBe(PASS_LOCK_MS);
    // zamknutý účet odmietne aj správne heslo
    expect((await tryLogin(acc, 'tajne-heslo', t0 + 1000)).ok).toBe(false);
    expect((await tryLogin(acc, 'tajne-heslo', t0 + PASS_LOCK_MS + 1)).ok).toBe(true);
  });
});

describe('výsledky patria prihlásenému používateľovi', () => {
  it('bez prihlásenia sa výsledok neuloží', () => {
    addResult(level(120));
    expect(loadResults()).toEqual([]);
  });

  it('každý používateľ vidí len svoje výsledky', async () => {
    const jana = await createAccount(profile('Jana'));
    const peter = await createAccount(profile('Peter'));

    setUserScope(jana.id);
    addResult(level(120));
    addResult(level(90));

    setUserScope(peter.id);
    expect(loadResults()).toEqual([]);
    addResult(level(300));

    setUserScope(jana.id);
    expect(summarize(loadResults()).pentomino.bestByLevel).toEqual([{ level: 1, best: 90, count: 2 }]);
  });

  it('zmazanie účtu odstráni jeho výsledky a cudzie nechá', async () => {
    const jana = await createAccount(profile('Jana'));
    const peter = await createAccount(profile('Peter'));
    setUserScope(jana.id); addResult(level(120));
    setUserScope(peter.id); addResult(level(300));

    removeAccount(jana.id);
    removeUserScopedData(jana.id);

    expect(loadAccounts().map((a) => a.name)).toEqual(['Peter']);
    expect(loadResults()).toHaveLength(1);
    setUserScope(jana.id);
    expect(loadResults()).toEqual([]);
  });
});
