import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        index: 'index.html',
        scenes: 'scenes.html',
        viewer: 'viewer.html',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:43210',
      '/files': 'http://127.0.0.1:43210',
      '/thumbnails': 'http://127.0.0.1:43210',
    },
  },
});
