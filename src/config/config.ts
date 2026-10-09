export type AppConfig = {
  GRID_WIDTH: number;
  GRID_HEIGHT: number;
  CELL_SIZE: number;
  MAX_PUZZLE_BLOCKS: number;
  COFFEE_BREAK: number;
  OUTLINE_COLORS?: string[];
  TENSOMETER_RAW_THRESHOLD?: number;
  TENSOMETER_NORM_THRESHOLD?: number;
  WEBSOCKET_URL?: string;
};

export const defaultConfig: AppConfig = {
  GRID_WIDTH: 20,
  GRID_HEIGHT: 20,
  CELL_SIZE: 45,
  MAX_PUZZLE_BLOCKS: 5,
  COFFEE_BREAK: 1000,
  OUTLINE_COLORS: [
    '#EF4444',
    '#3B82F6',
    '#10B981',
    '#F59E0B',
    '#8B5CF6',
    '#EC4899',
  ],
  TENSOMETER_RAW_THRESHOLD: 2000,
  TENSOMETER_NORM_THRESHOLD: 12,
  WEBSOCKET_URL: 'ws://127.0.0.1:5555/ws',
};

/**
 * Try to load a runtime config from `/configuration.json` (served from public/).
 * Falls back to the built-in defaults if fetch fails.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/configuration.json', { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('Config fetch failed, using defaults:', res.status);
      return defaultConfig;
    }
    const cfg = await res.json();
    return { ...defaultConfig, ...cfg } as AppConfig;
  } catch (err) {
    console.warn('Could not load configuration.json; using defaults.', err);
    return defaultConfig;
  }
}

export default defaultConfig;
