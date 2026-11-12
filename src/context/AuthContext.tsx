import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  loadAccounts, createAccount, checkPassword, updateAccount, removeAccount, type Account, type ProfileInput,
} from '../utils/accounts';
import { deleteUserRecordings } from '../utils/recordingStore';

// Prihlásený používateľ a jeho voľba pre túto reláciu. Relácia platí pre otvorenú kartu prehliadača (sessionStorage):
// obnovenie stránky používateľa neodhlási, zatvorenie karty áno.
type Session = { userId: string; started: boolean; record: boolean };
const SESSION_KEY = 'rehapiano.session.v1';

type AuthContextType = {
  accounts: Account[];
  user: Account | null;
  /** používateľ je prihlásený a potvrdil voľbu záznamu dát -> možno hrať */
  sessionStarted: boolean;
  /** súhlas so záznamom dát z rukavice počas kreslenia v tejto relácii */
  recordConsent: boolean;
  register: (p: ProfileInput) => Promise<void>;
  login: (id: string, password: string) => Promise<boolean>;
  startSession: (record: boolean) => Promise<void>;
  setRecordConsent: (record: boolean) => Promise<void>;
  updateProfile: (patch: Partial<ProfileInput>) => Promise<void>;
  logout: () => void;
  deleteAccount: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

function readSession(): Session | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return s && typeof s.userId === 'string' ? { userId: s.userId, started: !!s.started, record: !!s.record } : null;
  } catch {
    return null;
  }
}
function writeSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* bez sessionStorage platí relácia len do obnovenia stránky */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>(() => loadAccounts());
  const [session, setSessionState] = useState<Session | null>(() => {
    const s = readSession();
    return s && loadAccounts().some((a) => a.id === s.userId) ? s : null;
  });
  const setSession = useCallback((s: Session | null) => { writeSession(s); setSessionState(s); }, []);
  const refresh = useCallback(() => setAccounts(loadAccounts()), []);

  const user = useMemo(() => accounts.find((a) => a.id === session?.userId) ?? null, [accounts, session]);

  const register = useCallback(async (p: ProfileInput) => {
    const acc = await createAccount(p);
    refresh();
    setSession({ userId: acc.id, started: false, record: false });
  }, [refresh, setSession]);

  const login = useCallback(async (id: string, password: string) => {
    const acc = loadAccounts().find((a) => a.id === id);
    if (!acc || !(await checkPassword(acc, password))) return false;
    setSession({ userId: acc.id, started: false, record: false });
    return true;
  }, [setSession]);

  const startSession = useCallback(async (record: boolean) => {
    if (!session) return;
    await updateAccount(session.userId, { recordDefault: record });
    refresh();
    setSession({ ...session, started: true, record });
  }, [session, refresh, setSession]);

  const setRecordConsent = useCallback(async (record: boolean) => {
    if (!session) return;
    await updateAccount(session.userId, { recordDefault: record });
    refresh();
    setSession({ ...session, record });
  }, [session, refresh, setSession]);

  const updateProfile = useCallback(async (patch: Partial<ProfileInput>) => {
    if (!session) return;
    await updateAccount(session.userId, patch);
    refresh();
  }, [session, refresh]);

  const logout = useCallback(() => setSession(null), [setSession]);

  const deleteAccount = useCallback(async () => {
    if (!session) return;
    try { await deleteUserRecordings(session.userId); } catch (e) { console.warn('Mazanie záznamov zlyhalo', e); }
    removeAccount(session.userId);
    refresh();
    setSession(null);
  }, [session, refresh, setSession]);

  const value: AuthContextType = {
    accounts, user,
    sessionStarted: !!user && !!session?.started,
    recordConsent: !!user && !!session?.started && !!session?.record,
    register, login, startSession, setRecordConsent, updateProfile, logout, deleteAccount,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
