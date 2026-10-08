import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Match both supported native WebViews, not Android alone. Runtime APIs
  // (Object.hasOwn, Array.at and dialog) require iOS/Safari 15.4 or newer.
  build: { target: ['chrome105', 'safari15.4'], sourcemap: false },
  server: { host: '127.0.0.1', strictPort: true, port: 4176 },
  preview: { host: '127.0.0.1', strictPort: true, port: 4176 },
});
