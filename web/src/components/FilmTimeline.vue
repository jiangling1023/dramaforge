<script setup>
/** FilmTimeline · 按 duration_sec 比例分段的时间轴；点段选中对应分镜 */
import { computed } from 'vue';

const props = defineProps({
  shots: { type: Array, default: () => [] },
  activeNo: { type: [Number, String], default: null },
});
const emit = defineEmits(['select']);

const pad = (n) => String(n || 0).padStart(2, '0');
const items = computed(() => props.shots.map((s) => ({
  raw: s,
  no: Number(s.storyboard_number) || 0,
  dur: Math.max(0, Number(s.duration_sec) || 0),
})));
const total = computed(() => items.value.reduce((sum, s) => sum + s.dur, 0));

// flex 按权重分配宽度即比例分段；总时长为 0 时等分，避免除零
function segStyle(s) {
  return { flexGrow: total.value ? s.dur : 1, flexBasis: 0 };
}
</script>

<template>
  <div v-if="items.length" class="film-timeline">
    <button
      v-for="s in items"
      :key="s.raw.id ?? s.no"
      class="ft-seg"
      :class="{ on: Number(activeNo) === s.no }"
      :style="segStyle(s)"
      :title="`S${pad(s.no)} · ${s.dur}s`"
      @click="emit('select', s.raw)"
    >
      <span class="ft-no mono">S{{ pad(s.no) }}</span>
      <span class="ft-dur mono">{{ s.dur }}s</span>
    </button>
  </div>
</template>

<style scoped>
.film-timeline { display: flex; width: 100%; height: 30px; gap: 2px; margin-bottom: 12px; }
.ft-seg {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 0 6px;
  background: var(--grad-primary);
  color: #fff;
  border-radius: var(--r-tag);
  overflow: hidden;
  transition: filter var(--t), box-shadow var(--t);
}
.ft-seg:hover { filter: brightness(1.06); }
.ft-seg.on { box-shadow: 0 0 0 2px var(--coralD), 0 0 0 4px var(--coralS); }
.ft-no { font-size: var(--fs-meta); font-weight: 700; }
.ft-dur { margin-left: 6px; font-size: var(--fs-label); opacity: .82; }
</style>
