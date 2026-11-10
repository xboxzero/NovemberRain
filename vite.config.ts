import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/NovemberRain/ and anywhere else.
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
});
