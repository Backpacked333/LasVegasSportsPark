/**
 * Staff dashboard build and development server (spec §4.1). In development the API is reached
 * through the `/v1` proxy, so the browser talks to one origin and the API needs no CORS setup.
 */
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const apiOrigin = process.env.SPORTSPARK_API_ORIGIN ?? 'http://localhost:3000';
const proxy = { '/v1': { target: apiOrigin, changeOrigin: false } };

// `--mode demo` builds the demo mode (src/demo): role picker, sample-data banner, guided tours.
// Every other mode is the real dashboard, and the demo code is dropped from its bundle.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // A literal at transform time, so a real build drops the demo imports before chunking.
    __DEMO__: JSON.stringify(mode === 'demo'),
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist', sourcemap: true },
}));
