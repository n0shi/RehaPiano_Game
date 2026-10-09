import { useState, useEffect, ReactNode } from 'react';
import { Badge } from './ui/badge';
import { useConfig } from '../config/ConfigContext';
import { useCalibration } from '../context/CalibrationContext';
import { useModal } from '../context/ModalContext';

interface WebSocketStatusProps {
  renderCalibrationButton?: (connected: boolean) => ReactNode;
  hideCalibrationButton?: boolean;
  showCalibratedLabel?: boolean; // ak true a kalibrované, zobraziť zelený neklikateľný štítok; inak zobraziť tlačidlo Rekalibrovať v hre
}

export function WebSocketStatus({ renderCalibrationButton, hideCalibrationButton, showCalibratedLabel = true }: WebSocketStatusProps) {
  const [connected, setConnected] = useState(false);
  const { isCalibrated, resetCalibration, requestCalibration, showCalibrationModal } = useCalibration();
  const { isModalOpen } = useModal();
  // useConfig vracia objekt AppConfig priamo
  const cfg = useConfig();

  useEffect(() => {
    // Ak nie je poskytnuté URL, zostať odpojený
    if (!cfg.WEBSOCKET_URL) {
      setConnected(false);
      return;
    }

    // Použiť WebSocket prehliadača
    const ws = new WebSocket(cfg.WEBSOCKET_URL);

    ws.onopen = () => {
      console.log('Pripojený k streameru');
      setConnected(true);
      // Nastaviť globálny stav a odoslať event pre ostatné komponenty
      (window as any).__wsConnected = true;
      window.dispatchEvent(new CustomEvent('ws-connection-change', { detail: { connected: true } }));
    };

    ws.onmessage = (evt) => {
      try {
        const parsed =
          typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
        //console.log("Prijaté dáta:", parsed);
        // Ak ide o vzorku zo senzora, znovu ju vysielame ako window event tak,
        // aby hry/komponenty mohli počúvať IMU/tensometer aktualizácie bez priameho
        // vlastníctva socketu.
        try {
          // očakávaný tvar: { kind: 'sample', adc: [...], imu: { gyroX, gyroY, gyroZ }, ... }
          if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed.kind === 'sample' || parsed.adc)
          ) {
            const evtDetail = {
              adc: parsed.adc || [],
              imu: parsed.imu || { gyroX: 0, gyroY: 0, gyroZ: 0 },
            };
            window.dispatchEvent(
              new CustomEvent('imu-sample', { detail: evtDetail }),
            );
          }
        } catch (e) {
          // ignorovať chyby pri preposielaní
        }
      } catch (err) {
        console.warn('Nečitateľné WS dáta', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket chyba:', err);
      setConnected(false);
      (window as any).__wsConnected = false;
      window.dispatchEvent(new CustomEvent('ws-connection-change', { detail: { connected: false } }));
    };

    ws.onclose = () => {
      console.log('Odpojený od streameru');
      setConnected(false);
      (window as any).__wsConnected = false;
      window.dispatchEvent(new CustomEvent('ws-connection-change', { detail: { connected: false } }));
    };

    return () => {
      try {
        ws.close();
      } catch (e) {
        /* ignorovať */
      }
    };
  }, [cfg.WEBSOCKET_URL]);

  if (isModalOpen) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col items-end gap-2">
      {renderCalibrationButton && renderCalibrationButton(connected)}
      
      <div
        className="px-2.5 py-0.5 text-xs font-medium rounded-full transition-colors flex items-center justify-center gap-1.5 bg-black text-white"
        style={{ minWidth: 120, width: 120, height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}
        />
        {connected ? 'WS pripojený' : 'WS odpojený'}
      </div>
      
      {/* Tlačidlo kalibrácie - pod WS badge (skryté v menu ak je požadované) */}
      {connected && !hideCalibrationButton && (
        isCalibrated && showCalibratedLabel ? (
          <div
            className={'px-2.5 py-0.5 text-sm font-medium rounded-full transition-colors flex items-center justify-center gap-1.5 bg-green-100 text-green-800'}
            style={{ minWidth: 120, width: 120, height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
          >
            <div className={'w-2 h-2 rounded-full bg-green-500'} />
            Kalibrované
          </div>
        ) : (
          // Ak je kalibračný modal už otvorený, skryť tlačidlo Rekalibrovať
          !showCalibrationModal ? (
            <button
              onClick={() => requestCalibration()}
              className={'px-3 py-1 text-sm font-medium rounded-full transition-colors flex items-center gap-1.5 bg-blue-100 hover:bg-blue-200 text-blue-800'}
            >
              <div className={'w-2 h-2 rounded-full bg-blue-500'} />
              Rekalibrovať
            </button>
          ) : null
        )
      )}
    </div>
  );
}
