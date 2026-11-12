import { useState, type FormEvent } from 'react';
import { UserRound, UserPlus, Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { parseOptionalNumber, validateProfile, type Account, type ProfileInput } from '../utils/accounts';

// Vstup do aplikácie: výber existujúceho profilu alebo vytvorenie nového, potom voľba záznamu dát pre túto reláciu.

const card = 'bg-white rounded-3xl shadow-2xl p-8 w-full max-w-xl';
const input = 'w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-blue-400 outline-none text-lg text-slate-800';
const primary = 'px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold text-lg transition-colors';
const secondary = 'px-6 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-lg transition-colors';

/** Polia profilu (spoločné pre registráciu a úpravu profilu). Vracia overený vstup alebo text chyby. */
export function readProfileForm(v: { name: string; height: string; weight: string; password?: string; password2?: string }, selfId?: string): ProfileInput | string {
  const heightCm = parseOptionalNumber(v.height), weightKg = parseOptionalNumber(v.weight);
  if (Number.isNaN(heightCm)) return 'Výška musí byť číslo v cm (alebo nechajte prázdne).';
  if (Number.isNaN(weightKg)) return 'Hmotnosť musí byť číslo v kg (alebo nechajte prázdne).';
  if (v.password !== undefined && v.password !== (v.password2 ?? '')) return 'Heslá sa nezhodujú.';
  const p: ProfileInput = { name: v.name, heightCm, weightKg, password: v.password };
  return validateProfile(p, selfId) ?? p;
}

export function ProfileFields({ v, set, withPassword }: {
  v: { name: string; height: string; weight: string; password: string; password2: string };
  set: (patch: Partial<{ name: string; height: string; weight: string; password: string; password2: string }>) => void;
  withPassword: 'new' | 'change';
}) {
  return (
    <div className="space-y-4 text-left">
      <label className="block">
        <span className="text-slate-700 font-medium">Meno a priezvisko alebo prezývka</span>
        <input className={input} value={v.name} onChange={(e) => set({ name: e.target.value })} autoFocus maxLength={40} />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-slate-700 font-medium">Výška (cm) <span className="text-slate-400 font-normal">– nepovinné</span></span>
          <input className={input} value={v.height} onChange={(e) => set({ height: e.target.value })} inputMode="decimal" placeholder="napr. 175" />
        </label>
        <label className="block">
          <span className="text-slate-700 font-medium">Hmotnosť (kg) <span className="text-slate-400 font-normal">– nepovinné</span></span>
          <input className={input} value={v.weight} onChange={(e) => set({ weight: e.target.value })} inputMode="decimal" placeholder="napr. 70" />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-slate-700 font-medium">{withPassword === 'new' ? 'Heslo' : 'Nové heslo'} <span className="text-slate-400 font-normal">– nepovinné</span></span>
          <input className={input} type="password" value={v.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
        </label>
        <label className="block">
          <span className="text-slate-700 font-medium">Heslo znova</span>
          <input className={input} type="password" value={v.password2} onChange={(e) => set({ password2: e.target.value })} autoComplete="new-password" />
        </label>
      </div>
      <p className="text-sm text-slate-500">
        Ak výšku alebo hmotnosť nepoznáte, nechajte pole prázdne. Bez hesla sa do profilu vstupuje jedným kliknutím.
      </p>
    </div>
  );
}

/** Text súhlasu so záznamom dát – rovnaký pri vstupe do relácie aj v profile. */
export function RecordConsentBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-start gap-4 p-5 rounded-2xl border-2 cursor-pointer text-left transition-colors ${checked ? 'border-green-400 bg-green-50' : 'border-slate-200 bg-slate-50'}`}>
      <input type="checkbox" className="mt-1 w-6 h-6 accent-green-600 flex-shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-lg font-semibold text-slate-800">Zaznamenávať moje dáta z rukavice počas kreslenia</span>
        <span className="block text-slate-600 mt-1">
          Uloží sa pohyb ruky (snímač polohy a stisk prstov), dráha kurzora a výsledky kreslenia. Dáta slúžia na analýzu
          a zlepšovanie ovládania. Ukladajú sa len v tomto počítači; v profile si ich môžete stiahnuť alebo vymazať
          a súhlas kedykoľvek zmeniť.
        </span>
      </span>
    </label>
  );
}

export function AuthScreen() {
  const { accounts, user, register, login, startSession, logout } = useAuth();
  const [mode, setMode] = useState<'list' | 'register'>(accounts.length ? 'list' : 'register');
  const [picked, setPicked] = useState<Account | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', height: '', weight: '', password: '', password2: '' });
  const [record, setRecord] = useState<boolean | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Niečo sa nepodarilo.'); } finally { setBusy(false); }
  };

  const pick = (a: Account) => {
    setError(null); setPassword('');
    if (a.pass) setPicked(a);
    else void run(async () => { await login(a.id, ''); });
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (!picked) return;
    void run(async () => { if (!(await login(picked.id, password))) throw new Error('Nesprávne heslo.'); setPicked(null); });
  };
  const submitRegister = (e: FormEvent) => {
    e.preventDefault();
    const p = readProfileForm(form);
    if (typeof p === 'string') { setError(p); return; }
    void run(() => register(p));
  };

  let body;
  if (user) {
    // prihlásený: voľba záznamu dát pre túto reláciu
    const rec = record ?? user.recordDefault;
    body = (
      <div className={card}>
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-green-100 w-12 h-12 rounded-xl flex items-center justify-center"><ShieldCheck className="w-6 h-6 text-green-600" /></div>
          <div className="text-left">
            <h2 className="text-2xl font-semibold text-slate-800">Vitajte, {user.name}</h2>
            <p className="text-slate-600">Pred začiatkom relácie si zvoľte, či sa majú ukladať dáta.</p>
          </div>
        </div>
        <RecordConsentBox checked={rec} onChange={setRecord} />
        {error && <p className="text-red-600 mt-4">{error}</p>}
        <div className="flex justify-between mt-6">
          <button className={secondary} onClick={() => { setRecord(null); logout(); }}>Iný používateľ</button>
          <button className={primary} disabled={busy} onClick={() => void run(() => startSession(rec))}>Začať reláciu</button>
        </div>
      </div>
    );
  } else if (picked) {
    body = (
      <form className={card} onSubmit={submitPassword}>
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-blue-100 w-12 h-12 rounded-xl flex items-center justify-center"><Lock className="w-6 h-6 text-blue-600" /></div>
          <div className="text-left">
            <h2 className="text-2xl font-semibold text-slate-800">{picked.name}</h2>
            <p className="text-slate-600">Zadajte heslo</p>
          </div>
        </div>
        <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
        {error && <p className="text-red-600 mt-3">{error}</p>}
        <div className="flex justify-between mt-6">
          <button type="button" className={secondary} onClick={() => { setPicked(null); setError(null); }}>Späť</button>
          <button type="submit" className={primary} disabled={busy}>Prihlásiť</button>
        </div>
      </form>
    );
  } else if (mode === 'register') {
    body = (
      <form className={card} onSubmit={submitRegister}>
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-blue-100 w-12 h-12 rounded-xl flex items-center justify-center"><UserPlus className="w-6 h-6 text-blue-600" /></div>
          <div className="text-left">
            <h2 className="text-2xl font-semibold text-slate-800">Nový účet</h2>
            <p className="text-slate-600">Stačí meno alebo prezývka, ostatné je nepovinné.</p>
          </div>
        </div>
        <ProfileFields v={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} withPassword="new" />
        {error && <p className="text-red-600 mt-4">{error}</p>}
        <div className="flex justify-between mt-6">
          {accounts.length ? <button type="button" className={secondary} onClick={() => { setMode('list'); setError(null); }}>Späť</button> : <span />}
          <button type="submit" className={primary} disabled={busy}>Vytvoriť účet</button>
        </div>
      </form>
    );
  } else {
    body = (
      <div className={card}>
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-blue-100 w-12 h-12 rounded-xl flex items-center justify-center"><UserRound className="w-6 h-6 text-blue-600" /></div>
          <div className="text-left">
            <h2 className="text-2xl font-semibold text-slate-800">Kto bude hrať?</h2>
            <p className="text-slate-600">Vyberte svoj profil alebo si vytvorte nový.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 max-h-[45vh] overflow-auto">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => pick(a)}
              disabled={busy}
              className="p-4 rounded-2xl border-2 border-slate-200 hover:border-blue-300 hover:shadow-md transition-all text-left flex items-center gap-3"
            >
              <span className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center flex-shrink-0">{a.name.slice(0, 1).toUpperCase()}</span>
              <span className="text-lg font-semibold text-slate-800 truncate">{a.name}</span>
              {a.pass && <Lock className="w-4 h-4 text-slate-400 ml-auto flex-shrink-0" />}
            </button>
          ))}
        </div>
        {error && <p className="text-red-600 mt-4">{error}</p>}
        <div className="flex justify-end mt-6">
          <button className={primary} onClick={() => { setMode('register'); setError(null); }}>+ Nový účet</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 p-4" style={{ fontFamily: '\'Poppins\', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial' }}>
      <h1 className="text-4xl font-bold text-slate-800 mb-8 text-center">Rehabilitačný systém hier</h1>
      {body}
    </div>
  );
}
