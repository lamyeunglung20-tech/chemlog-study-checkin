import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'firebase-hosting',
  publicDir: '../public',
  plugins: [react()],
  build: {
    outDir: '../firebase-dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react-vendor';
          if (id.includes('@firebase/auth')) return 'firebase-auth';
          if (id.includes('@firebase/firestore')) return 'firebase-firestore';
          if (id.includes('@firebase/')) return 'firebase-core';
        },
      },
    },
  },
});
