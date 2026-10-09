import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { loadConfig } from './config/config';
import { ConfigProvider } from './config/ConfigContext';
import { CalibrationProvider } from './context/CalibrationContext';
import { ModalProvider } from './context/ModalContext';

async function bootstrap() {
  const cfg = await loadConfig();
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <ConfigProvider config={cfg}>
        <CalibrationProvider>
          <ModalProvider>
            <App />
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
  root.render(
    <React.StrictMode>
      <CalibrationProvider>
        <App />
      </CalibrationProvider>
    </React.StrictMode>,
  );
});
