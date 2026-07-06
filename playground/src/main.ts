import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);

// Render-effect / component tracking is a DEV-ONLY devtool (the panel itself is
// auto-injected by the plugin in dev). Registering it behind `import.meta.env.DEV`
// with a dynamic import means the plugin AND its runtime are tree-shaken out of the
// production build entirely — zero bundle cost, nothing runs, nothing renders. The
// import is awaited before mount so the render effect is tracked from the first render.
if (import.meta.env.DEV) {
  const { reactivityGraphPlugin } = await import('vite-plugin-vue-pulse/runtime');
  app.use(reactivityGraphPlugin);
}

app.mount('#app');
