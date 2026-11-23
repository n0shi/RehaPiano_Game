import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { loadConfig, defaultConfig } from './config/config';
import { ConfigProvider } from './config/ConfigContext';
import { CalibrationProvider } from './context/CalibrationContext';
import { ModalProvider } from './context/ModalContext';
import { AuthProvider } from './context/AuthContext';

async function bootstrap() {
  const cfg = await loadConfig();
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <ConfigProvider config={cfg}>
        <CalibrationProvider>
          <ModalProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ModalProvider>
        </CalibrationProvider>
      </ConfigProvider>
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  // Ak načítanie konfigurácie zlyhá neočakávane, prepneme na záložné zobrazenie s prednastaveniami.
  // Funkcia loadConfig už vracia predvolené hodnoty pri chybe, toto je ďalšia ochrana.
  console.error('Bootstrap zlyhal, pokus o fallback render', err);
  const root = createRoot(document.getElementById('root')!);
  // Aj tu musí byť ConfigProvider: useConfig() bez neho vyhodí chybu a záložné zobrazenie by spadlo tiež
  root.render(
    <React.StrictMode>
      <ConfigProvider config={defaultConfig}>
        <CalibrationProvider>
          <ModalProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ModalProvider>
        </CalibrationProvider>
      </ConfigProvider>
    </React.StrictMode>,
  );
});
