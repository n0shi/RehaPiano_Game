import React from 'react';
import type { AppConfig } from './config';

type ConfigContextValue = AppConfig | null;

const ConfigContext = React.createContext<ConfigContextValue>(null);

export const ConfigProvider: React.FC<{
  config: AppConfig;
  children: React.ReactNode;
}> = ({ config, children }) => {
  return (
    <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
  );
};

export function useConfig(): AppConfig {
  const ctx = React.useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used inside ConfigProvider');
  return ctx;
}

export default ConfigContext;
