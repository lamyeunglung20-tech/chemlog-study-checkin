import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'firebase-hosting',
  publicDir: '../public',
  plugins: [react()],
  build: {
    outDir: '../firebase-dist',
    emptyOutDir: true,
  },
});
