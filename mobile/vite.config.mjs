import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'chrome105', sourcemap: false },
  server: { host: '127.0.0.1', strictPort: true, port: 4176 },
  preview: { host: '127.0.0.1', strictPort: true, port: 4176 },
});
