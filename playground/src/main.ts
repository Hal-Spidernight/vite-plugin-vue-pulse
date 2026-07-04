import { createApp } from 'vue';
import App from './App.vue';
// Render-effect / component tracking. The panel is auto-injected by the plugin in
// dev; this one line adds the render effect so template-only state also glows.
// The virtual module is provided by vite-plugin-reactivity-graph during dev.
// @ts-ignore -- virtual module provided by the plugin
import { reactivityGraphPlugin } from 'virtual:reactivity-graph/runtime';

createApp(App).use(reactivityGraphPlugin).mount('#app');
