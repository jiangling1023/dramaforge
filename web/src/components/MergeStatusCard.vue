<script setup>
/**
 * MergeStatusCard · 合成任务状态卡
 * 三态条（pending/processing/completed）是与流水线五态无关的冻结状态机；failed 走独立红色分支。
 */
import { computed } from 'vue';

const props = defineProps({
  segments: { type: Array, default: () => [] },            // 展示用序号数组（已映射为 Sxx 序号）
  mergedUrl: { type: String, default: '' },
  duration: { type: [Number, String], default: null },
  status: { type: String, default: '' },                   // pending/processing/completed/failed
  errorMsg: { type: String, default: '' },
  gpuTime: { type: [Number, String], default: null },      // 秒数或已格式化文本
});
const emit = defineEmits(['play', 'download', 'retry']);

const STEPS = [
  { key: 'pending', label: '待合成' },
  { key: 'processing', label: '合成中' },
  { key: 'completed', label: '已完成' },
];

const statusText = computed(() => ({
  pending: '待合成',
  processing: '合成中',
  completed: '已完成 · 可播放/下载',
  failed: '合成失败',
})[props.status] || '');

// 三态点亮：pending 首节点；processing 前两段；completed 全亮；failed 停在处理段并标红
const activeStep = computed(() => ({ pending: 1, processing: 2, completed: 3, failed: 2 })[props.status] || 0);
const isFailed = computed(() => props.status === 'failed');
// D-3/A-06：无 mergedUrl 或非 completed 时播放/下载保持禁用占位
const canUse = computed(() => props.status === 'completed' && !!props.mergedUrl);

const segmentLabel = computed(() => props.segments.length
  ? props.segments.map((n) => `S${String(n).padStart(2, '0')}`).join(' → ')
  : '—');
const durationLabel = computed(() => (props.duration === null || props.duration === undefined || props.duration === '')
  ? '—' : `${props.duration}s`);
const urlLabel = computed(() => props.mergedUrl || '—');
const gpuLabel = computed(() => {
  if (props.gpuTime === null || props.gpuTime === undefined || props.gpuTime === '') return '';
  if (typeof props.gpuTime === 'string') return props.gpuTime;
  const s = Math.max(0, Math.round(Number(props.gpuTime)));
  const m = Math.floor(s / 60);
  return m ? `用时 ${m}分${s % 60}秒` : `用时 ${s}秒`;
});
</script>

<template>
  <div class="merge-card card" :class="{ failed: isFailed }">
    <!-- 无任务空态（merge:null）：§8.2 原文 + 引导提交 -->
    <div v-if="!status" class="mc-empty">
      <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>
      <span>尚无合成任务，点击「合成整集视频」提交</span>
    </div>

    <template v-else>
      <div class="mc-head">
        <div class="mc-title">
          <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>
          <span>整集合成</span>
          <span class="mc-badge" :class="status">{{ statusText }}</span>
        </div>
        <span v-if="gpuLabel" class="mc-gpu">{{ gpuLabel }}</span>
      </div>

      <div class="mc-fields">
        <div class="mc-field"><span class="mc-k">分镜顺序</span><span class="mc-v mono">{{ segmentLabel }}</span></div>
        <div class="mc-field"><span class="mc-k">成片地址</span><span class="mc-v mono" :class="{ ph: !mergedUrl }">{{ urlLabel }}</span></div>
        <div class="mc-field"><span class="mc-k">时长</span><span class="mc-v">{{ durationLabel }}</span></div>
        <div class="mc-field"><span class="mc-k">任务状态</span><span class="mc-v" :class="status">{{ statusText }}</span></div>
      </div>

      <div class="mc-flow" aria-label="合成进度">
        <template v-for="(s, i) in STEPS" :key="s.key">
          <div class="mc-step" :class="{ done: activeStep > i + 1, cur: activeStep === i + 1, err: isFailed && i === 1 }">
            <span class="mc-dot"></span><span>{{ s.label }}</span>
          </div>
          <span v-if="i < STEPS.length - 1" class="mc-line" :class="{ on: activeStep > i + 1 }"></span>
        </template>
      </div>

      <div v-if="isFailed" class="mc-err">合成失败：{{ errorMsg || '未知原因' }}</div>

      <div class="mc-actions">
        <template v-if="isFailed">
          <button class="btn primary" @click="emit('retry')">重试合成</button>
        </template>
        <template v-else>
          <button class="btn primary" :disabled="!canUse" @click="emit('play')">播放</button>
          <button class="btn out" :disabled="!canUse" @click="emit('download')">下载</button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.merge-card { padding: 12px 14px; margin-bottom: 12px; }
.merge-card.failed { border-color: var(--err); background: #FDF1F0; }
.mc-empty { display: flex; align-items: center; gap: 8px; color: var(--ink3); font-size: var(--fs-body); }
.mc-empty .ic { color: var(--teal); }
.mc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mc-title { display: flex; align-items: center; gap: 7px; font-size: var(--fs-section); font-weight: 600; color: var(--ink); }
.mc-title .ic { color: var(--coral); }
.mc-badge { padding: 2px 8px; border-radius: var(--r-pill); font-size: var(--fs-label); font-weight: 600; }
.mc-badge.pending { background: var(--paper2); color: var(--ink2); }
.mc-badge.processing { background: var(--amberS); color: var(--amber); }
.mc-badge.completed { background: var(--greenS); color: var(--green); }
.mc-badge.failed { background: #FBE3E1; color: var(--err); }
.mc-gpu { font-size: var(--fs-meta); color: var(--ink3); }
.mc-fields { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 9px 10px; background: var(--surface2); border: 1px solid var(--line2); border-radius: var(--rs); }
.mc-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mc-k { font-size: var(--fs-label); color: var(--ink3); }
.mc-v { font-size: var(--fs-body); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-v.ph { color: var(--ink3); }
.mc-v.pending { color: var(--ink2); }
.mc-v.processing { color: var(--amber); }
.mc-v.completed { color: var(--green); }
.mc-v.failed { color: var(--err); }
.mc-flow { display: flex; align-items: center; margin: 12px 2px 4px; }
.mc-step { display: flex; align-items: center; gap: 5px; font-size: var(--fs-meta); color: var(--ink3); white-space: nowrap; }
.mc-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line); }
.mc-step.cur { color: var(--coral); font-weight: 600; }
.mc-step.cur .mc-dot { background: var(--coral); box-shadow: 0 0 0 1px var(--coral); }
.mc-step.done { color: var(--green); }
.mc-step.done .mc-dot { background: var(--green); box-shadow: 0 0 0 1px var(--green); }
.mc-step.err { color: var(--err); font-weight: 600; }
.mc-step.err .mc-dot { background: var(--err); box-shadow: 0 0 0 1px var(--err); }
.mc-line { flex: 1; height: 2px; margin: 0 8px; background: var(--line); border-radius: 2px; }
.mc-line.on { background: var(--green); }
.mc-err { margin-top: 8px; padding: 6px 9px; border-radius: var(--r-tag); background: #FBE3E1; color: var(--err); font-size: var(--fs-body); }
.mc-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.mc-actions .btn { min-width: 72px; }
</style>
