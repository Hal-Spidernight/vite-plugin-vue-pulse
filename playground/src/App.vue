<script setup>
// PLAIN Vue — no traced wrappers. The Vite plugin rewrites ref/reactive/computed/
// watch/watchEffect into their traced equivalents at build time, and the render
// effect is captured by reactivityGraphPlugin (installed in main.ts). The causal
// graph:
//   first, last ──▶ fullName ──▶ greeting ──▶ (watchEffect: document.title)
//   count ──▶ doubled ──▶ (watch: history)
//   cart ──▶ total ──▶ (combinedEffect)
//   celsius ⇄ fahrenheit (two-way sync loop)
//   greeting ──▶ <Counter> (prop, parent → child)
import { ref, reactive, computed, watch, watchEffect } from 'vue';
import Counter from './Counter.vue';

const first = ref('Ada');
const last = ref('Lovelace');
const count = ref(0);
const cart = reactive({ apples: 1, pears: 2, price: 100 });

const fullName = computed(() => `${first.value} ${last.value}`);
const greeting = computed(() => `Hello, ${fullName.value}!`);
const doubled = computed(() => count.value * 2);
const total = computed(() => (cart.apples + cart.pears) * cart.price);

const history = ref([]);

watch(doubled, (v) => { history.value.push(`doubled=${v}`); });
watchEffect(() => { document.title = greeting.value; });
watchEffect(() => { void total.value; void doubled.value; });

// two-way sync (circular): mutate either, propagation flows both directions
const celsius = ref(0);
const fahrenheit = ref(32);
watch(celsius, (v) => { fahrenheit.value = v * 9 / 5 + 32; });
watch(fahrenheit, (v) => { celsius.value = (v - 32) * 5 / 9; });

function randomName() {
  const names = ['Grace', 'Alan', 'Barbara', 'Edsger', 'Katherine'];
  first.value = names[Math.floor(Math.random() * names.length)];
}
</script>

<template>
  <main>
    <h1>🕸 vue-pulse — Vue reactivity graph playground</h1>
    <p class="hint">Mutate state below and watch the panel (bottom-right): nodes glow and pulses travel along the causal edges.</p>

    <section>
      <div class="card">
        <h2>name chain</h2>
        <code>first, last → fullName → greeting → titleEffect / &lt;Counter&gt;</code>
        <div class="row">
          <button @click="randomName">randomize first</button>
          <button @click="last = last + '!'">append to last</button>
        </div>
        <p>fullName: <b>{{ fullName }}</b></p>
        <p>greeting: <b>{{ greeting }}</b> (also drives document.title)</p>
        <!-- parent → child prop -->
        <Counter :label="greeting" />
      </div>

      <div class="card">
        <h2>counter chain</h2>
        <code>count → doubled → watchDoubled</code>
        <div class="row">
          <button @click="count++">count++</button>
          <button @click="count += 10">count += 10</button>
        </div>
        <p>count: <b>{{ count }}</b> · doubled: <b>{{ doubled }}</b></p>
        <p>history: {{ history.slice(-3).join(', ') }}</p>
      </div>

      <div class="card">
        <h2>reactive object chain</h2>
        <code>cart.{{ 'apples,pears,price' }} → total → combinedEffect</code>
        <div class="row">
          <button @click="cart.apples++">apples++</button>
          <button @click="cart.pears++">pears++</button>
          <button @click="cart.price += 10">price += 10</button>
        </div>
        <p>total: <b>{{ total }}</b></p>
      </div>
    </section>
  </main>
</template>

<style scoped>
main { max-width: 820px; margin: 32px auto; padding: 0 20px; font-family: system-ui, sans-serif; color: #0f172a; }
h1 { font-size: 22px; }
.hint { color: #475569; }
section { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; background: #fff; }
.card h2 { font-size: 15px; margin: 0 0 6px; }
.card code { display: block; font-size: 12px; color: #7c3aed; margin-bottom: 10px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
button { border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
button:hover { background: #eef2ff; }
p { margin: 4px 0; font-size: 14px; }
</style>
