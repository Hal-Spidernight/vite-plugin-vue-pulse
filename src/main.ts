import { createApp } from 'vue';
import App from './App.vue';

// The devtool panel is auto-injected by vite-plugin-reactivity-graph in dev.
// (If you prefer manual control, remove `autoInject` in vite.config and do:
//   import { mountPanel, loadStaticGraph } from './reactivity-graph';
//   import staticGraph from 'virtual:reactivity-graph/static';
//   loadStaticGraph(staticGraph); mountPanel();
// )

createApp(App).mount('#app');
