import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

type Quat = { w: number; x: number; y: number; z: number };

type HandKey = 'left' | 'right';

type HandMode = 'single' | 'dual';

interface CalibrationState {
  neutralQuat: { left: Quat | null; right: Quat | null };
  showCalibrationModal: boolean;
  activeHand: HandKey;
  handMode: HandMode; // 'dual' = hra sa ovláda oboma rukami, kalibrujú sa obe
}

interface CalibrationContextType {
  // Shallow API for current active hand
  isCalibrated: boolean;
  neutralQuat: Quat | null;
  showCalibrationModal: boolean;
  handMode: HandMode;
  /** neutrálne kvaterniony oboch rúk (pre režim dvoch rúk) */
  neutralQuats: { left: Quat | null; right: Quat | null };
  /** ruka, ktorá sa práve kalibruje (v režime dvoch rúk najprv ľavá, potom pravá; null = hotovo) */
  calibratingHand: HandKey | null;
  startDualMode: () => void;

  // Actions (hand parameter optional, defaults to activeHand)
  calibrate: (quat: Quat, hand?: HandKey) => void;
  resetCalibration: (hand?: HandKey) => void;
  requestCalibration: (hand?: HandKey) => void;
  hideCalibrationModal: () => void;
  setActiveHand: (hand: HandKey) => void;
}

const STORAGE_KEY = 'rehapiano_imu_calibration';

const CalibrationContext = createContext<CalibrationContextType | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CalibrationState>(() => {
    // Try to load from localStorage on init
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          neutralQuat: {
            left: parsed?.neutralQuat?.left ?? null,
            right: parsed?.neutralQuat?.right ?? null,
          },
          showCalibrationModal: false,
          activeHand: 'left',
          handMode: 'single',
        };
      }
    } catch (e) {
      // Ignore localStorage errors
    }
    return {
      neutralQuat: { left: null, right: null },
      showCalibrationModal: false,
      activeHand: 'left',
      handMode: 'single',
    };
  });

  const save = (neutralQuat: { left: Quat | null; right: Quat | null }) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ neutralQuat }));
    } catch (e) {
      // ignore
    }
  };

  const calibrate = useCallback((quat: Quat, hand?: HandKey) => {
    setState((s) => {
      const dual = s.handMode === 'dual';
      const target: HandKey = hand ?? (dual ? (!s.neutralQuat.left ? 'left' : 'right') : s.activeHand);
      const nextNeutral = { ...s.neutralQuat, [target]: quat };
      // V režime dvoch rúk sa modal zatvorí až keď sú skalibrované obe ruky
      const allDone = dual ? !!(nextNeutral.left && nextNeutral.right) : true;
      const next = {
        ...s,
        neutralQuat: nextNeutral,
        showCalibrationModal: !allDone,
      } as CalibrationState;
      save(next.neutralQuat);
      return next;
    });
  }, []);

  const resetCalibration = useCallback((hand?: HandKey) => {
    setState((s) => {
      const target: HandKey = hand ?? s.activeHand;
      const nextNeutral = { ...s.neutralQuat, [target]: null };
      const next = {
        ...s,
        neutralQuat: nextNeutral,
        showCalibrationModal: true,
      } as CalibrationState;
      save(next.neutralQuat);
      return next;
    });
  }, []);

  const requestCalibration = useCallback((hand?: HandKey) => {
    setState((s) => {
      if (s.handMode === 'dual') {
        // Rekalibrácia oboch rúk, ak už sú obe hotové; inak len dokonči chýbajúcu
        const both = !!(s.neutralQuat.left && s.neutralQuat.right);
        const neutralQuat = both ? { left: null, right: null } : s.neutralQuat;
        if (both) save(neutralQuat);
        return { ...s, neutralQuat, showCalibrationModal: true };
      }
      return { ...s, showCalibrationModal: true, activeHand: hand ?? s.activeHand };
    });
  }, []);

  const hideCalibrationModal = useCallback(() => {
    setState((s) => ({ ...s, showCalibrationModal: false }));
  }, []);

  const setActiveHand = useCallback((hand: HandKey) => {
    setState((s) => {
      const nextNeutral = { ...s.neutralQuat, [hand]: null };
      const next = { ...s, activeHand: hand, handMode: 'single', neutralQuat: nextNeutral, showCalibrationModal: true } as CalibrationState;
      save(next.neutralQuat);
      return next;
    });
  }, []);

  // Režim dvoch rúk: vynuluj kalibráciu oboch rúk a spusti kalibráciu (najprv ľavá, potom pravá)
  const startDualMode = useCallback(() => {
    setState((s) => {
      const next = {
        ...s,
        handMode: 'dual',
        activeHand: 'right',
        neutralQuat: { left: null, right: null },
        showCalibrationModal: true,
      } as CalibrationState;
      save(next.neutralQuat);
      return next;
    });
  }, []);

  const dualMode = state.handMode === 'dual';
  const value: CalibrationContextType = {
    isCalibrated: dualMode
      ? !!(state.neutralQuat.left && state.neutralQuat.right)
      : !!state.neutralQuat[state.activeHand],
    neutralQuat: state.neutralQuat[state.activeHand],
    showCalibrationModal: state.showCalibrationModal,
    handMode: state.handMode,
    neutralQuats: state.neutralQuat,
    calibratingHand: dualMode
      ? (!state.neutralQuat.left ? 'left' : !state.neutralQuat.right ? 'right' : null)
      : state.activeHand,
    startDualMode,
    calibrate,
    resetCalibration,
    requestCalibration,
    hideCalibrationModal,
    setActiveHand,
  };

  return (
    <CalibrationContext.Provider value={value}>
      {children}
    </CalibrationContext.Provider>
  );
}

export function useCalibration() {
  const ctx = useContext(CalibrationContext);
  if (!ctx) {
    throw new Error('useCalibration must be used within CalibrationProvider');
  }
  return ctx;
}
