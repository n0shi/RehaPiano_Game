import { useEffect, useState, useCallback } from 'react';
import { InputMapper } from './imu/InputMapper';

interface SettingsMenuProps {
  inputMapper: InputMapper;
  onClose: () => void;
  visible: boolean;
}

interface Field {
  humanLabel: string;
  techLabel: string;
  get: () => number | string | boolean;
  set: (val: number | string | boolean) => void;
  step?: number;
  fmt?: (val: any) => string;
  type?: 'number' | 'boolean' | 'select';
  options?: string[];
}

export function SettingsMenu({ inputMapper, onClose, visible }: SettingsMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [lastSaved, setLastSaved] = useState(0);
  const [, forceUpdate] = useState(0);

  const getFields = useCallback((): Field[] => {
    const sp = inputMapper.spacePtr;
    return [
      // ANTI-SHAKE / AUTO-ZUPT
      {
        humanLabel: 'Prah otrasov',
        techLabel: 'pos-shake-acc-th [g]',
        get: () => sp.shakeAccThreshold,
        set: (v) => { sp.shakeAccThreshold = Number(v); },
        step: 0.2,
        fmt: (v) => v.toFixed(1)
      },
      {
        humanLabel: 'Trvanie otrasu',
        techLabel: 'pos-shake-hold [s]',
        get: () => sp.shakeHold,
        set: (v) => { sp.shakeHold = Number(v); },
        step: 0.02,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Prah pokoja',
        techLabel: 'pos-quiet-a [g]',
        get: () => sp.quietA,
        set: (v) => { sp.quietA = Number(v); },
        step: 0.005,
        fmt: (v) => v.toFixed(3)
      },
      {
        humanLabel: 'Čas pokoja',
        techLabel: 'pos-zupt-time [s]',
        get: () => sp.zuptTime,
        set: (v) => { sp.zuptTime = Number(v); },
        step: 0.02,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Návrat do stredu',
        techLabel: 'pos-spring [1/s]',
        get: () => sp.pSpring,
        set: (v) => { sp.pSpring = Number(v); },
        step: 0.05,
        fmt: (v) => v.toFixed(2)
      },
      // SPACE POINTER CORE
      {
        humanLabel: 'Povoliť pohyb',
        techLabel: 'pos-enable',
        get: () => sp.enabled,
        set: (v) => { sp.enabled = Boolean(v); },
        type: 'boolean'
      },
      {
        humanLabel: 'Zdroj dát',
        techLabel: 'pos-source',
        get: () => sp.source,
        set: (v) => { sp.source = v as any; },
        type: 'select',
        options: ['linacc', 'accminusgrav', 'gravdelta']
      },
      {
        humanLabel: 'Škála zrýchlenia',
        techLabel: 'pos-linacc-scale',
        get: () => sp.linaccScale,
        set: (v) => { sp.linaccScale = Number(v); },
        step: 0.01,
        fmt: (v) => v.toFixed(5)
      },
      {
        humanLabel: 'Vyhladzovanie (EMA)',
        techLabel: 'pos-ema',
        get: () => sp.alpha,
        set: (v) => { sp.alpha = Number(v); },
        step: 0.02,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Mŕtva zóna',
        techLabel: 'pos-deadzone-a',
        get: () => sp.deadzone,
        set: (v) => { sp.deadzone = Number(v); },
        step: 0.005,
        fmt: (v) => v.toFixed(3)
      },
      {
        humanLabel: 'Útlm rýchlosti',
        techLabel: 'pos-leak',
        get: () => sp.leak,
        set: (v) => { sp.leak = Number(v); },
        step: 0.02,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Limit zrýchlenia',
        techLabel: 'pos-sat-acc',
        get: () => sp.satAcc,
        set: (v) => { sp.satAcc = Number(v); },
        step: 0.5,
        fmt: (v) => v.toFixed(1)
      },
      {
        humanLabel: 'Limit rýchlosti',
        techLabel: 'pos-sat-vel',
        get: () => sp.satVel,
        set: (v) => { sp.satVel = Number(v); },
        step: 0.2,
        fmt: (v) => v.toFixed(1)
      },
      {
        humanLabel: 'Citlivosť X',
        techLabel: 'pos-scale-x',
        get: () => sp.scaleX,
        set: (v) => { sp.scaleX = Number(v); },
        step: 0.05,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Citlivosť Y',
        techLabel: 'pos-scale-y',
        get: () => sp.scaleY,
        set: (v) => { sp.scaleY = Number(v); },
        step: 0.05,
        fmt: (v) => v.toFixed(2)
      },
      {
        humanLabel: 'Hysteréza',
        techLabel: 'pos-hyst',
        get: () => sp.hysteresis,
        set: (v) => { sp.hysteresis = Number(v); },
        step: 0.05,
        fmt: (v) => v.toFixed(2)
      },
      // DROP SETTINGS
      {
        humanLabel: '─── DROP ───',
        techLabel: '',
        get: () => '',
        set: () => { },
        fmt: () => ''
      },
      {
        humanLabel: '📊 Aktuálny Pitch',
        techLabel: 'live-pitch',
        get: () => {
          const dropCtrl = inputMapper.dropCtrl as any;
          return dropCtrl?.pitchEma ?? 0;
        },
        set: () => { },
        step: 0,
        fmt: (v) => typeof v === 'number' ? v.toFixed(1) : '0.0'
      },
      {
        humanLabel: '⚠️ Status',
        techLabel: 'drop-status',
        get: () => {
          const dropCtrl = inputMapper.dropCtrl as any;
          return dropCtrl?.armed ? 'ARMED' : 'IDLE';
        },
        set: () => { },
        step: 0,
        fmt: (v) => String(v)
      },
      {
        humanLabel: 'Arm Prah (Hore)',
        techLabel: 'drop-arm',
        get: () => (inputMapper.dropCtrl as any).armThreshold,
        set: (v) => { (inputMapper.dropCtrl as any).armThreshold = Number(v); },
        step: 1,
        fmt: (v) => v.toFixed(0)
      },
      {
        humanLabel: 'Soft Drop prah',
        techLabel: 'drop-soft',
        get: () => (inputMapper.dropCtrl as any).softThreshold,
        set: (v) => { (inputMapper.dropCtrl as any).softThreshold = Number(v); },
        step: 1,
        fmt: (v) => v.toFixed(0)
      },
      {
        humanLabel: 'Hard Drop prah',
        techLabel: 'drop-hard',
        get: () => (inputMapper.dropCtrl as any).hardThreshold,
        set: (v) => { (inputMapper.dropCtrl as any).hardThreshold = Number(v); },
        step: 1,
        fmt: (v) => v.toFixed(0)
      },
      {
        humanLabel: 'Hold Time',
        techLabel: 'drop-hold [s]',
        get: () => (inputMapper.dropCtrl as any).holdTime,
        set: (v) => { (inputMapper.dropCtrl as any).holdTime = Number(v); },
        step: 0.01,
        fmt: (v) => v.toFixed(2)
      },
    ];
  }, [inputMapper]);

  const fields = getFields();

  // Live update for pitch display
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => forceUpdate(n => n + 1), 100);
    return () => clearInterval(interval);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((window as any).__modalOpen) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }

      const field = fields[selectedIndex];

      if (editing) {
        if (e.key === 'Enter') {
          const val = parseFloat(editBuffer);
          if (!isNaN(val)) {
            field.set(val);
            setLastSaved(Date.now());
            forceUpdate(n => n + 1);
          }
          setEditing(false);
          setEditBuffer('');
        } else if (e.key === 'Escape') {
          setEditing(false);
          setEditBuffer('');
        } else if (e.key === 'Backspace') {
          setEditBuffer(prev => prev.slice(0, -1));
        } else if (e.key.length === 1 && /[0-9.-]/.test(e.key)) {
          setEditBuffer(prev => prev + e.key);
        }
      } else {
        if (e.key === 'ArrowUp') {
          setSelectedIndex(prev => (prev - 1 + fields.length) % fields.length);
        } else if (e.key === 'ArrowDown') {
          setSelectedIndex(prev => (prev + 1) % fields.length);
        } else if (e.key === 'ArrowRight' || e.key === '+') {
          if (field.type === 'boolean') {
            field.set(!field.get());
          } else if (field.type === 'select' && field.options) {
            const current = field.get() as string;
            const idx = field.options.indexOf(current);
            const next = field.options[(idx + 1) % field.options.length];
            field.set(next);
          } else {
            const val = Number(field.get());
            field.set(val + (field.step || 1));
          }
          setLastSaved(Date.now());
          forceUpdate(n => n + 1);
        } else if (e.key === 'ArrowLeft' || e.key === '-') {
          if (field.type === 'boolean') {
            field.set(!field.get());
          } else if (field.type === 'select' && field.options) {
            const current = field.get() as string;
            const idx = field.options.indexOf(current);
            const prev = field.options[(idx - 1 + field.options.length) % field.options.length];
            field.set(prev);
          } else {
            const val = Number(field.get());
            field.set(val - (field.step || 1));
          }
          setLastSaved(Date.now());
          forceUpdate(n => n + 1);
        } else if (e.key === 'Enter') {
          if (field.type !== 'boolean' && field.type !== 'select') {
            setEditing(true);
            setEditBuffer(String(field.get()));
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, selectedIndex, editing, editBuffer, fields]);

  if (!visible) return null;

  return (
    <div className="absolute top-4 right-4 w-[500px] bg-slate-900/95 text-white p-6 rounded-xl shadow-2xl font-sans text-sm z-50 border border-slate-700 backdrop-blur-sm">
      <div className="flex justify-between items-center mb-6 border-b border-slate-700 pb-4">
        <h3 className="text-white text-lg font-semibold tracking-wide">Nastavenia citlivosti</h3>
        <div className="flex items-center gap-4">
          <span className="text-xs text-slate-400 font-mono">F1</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="space-y-1 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
        {fields.map((field, i) => {
          const isSelected = i === selectedIndex;
          const val = field.get();
          const valStr = field.fmt ? field.fmt(val) : String(val);

          return (
            <div
              key={i}
              className={`flex justify-between items-center px-3 py-2 rounded-lg transition-colors ${isSelected ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800/50 border border-transparent'}`}
            >
              <div className="flex items-baseline gap-2 overflow-hidden">
                <span className={`font-medium ${isSelected ? 'text-blue-200' : 'text-slate-300'}`}>{field.humanLabel}</span>
                <span className="text-xs text-slate-600 font-mono truncate opacity-40">{field.techLabel}</span>
              </div>
              <span className={`font-mono ml-4 ${editing && isSelected ? 'text-yellow-400 font-bold' : isSelected ? 'text-white' : 'text-slate-400'}`}>
                {editing && isSelected ? `[${editBuffer}]` : valStr}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-6 pt-4 border-t border-slate-700 flex justify-between items-center text-xs text-slate-500">
        <div className="flex gap-4">
          <span>↑/↓ výber</span>
          <span>←/→ zmena</span>
          <span>Enter úprava</span>
        </div>
        {Date.now() - lastSaved < 1500 && (
          <span className="text-green-400 font-bold flex items-center gap-1 animate-fade-in">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
            Uložené
          </span>
        )}
      </div>
    </div>
  );
}
