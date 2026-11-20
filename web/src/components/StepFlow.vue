<script setup>
import { computed } from 'vue';
import { STEP_LABEL } from '../pipelineLoop.js';

const props = defineProps({
  steps: { type: Array, default: () => [] },
  currentStep: { type: String, default: '' },
  autoImage: { type: Boolean, default: false },
});

const ORDER = ['script', 'extract', 'storyboard', 'image'];
const nodes = computed(() => {
  const list = Array.isArray(props.steps) ? [...props.steps] : [];
  // 后端默认不建 image 步：autoImage 关时补一个 skipped 显示节点，保持四步视觉完整
  if (!list.some((s) => s?.step === 'image')) {
    list.push({ step: 'image', status: props.autoImage ? 'pending' : 'skipped', errorMsg: null });
  }
  return ORDER.map((key) => list.find((s) => s?.step === key))
    .filter(Boolean)
    .map((s) => ({
      key: s.step,
      label: STEP_LABEL[s.step] || s.step,
      status: ['pending', 'running', 'done', 'failed', 'skipped'].includes(s.status) ? s.status : 'pending',
      errorMsg: s.errorMsg || '',
    }));
});
</script>

<template>
  <div class="sf-flow">
    <template v-for="(node, i) in nodes" :key="node.key">
      <div class="sf-node" :class="node.status" :title="node.status === 'failed' && node.errorMsg ? node.errorMsg : undefined">
        <div class="sf-circle">
          <svg v-if="node.status === 'done'" class="ic" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" /></svg>
          <span v-else-if="node.status === 'failed'" class="sf-mark">×</span>
          <span v-else class="sf-mark">{{ i + 1 }}</span>
        </div>
        <div class="sf-name">{{ node.label }}</div>
        <div v-if="node.status === 'failed' && node.errorMsg" class="sf-err">{{ node.errorMsg }}</div>
      </div>
      <div v-if="i < nodes.length - 1" class="sf-line" :class="{ done: node.status === 'done' }" />
    </template>
  </div>
</template>

<style scoped>
.sf-flow { display: flex; align-items: flex-start; margin-bottom: 16px; }
.sf-node { display: flex; flex-direction: column; align-items: center; gap: 5px; flex: 0 0 74px; text-align: center; }
.sf-circle {
  width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
  font-size: 11px; font-weight: 700; border: 1px solid var(--line);
  background: var(--paper2); color: var(--ink3); transition: all var(--t);
}
.sf-circle .ic { width: 15px; height: 15px; }
.sf-name { font-size: 9.5px; color: var(--ink3); white-space: nowrap; }
.sf-line { flex: 1; height: 2px; background: var(--line); margin: 14px -2px 0; border-radius: 2px; }
.sf-line.done { background: var(--green); }

.sf-node.done .sf-circle { background: var(--greenS); color: var(--green); border-color: #D7EADC; }
.sf-node.done .sf-name { color: var(--ink2); }
.sf-node.running .sf-circle {
  background: var(--coral); color: #fff; border-color: transparent;
  animation: sfPulse 1.4s ease-in-out infinite;
}
.sf-node.running .sf-name { color: var(--coralD); font-weight: 700; }
.sf-node.failed .sf-circle { background: #FDECEA; color: var(--err); border-color: #F4C7C2; }
.sf-node.failed .sf-name { color: var(--err); font-weight: 700; }
.sf-node.failed .sf-err {
  font-size: 8.5px; line-height: 1.3; color: var(--err); max-width: 74px;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.sf-node.skipped .sf-circle { background: var(--paper2); color: var(--ink3); opacity: .55; }
.sf-node.skipped .sf-name { color: var(--ink3); text-decoration: line-through; opacity: .65; }
@keyframes sfPulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(226, 89, 64, .12); }
  50% { box-shadow: 0 0 0 6px rgba(226, 89, 64, .04); }
}
</style>
