// Testy logiky (bez prehliadača a bez rukavice): npm test
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Jedno vlákno: testy bežia spolu pod sekundu; predvolené spúšťanie každého súboru vo vlastnom procese tu trvalo minúty
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
