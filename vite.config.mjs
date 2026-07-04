import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import reactivityGraph from './src/vite-plugin.ts';

export default defineConfig({
  plugins: [
    vue(),
    // vue() first, then the graph plugin (enforce:'post' also guarantees ordering)
    reactivityGraph({ include: ['src/**/*.vue'], autoInject: true }),
  ],
});
