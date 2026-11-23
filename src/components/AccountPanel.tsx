import { useEffect, useState, type FormEvent } from 'react';
import { UserRound, X, Download, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useModal } from '../context/ModalContext';
import { ProfileFields, RecordConsentBox, readProfileForm } from './AuthScreen';
import { listRecordings, deleteRecording, deleteUserRecordings, type RecordingHeader } from '../utils/recordingStore';
import { buildExport, downloadJson, MAX_USER_SAMPLES } from '../utils/sessionRecorder';
import { ProgressPanel } from './ProgressPanel';

// Štítok prihláseného používateľa (v menu) a okno profilu: úprava údajov, súhlas so záznamom, uložené záznamy (stiahnuť / vymazať).

const btn = 'px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors';
const fmtDate = (t: number) => new Date(t).toLocaleString('sk-SK', { dateStyle: 'medium', timeStyle: 'short' });
const fileStamp = (t: number) => new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-');

function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, recordConsent, setRecordConsent, updateProfile, deleteAccount } = useAuth();
  const { enterModal, exitModal } = useModal();
  const [form, setForm] = useState({
    name: user?.name ?? '', height: user?.heightCm?.toString() ?? '', weight: user?.weightKg?.toString() ?? '', password: '', password2: '',
  });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [recs, setRecs] = useState<RecordingHeader[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // okno je modal: kurzor rukavice v menu počas neho neklikne na tlačidlá (napr. "Vymazať účet")
  useEffect(() => { enterModal(); return () => exitModal(); }, [enterModal, exitModal]);

  const reload = () => {
    if (!user) return;
    listRecordings(user.id).then(setRecs).catch(() => setRecs([]));
  };
  useEffect(reload, [user?.id]);

  if (!user) return null;

  const save = (e: FormEvent) => {
    e.preventDefault();
    const p = readProfileForm({ ...form, password: form.password || undefined }, user.id);
    if (typeof p === 'string') { setNote({ ok: false, text: p }); return; }
    updateProfile(p)
      .then(() => { setNote({ ok: true, text: 'Uložené.' }); setForm((f) => ({ ...f, password: '', password2: '' })); })
      .catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : 'Uloženie zlyhalo.' }));
  };
  const exportOne = async (r: RecordingHeader) => downloadJson(`rehapiano_${user.name.replace(/\W+/g, '_')}_${fileStamp(r.startedAt)}.json`, await buildExport(r, user));
  const exportAll = async () => {
    const all = [];
    for (const r of recs ?? []) all.push(await buildExport(r, user));
    downloadJson(`rehapiano_${user.name.replace(/\W+/g, '_')}_vsetko_${fileStamp(Date.now())}.json`, { format: 'rehapiano-drawing-set-v1', recordings: all });
  };
  const totalSamples = (recs ?? []).reduce((a, r) => a + r.sampleCount, 0);

  return (
    <div className="fixed inset-0 z-[9500] flex items-center justify-center bg-black/50 p-4" style={{ backdropFilter: 'blur(6px)' }}>
      <div className="relative bg-white rounded-3xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-auto p-8">
        <button aria-label="Zavrieť" onClick={onClose} className="absolute top-4 right-4 w-10 h-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100">
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-2xl font-semibold text-slate-800 mb-6">Môj profil</h2>

        <form onSubmit={save}>
          <ProfileFields v={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} withPassword="change" />
          <div className="flex items-center gap-4 mt-4">
            <button type="submit" className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold">Uložiť údaje</button>
            {note && <span className={note.ok ? 'text-green-700' : 'text-red-600'}>{note.text}</span>}
          </div>
        </form>

        <h3 className="text-xl font-semibold text-slate-800 mt-8 mb-3">Môj pokrok</h3>
        <ProgressPanel />

        <h3 className="text-xl font-semibold text-slate-800 mt-8 mb-3">Záznam dát</h3>
        <RecordConsentBox checked={recordConsent} onChange={(v) => void setRecordConsent(v)} />

        <div className="flex items-center justify-between mt-6 mb-2 gap-3 flex-wrap">
          <p className="text-slate-600">
            {recs === null ? 'Načítavam záznamy…' : recs.length ? `Uložené záznamy: ${recs.length} (${totalSamples.toLocaleString('sk-SK')} vzoriek)` : 'Zatiaľ nie sú uložené žiadne záznamy.'}
          </p>
          {!!recs?.length && (
            <div className="flex gap-2">
              <button className={btn} onClick={() => void exportAll()}><Download className="inline w-4 h-4 mr-1" />Stiahnuť všetko</button>
              <button className={btn} onClick={() => { if (window.confirm('Naozaj vymazať všetky záznamy?')) void deleteUserRecordings(user.id).then(reload); }}>
                <Trash2 className="inline w-4 h-4 mr-1" />Vymazať všetko
              </button>
            </div>
          )}
        </div>
        {totalSamples >= MAX_USER_SAMPLES && (
          <p className="text-amber-700 bg-amber-50 rounded-xl px-4 py-2 mb-2">Úložisko záznamov je plné – nové sa neukladajú. Stiahnite si záznamy a vymažte ich.</p>
        )}
        {!!recs?.length && (
          <ul className="divide-y divide-slate-200 border border-slate-200 rounded-2xl max-h-56 overflow-auto">
            {recs.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="text-slate-700">
                  {fmtDate(r.startedAt)}
                  <span className="text-slate-500 text-sm"> · {r.kind === 'pentomino' ? 'Pentomino' : 'kreslenie'} · {r.endedAt ? `${Math.round((r.endedAt - r.startedAt) / 1000)} s` : 'neukončené'}</span>
                </span>
                <span className="flex gap-1">
                  <button title="Stiahnuť" className="p-2 rounded-lg hover:bg-slate-100 text-slate-600" onClick={() => void exportOne(r)}><Download className="w-4 h-4" /></button>
                  <button title="Vymazať" className="p-2 rounded-lg hover:bg-red-50 text-red-600" onClick={() => { if (r.id !== undefined) void deleteRecording(r.id).then(reload); }}><Trash2 className="w-4 h-4" /></button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 pt-6 border-t border-slate-200">
          {!confirmDelete ? (
            <button className="text-red-600 underline" onClick={() => setConfirmDelete(true)}>Vymazať účet</button>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-red-700 font-medium">Vymaže sa účet aj všetky jeho záznamy. Nedá sa to vrátiť.</span>
              <button className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold" onClick={() => void deleteAccount()}>Áno, vymazať</button>
              <button className={btn} onClick={() => setConfirmDelete(false)}>Zrušiť</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Štítok v ľavom hornom rohu menu: meno, stav záznamu, profil, odhlásenie. */
export function AccountBadge() {
  const { user, recordConsent, logout } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <>
      <div data-no-glove className="fixed top-4 left-4 z-40 flex items-center gap-2 bg-white/90 rounded-2xl shadow-md pl-3 pr-2 py-2">
        <UserRound className="w-5 h-5 text-blue-600" />
        <span className="font-semibold text-slate-800 max-w-[14rem] truncate">{user.name}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${recordConsent ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'}`}>
          {recordConsent ? 'záznam zapnutý' : 'bez záznamu'}
        </span>
        <button className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium" onClick={() => setOpen(true)}>Profil</button>
        <button className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium" onClick={logout}>Odhlásiť</button>
      </div>
      {open && <ProfileModal onClose={() => setOpen(false)} />}
    </>
  );
}
