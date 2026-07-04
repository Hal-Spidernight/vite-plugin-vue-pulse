import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import reactivityGraph from './vite-plugin-reactivity-graph.mjs';

export default defineConfig({
  plugins: [
    vue(),
    reactivityGraph({ include: ['src/**/*.vue'], autoInject: true }),
  ],
});
