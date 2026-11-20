<script setup>
/** 缩放工具条：放大/百分比/缩小/复位/保存指示 */
defineProps({
  zoom: { type: Number, default: 1 },
  saveState: { type: String, default: '' },
});
const emit = defineEmits(['zoom-in', 'zoom-out', 'reset']);
</script>

<template>
  <div class="tools">
    <button title="放大" @click="emit('zoom-in')">＋</button>
    <span class="pct">{{ Math.round(zoom * 100) }}%</span>
    <button title="缩小" @click="emit('zoom-out')">－</button>
    <button class="wide" title="复位 Ctrl/⌘+0" @click="emit('reset')">复位</button>
    <span v-if="saveState" class="save" :class="{ err: saveState.startsWith('保存失败') }">{{ saveState }}</span>
  </div>
</template>

<style scoped>
.tools {
  position: absolute; right: 20px; bottom: 20px;
  display: flex; align-items: center; gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 12px;
  box-shadow: var(--s2);
}
.tools button {
  width: 30px; height: 30px; border-radius: 7px; font-size: 16px;
  background: var(--paper2); color: var(--ink2);
}
.tools button:hover { background: var(--coralS); color: var(--coralD); }
.tools button.wide { width: auto; padding: 0 12px; font-size: 12px; }
.tools .pct { font-size: 12px; color: var(--ink2); min-width: 42px; text-align: center; }
.tools .save { font-size: 11px; color: var(--ok); margin-left: 4px; }
.tools .save.err { color: var(--err); }
</style>
