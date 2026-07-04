import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
// Consumed by PACKAGE NAME — exactly how an installing project would (workspace-linked here).
import reactivityGraph from 'vite-plugin-vue-pulse';

export default defineConfig({
  plugins: [
    vue(),
    reactivityGraph({ include: ['src/**/*.vue'] }),
  ],
});
