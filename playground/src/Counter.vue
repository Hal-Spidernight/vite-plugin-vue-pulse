<script setup>
// Child component: receives `label` from the parent (parent → child props edge)
// and has its own local reactive state (a `count` scoped to this component — it
// stays distinct from the parent's `count` thanks to component-scoped identity).
import { ref, computed } from 'vue';

const props = defineProps({ label: { type: String, default: '' } });

const count = ref(0);
const shout = computed(() => `${props.label} (${count.value})`);
</script>

<template>
  <div class="counter">
    <button @click="count++">child count++ ({{ count }})</button>
    <span>{{ shout }}</span>
  </div>
</template>

<style scoped>
.counter { margin-top: 10px; display: flex; gap: 8px; align-items: center; font-size: 13px; color: #334155; }
.counter button { border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; padding: 4px 8px; cursor: pointer; }
</style>
