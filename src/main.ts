import { createApp } from 'vue';
import App from './App.vue';
// Component/render-effect tracking. The panel itself is auto-injected by
// vite-plugin-reactivity-graph in dev; this one line adds the render effect so
// template-only state also lights up. Resolved by the plugin's virtual module.
// @ts-ignore -- virtual module provided by vite-plugin-reactivity-graph in dev
import { reactivityGraphPlugin } from 'virtual:reactivity-graph/runtime';

const app = createApp(App);
app.use(reactivityGraphPlugin);
app.mount('#app');
