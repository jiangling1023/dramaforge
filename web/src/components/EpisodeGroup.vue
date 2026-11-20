<script setup>
/**
 * 集容器：虚线框 + 标题牌，focus 实线高亮、非 focus 弱化，可折叠。
 * 只画背景框；分镜节点由 Canvas 在 world 层绝对定位，避免改动拖拽坐标系。
 */
import { computed } from 'vue';

const props = defineProps({
  index: { type: Number, default: 0 },
  episode: { type: Object, default: null },
  shots: { type: Array, default: () => [] },
  focused: { type: Boolean, default: false },
  collapsed: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  w: { type: Number, default: 860 },
  h: { type: Number, default: 200 },
});
const emit = defineEmits(['select', 'focus', 'toggle-collapse']);

const totalSec = computed(() => props.shots.reduce((s, x) => s + (x.durationSec || 0), 0));
const boxStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
  width: `${props.w}px`,
  height: `${props.collapsed ? 52 : props.h}px`,
}));

function onHead() {
  emit('focus');
  emit('select');
}
</script>

<template>
  <div class="ep-group" :class="{ focused, collapsed }" :style="boxStyle">
    <div class="ep-head" :title="episode?.title || ''" @pointerdown.stop @click.stop="onHead">
      <button class="fold" :title="collapsed ? '展开本集' : '折叠本集'"
              @pointerdown.stop @click.stop="emit('toggle-collapse')">
        {{ collapsed ? '▸' : '▾' }}
      </button>
      <span class="name">第 {{ index }} 集</span>
      <span class="stat">{{ shots.length }} 镜 · {{ totalSec }}s</span>
      <span v-if="focused" class="badge">当前查看</span>
    </div>
  </div>
</template>

<style scoped>
.ep-group {
  position: absolute;
  border: 1.5px dashed var(--line);
  border-radius: 14px;
  background: rgba(255, 255, 255, .5);
  opacity: .62;
  pointer-events: none;
  transition: opacity var(--t), border-color var(--t), background var(--t);
}
.ep-group.focused {
  opacity: 1;
  border: 2px solid var(--indigo);
  background: var(--indigoS);
  box-shadow: 0 2px 18px rgba(84, 104, 216, .10);
}
.ep-head {
  pointer-events: auto;
  display: flex; align-items: center; gap: 8px;
  height: 48px; padding: 0 14px;
  cursor: pointer; user-select: none;
  border-bottom: 1px solid var(--line2);
}
.ep-group.focused .ep-head { border-bottom-color: rgba(84, 104, 216, .25); }
.ep-group.collapsed .ep-head { border-bottom-color: transparent; }
.fold {
  width: 22px; height: 22px; flex: 0 0 auto;
  border-radius: 6px; background: var(--paper2); color: var(--ink2); font-size: 12px;
}
.fold:hover { background: var(--surface); color: var(--indigo); }
.name { font-size: 13px; font-weight: 700; color: var(--ink); }
.stat { font-size: 11px; color: var(--ink3); }
.badge {
  margin-left: auto; font-size: 10px; font-weight: 600; color: #fff;
  background: var(--indigo); padding: 2px 8px; border-radius: var(--r-pill);
}
</style>
