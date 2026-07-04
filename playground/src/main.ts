import { createApp } from 'vue';
import App from './App.vue';
// Render-effect / component tracking. The panel is auto-injected by the plugin in
// dev; this one line adds the render effect so template-only state also glows.
// Imported from the package's `/runtime` subpath — exactly like a real consumer.
import { reactivityGraphPlugin } from 'vite-plugin-vue-pulse/runtime';

createApp(App).use(reactivityGraphPlugin).mount('#app');
