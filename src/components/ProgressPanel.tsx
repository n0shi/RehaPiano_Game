import { useMemo, useState } from 'react';
import { loadResults, summarize, type DayPoint, type GameResult } from '../utils/results';

// Pokrok používateľa v profile: najlepšie výsledky a malé grafy priemeru po dňoch (kreslenie: skóre, Pentomino: čas úrovne).

const SHAPE_LABEL: Record<string, string> = { circle: 'Kruh', triangle: 'Trojuholník', square: 'Štvorec', rhombus: 'Kosoštvorec' };
const LINE = '#2563eb';
const fmtDay = (t: number) => new Date(t).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' });
const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

/** Malý čiarový graf jednej veličiny po dňoch. Os y začína v nule; bod pod kurzorom sa popíše pod grafom. */
function Sparkline({ points, max, format, label }: { points: DayPoint[]; max: number; format: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 260, H = 64, PX = 8, PY = 8;
  const n = points.length;
  const x = (i: number) => (n === 1 ? W / 2 : PX + (i * (W - 2 * PX)) / (n - 1));
  const y = (v: number) => H - PY - (Math.max(0, Math.min(max, v)) / max) * (H - 2 * PY);
  const shown = hover ?? n - 1;
  const p = points[shown];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label}: ${points.map((q) => `${fmtDay(q.day)} ${format(q.value)}`).join(', ')}`} onMouseLeave={() => setHover(null)}>
        <line x1={PX} x2={W - PX} y1={H - PY} y2={H - PY} stroke="#e2e8f0" strokeWidth={1} />
        {n > 1 && <polyline fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={points.map((q, i) => `${x(i)},${y(q.value)}`).join(' ')} />}
        <circle cx={x(shown)} cy={y(p.value)} r={4.5} fill={LINE} stroke="#fff" strokeWidth={2} />
        {/* široké neviditeľné pásy: bod sa dá trafiť bez mierenia na čiaru */}
        {points.map((_, i) => {
          const w = n === 1 ? W : (W - 2 * PX) / (n - 1);
          return <rect key={i} x={x(i) - w / 2} y={0} width={w} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />;
        })}
      </svg>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{fmtDay(points[0].day)}</span>
        <span className="text-slate-700 font-medium">{fmtDay(p.day)}: {format(p.value)} <span className="text-slate-500 font-normal">({p.n}×)</span></span>
        <span>{fmtDay(points[n - 1].day)}</span>
      </div>
    </div>
  );
}

function Trend({ change, format, betterWhenLower, count }: { change: number | null; format: (abs: number) => string; betterWhenLower?: boolean; count: number }) {
  if (change === null) return <p className="text-sm text-slate-500">Trend sa ukáže po 10 pokusoch (zatiaľ {count}).</p>;
  const better = betterWhenLower ? change < 0 : change > 0;
  const flat = Math.abs(change) < 1e-9;
  return (
    <p className="text-sm text-slate-700">
      <span className="font-semibold">{flat ? '→ bez zmeny' : `${better ? '▲ lepšie' : '▼ horšie'} o ${format(Math.abs(change))}`}</span>
      <span className="text-slate-500"> – posledných 5 pokusov oproti 5 predchádzajúcim</span>
    </p>
  );
}

/** Vymyslené výsledky za posledných 14 dní – len na ukážku, ako pokrok vyzerá. Nikam sa neukladajú. */
function demoResults(): GameResult[] {
  const day = 86400000, start = Date.now() - 13 * day, out: GameResult[] = [];
  const score = [34, 41, 38, 47, 52, 49, 58, 61, 57, 66, 70, 68, 75, 79];
  const time = [245, 230, 238, 205, 190, 198, 172, 160, 166, 148, 139, 142, 128, 121];
  for (let d = 0; d < 14; d++) {
    if (d === 5 || d === 9) continue; // dni bez tréningu
    ['circle', 'square', 'triangle', 'rhombus'].forEach((shape, k) => {
      out.push({ t: start + d * day + k * 90000, kind: 'drawing', shape, level: 1, score: Math.min(100, score[d] + [4, 0, -5, -8][k]), accuracy: 0.7, coverage: 0.9 });
    });
    for (let l = 1; l <= 3; l++) out.push({ t: start + d * day + 600000 + l * 200000, kind: 'pentomino', level: l, seconds: Math.round(time[d] * (0.6 + 0.3 * l)) });
  }
  return out;
}

export function ProgressPanel() {
  const [demo, setDemo] = useState(false);
  const p = useMemo(() => summarize(demo ? demoResults() : loadResults()), [demo]);
  const card = 'rounded-2xl border border-slate-200 p-4';
  const toggle = (
    <button className="text-sm text-blue-600 underline" onClick={() => setDemo((v) => !v)}>
      {demo ? 'Späť na moje výsledky' : 'Zobraziť ukážku s vymyslenými dátami'}
    </button>
  );
  if (!p.drawing.count && !p.pentomino.count) {
    return (
      <div>
        <p className="text-slate-600">Zatiaľ žiadne výsledky. Po prvom kreslení alebo dokončenej úrovni Pentomina sa tu ukáže váš pokrok.</p>
        {toggle}
      </div>
    );
  }
  return (
    <div>
    {demo && <p className="mb-3 px-4 py-2 rounded-xl bg-amber-50 text-amber-800 text-sm font-medium">Ukážka: vymyslené dáta, nie vaše výsledky. Nič sa neukladá.</p>}
    <div className="grid md:grid-cols-2 gap-4">
      {p.drawing.count > 0 && (
        <div className={card}>
          <div className="flex items-baseline justify-between mb-1">
            <h4 className="font-semibold text-slate-800">Kreslenie – skóre po dňoch</h4>
            <span className="text-sm text-slate-500 whitespace-nowrap ml-2">{p.drawing.count} pokusov</span>
          </div>
          <Sparkline points={p.drawing.days} max={100} format={(v) => `${Math.round(v)} bodov`} label="Priemerné skóre kreslenia po dňoch" />
          <div className="mt-3"><Trend change={p.drawing.change} format={(a) => `${Math.round(a)} bodov`} count={p.drawing.count} /></div>
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-slate-500 text-left"><th className="font-normal">Tvar</th><th className="font-normal text-right">Najlepšie skóre</th><th className="font-normal text-right">Pokusov</th></tr></thead>
            <tbody>
              {p.drawing.bestByShape.map((s) => (
                <tr key={s.shape} className="text-slate-800"><td>{SHAPE_LABEL[s.shape] ?? s.shape}</td><td className="text-right font-semibold">{s.best} / 100</td><td className="text-right text-slate-500">{s.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.pentomino.count > 0 && (
        <div className={card}>
          <div className="flex items-baseline justify-between mb-1">
            <h4 className="font-semibold text-slate-800">Pentomino – čas úrovne po dňoch</h4>
            <span className="text-sm text-slate-500 whitespace-nowrap ml-2">{p.pentomino.count} úrovní</span>
          </div>
          <Sparkline points={p.pentomino.days} max={Math.max(1, ...p.pentomino.days.map((d) => d.value)) * 1.1} format={fmtTime} label="Priemerný čas úrovne Pentomina po dňoch" />
          <div className="mt-3"><Trend change={p.pentomino.change} betterWhenLower format={(a) => `${Math.round(a * 100)} % času`} count={p.pentomino.count} /></div>
          <table className="w-full text-sm mt-3">
            <thead><tr className="text-slate-500 text-left"><th className="font-normal">Úroveň</th><th className="font-normal text-right">Najlepší čas</th><th className="font-normal text-right">Dokončená</th></tr></thead>
            <tbody>
              {p.pentomino.bestByLevel.map((l) => (
                <tr key={l.level} className="text-slate-800"><td>{l.level}</td><td className="text-right font-semibold">{fmtTime(l.best)}</td><td className="text-right text-slate-500">{l.count}×</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    <div className="mt-2">{toggle}</div>
    </div>
  );
}
