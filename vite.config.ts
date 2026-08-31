import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH lets one build serve from a GitHub Pages project subpath
// ("/GeoDataProject/") or from a bare custom domain ("/") unchanged.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
});
