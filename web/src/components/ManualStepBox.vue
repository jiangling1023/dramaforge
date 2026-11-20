<script setup>
import { computed, ref } from 'vue';
import { api } from '../api/index.js';

const props = defineProps({
  steps: { type: Array, default: () => [] },
  variant: { type: String, default: 'box' }, // 'box' | 'toolbar'
  busy: { type: Boolean, default: false },   // 流水线 queued/running → 前 3 个按钮锁定
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], default: null },
});
const emit = defineEmits(['rerun', 'log']);

const ALL = [
  { key: 'script', label: '剧本改写' },
  { key: 'extract', label: '资产提取' },
  { key: 'storyboard', label: '拆解分镜' },
  { key: 'image', label: '出图资产' },
];
const shown = computed(() => {
  const keys = props.steps.length ? props.steps : (props.variant === 'toolbar' ? ALL.map((s) => s.key) : ['script', 'extract', 'storyboard']);
  return ALL.filter((s) => keys.includes(s.key));
});
const active = ref('');

function tip(kind) {
  if (kind !== 'image' && props.busy) return '流水线运行中，请勿手动重跑';
  if (kind !== 'image' && !props.episodeId) return '请先选定要处理的剧集（避免默认全集生成）';
  if (kind === 'image' && !props.dramaId) return '请先选择项目';
  return '';
}
const disabled = (kind) => !!tip(kind) || (!!active.value && active.value !== kind);

async function runCore(kind) {
  const payload = { dramaId: props.dramaId, episodeId: props.episodeId };
  if (kind === 'script') {
    const r = await api.genScript(payload);
    const x = r?.results?.[0];
    if (!x?.ok) throw new Error(x?.error || '剧本改写失败');
    return `剧本改写完成：${x.chars} 字`;
  }
  if (kind === 'extract') {
    const r = await api.genExtract(payload);
    return `资产提取完成：角色 +${r.characters} 场景 +${r.scenes} 道具 +${r.props}`;
  }
  const r = await api.genStoryboard(payload);
  const x = r?.results?.[0];
  if (!x?.ok) throw new Error(x?.error || '拆解分镜失败');
  if (x.warnings?.length) emit('log', { text: `部分块告警：${x.warnings.join('；')}`, kind: 'warn' });
  return `拆解分镜完成：${x.count} 个`;
}

async function runImage() {
  const d = await api.getDrama(props.dramaId);
  const pending = [
    ...(d.characters || []).filter((x) => !x.image_url).map((x) => ({ targetType: 'character', targetId: x.id })),
    ...(d.scenes || []).filter((x) => !x.image_url).map((x) => ({ targetType: 'scene', targetId: x.id })),
    ...(d.props || []).filter((x) => !x.image_url).map((x) => ({ targetType: 'prop', targetId: x.id })),
  ];
  if (!pending.length) return '没有待出图资产（可能已全部出图，或需先「提取资产」）';
  let ok = 0;
  for (const p of pending) {
    try { await api.genImage(p); ok++; } catch (e) { emit('log', { text: `出图失败：${e.message}`, kind: 'err' }); }
  }
  return `出图资产完成：成功 ${ok} 个，失败 ${pending.length - ok} 个`;
}

async function run(kind) {
  if (disabled(kind)) return;
  active.value = kind;
  try {
    // 同步 /generate/* 链路：不回写 pipeline_steps、不调 advance、不改弹层历史 failed 态（Q-3 b）
    const message = kind === 'image' ? await runImage() : await runCore(kind);
    emit('rerun', { kind, ok: true, message });
    emit('log', { text: message, kind: 'ok' });
  } catch (e) {
    emit('rerun', { kind, ok: false, message: e.message });
    emit('log', { text: `重跑失败：${e.message}`, kind: 'err' });
  } finally {
    active.value = '';
  }
}
</script>

<template>
  <div :class="variant === 'toolbar' ? 'ms-toolbar' : 'ms-box'">
    <div v-if="variant !== 'toolbar'" class="ms-head" title="手动单步·重跑用">手动单步·重跑用</div>
    <div class="ms-row">
      <button
        v-for="s in shown" :key="s.key" class="ms-btn"
        :disabled="disabled(s.key)" :title="tip(s.key) || '手动单步·重跑用'"
        @click="run(s.key)"
      >{{ active === s.key ? '处理中…' : s.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.ms-box { margin-top: 16px; padding: 11px 12px; border: 1px dashed var(--line); border-radius: 10px; background: var(--surface2); }
.ms-head { font-size: 9.5px; font-weight: 700; color: var(--ink3); letter-spacing: .06em; margin-bottom: 8px; }
.ms-row { display: flex; gap: 6px; flex-wrap: wrap; }
.ms-btn {
  font-size: 9.5px; padding: 5px 9px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink2); transition: all var(--t);
}
.ms-btn:hover:not(:disabled) { color: var(--coralD); border-color: #F3CFC5; }
.ms-toolbar .ms-btn { font-size: 11px; padding: 7px 12px; }
</style>
