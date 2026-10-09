import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface ModalContextValue {
  enterModal: () => void;
  exitModal: () => void;
  isModalOpen: boolean;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const countRef = useRef(0);
  const [isOpen, setIsOpen] = useState(false);

  // Ensure any stale global flag is cleared immediately so children
  // that read `window.__modalOpen` during mount don't see a stuck state.
  try {
    (window as any).__modalOpen = false;
  } catch (e) {
    // ignore
  }

  const updateWindowFlag = (open: boolean) => {
    try {
      (window as any).__modalOpen = open;
    } catch (e) {
      // ignore
    }
  };

  const enterModal = useCallback(() => {
    countRef.current += 1;
    if (countRef.current === 1) {
      setIsOpen(true);
    }
  }, []);

  const exitModal = useCallback(() => {
    countRef.current = Math.max(0, countRef.current - 1);
    if (countRef.current === 0) {
      setIsOpen(false);
    }
  }, []);

  // When modal open state changes, update a window flag and add/remove global capture listeners
  useEffect(() => {
    // simply expose a global flag that other input handlers can check
    updateWindowFlag(isOpen);
    return () => updateWindowFlag(false);
  }, [isOpen]);

  // Ensure any stale global flag is cleared on mount
  useEffect(() => {
    updateWindowFlag(false);
    return () => updateWindowFlag(false);
    // run only once on mount/unmount
  }, []);

  return (
    <ModalContext.Provider value={{ enterModal, exitModal, isModalOpen: isOpen }}>
      {children}
    </ModalContext.Provider>
  );
}

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}
