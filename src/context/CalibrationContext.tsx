import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

type Quat = { w: number; x: number; y: number; z: number };

type HandKey = 'left' | 'right';

interface CalibrationState {
  neutralQuat: { left: Quat | null; right: Quat | null };
  showCalibrationModal: boolean;
  activeHand: HandKey;
}

interface CalibrationContextType {
  // Shallow API for current active hand
  isCalibrated: boolean;
  neutralQuat: Quat | null;
  showCalibrationModal: boolean;

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
        };
      }
    } catch (e) {
      // Ignore localStorage errors
    }
    return {
      neutralQuat: { left: null, right: null },
      showCalibrationModal: false,
      activeHand: 'left',
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
      const target: HandKey = hand ?? s.activeHand;
      const nextNeutral = { ...s.neutralQuat, [target]: quat };
      const next = {
        ...s,
        neutralQuat: nextNeutral,
        showCalibrationModal: false,
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
    setState((s) => ({ ...s, showCalibrationModal: true, activeHand: hand ?? s.activeHand }));
  }, []);

  const hideCalibrationModal = useCallback(() => {
    setState((s) => ({ ...s, showCalibrationModal: false }));
  }, []);

  const setActiveHand = useCallback((hand: HandKey) => {
    setState((s) => {
      const nextNeutral = { ...s.neutralQuat, [hand]: null };
      const next = { ...s, activeHand: hand, neutralQuat: nextNeutral, showCalibrationModal: true } as CalibrationState;
      save(next.neutralQuat);
      return next;
    });
  }, []);

  const value: CalibrationContextType = {
    isCalibrated: !!state.neutralQuat[state.activeHand],
    neutralQuat: state.neutralQuat[state.activeHand],
    showCalibrationModal: state.showCalibrationModal,
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
