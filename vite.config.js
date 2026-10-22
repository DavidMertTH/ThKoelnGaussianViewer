import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 4000,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:43210',
      '/files': 'http://127.0.0.1:43210',
    },
  },
});
