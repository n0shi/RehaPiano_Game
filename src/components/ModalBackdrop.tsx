import { useEffect } from 'react';
import { useModal } from '../context/ModalContext';

export function ModalBackdrop({ children }: { children: React.ReactNode }) {
  const { enterModal, exitModal } = useModal();

  useEffect(() => {
    enterModal();
    return () => exitModal();
  }, [enterModal, exitModal]);

  return <>{children}</>;
}
