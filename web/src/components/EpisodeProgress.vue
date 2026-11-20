<script setup>
import { computed, onUnmounted, ref } from 'vue';
import { pipeline, estimateEta, STEP_LABEL, stepLabel } from '../pipelineLoop.js';
import StepFlow from './StepFlow.vue';

const props = defineProps({
  currentEpisode: { type: [Number, String], default: null },
  currentStep: { type: String, default: '' },
  totalEpisodes: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  status: { type: String, default: '' },
  errorSummary: { type: String, default: '' },
  episodeStates: { type: Array, default: () => [] },
  completedEpisodes: { type: Number, default: null },
  failedEpisodes: { type: Number, default: null },
  autoImage: { type: Boolean, default: false },
});
defineEmits(['select-episode']);

const nowTick = ref(Date.now());
const timer = setInterval(() => { nowTick.value = Date.now(); }, 10000);
onUnmounted(() => clearInterval(timer));

const FINAL = ['completed', 'failed'];
const hasTask = computed(() => !!props.status);
const doneCount = computed(() => props.completedEpisodes ?? props.episodeStates.filter((e) => e.status === 'done').length);
const failCount = computed(() => props.failedEpisodes ?? props.episodeStates.filter((e) => e.status === 'failed').length);
const stepText = computed(() => {
  if (!props.currentEpisode || !hasTask.value) return '准备中';
  const name = stepLabel(props.status === 'running' || props.status === 'queued' ? props.currentStep : '');
  return FINAL.includes(props.status) ? '已完成' : (name ? `正在${name}` : '准备中');
});
const etaText = computed(() =>
  FINAL.includes(props.status) ? '' : estimateEta({ episodeStates: props.episodeStates }, pipeline.createdAt, pipeline.totalSteps, nowTick.value)
);
const midEpisode = computed(() => Math.max(1, Math.ceil((props.totalEpisodes || 1) / 2)));

const currentSteps = computed(() => {
  const ep = props.episodeStates.find((e) => e.episodeNumber === props.currentEpisode)
    || props.episodeStates.find((e) => e.status === 'running')
    || props.episodeStates.find((e) => e.status === 'failed');
  return ep?.steps || [];
});

function epMeta(ep) {
  if (ep.status === 'pending') return '已入队';
  if (ep.status === 'failed') {
    const bad = (ep.steps || []).find((s) => s.status === 'failed');
    return bad ? `${STEP_LABEL[bad.step] || bad.step} 失败：${bad.errorMsg || '未知错误'}` : '本集存在失败步骤';
  }
  if (ep.status === 'running') return `拆解分镜中 · ${ep.storyboardCount || 0} 镜`;
  return `${ep.storyboardCount || 0} 镜 · ${ep.durationSec || 0}s`;
}
function epStateText(status) {
  return { pending: '待处理', running: '进行中', done: '已完成', failed: '失败' }[status] || '待处理';
}
function miniWidth(ep) {
  if (ep.status === 'done') return '100%';
  if (ep.status === 'pending') return '0%';
  const steps = ep.steps || [];
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return steps.length ? `${Math.round((done / steps.length) * 100)}%` : '0%';
}
</script>

<template>
  <div class="ep-progress">
    <template v-if="!hasTask">
      <div class="pipe-status idle">
        <div class="psic"><svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" /></svg></div>
        <div class="pst">粘贴剧本后点击「开始生成」查看进度</div>
      </div>
    </template>

    <template v-else>
      <div class="pipe-status">
        <div class="psic"><svg class="ic" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" /></svg></div>
        <div class="ps-main">
          <div class="pst">正在批量生成 · 第 {{ currentEpisode || 1 }} 集 / 共 {{ totalEpisodes }} 集</div>
          <div class="pssub">当前步骤：{{ stepText }}<template v-if="etaText"> · {{ etaText }}</template></div>
        </div>
        <div class="pspct"><b>{{ percent }}%</b><span>{{ doneCount }} / {{ totalEpisodes }} 集完成</span></div>
      </div>

      <div class="pbar"><span :style="{ width: percent + '%' }" /></div>
      <div class="pbarlab"><span>第 1 集</span><span>第 {{ midEpisode }} 集</span><span>第 {{ totalEpisodes }} 集</span></div>

      <div class="plab">当前集 · 三步流水线（步骤已隐藏到幕后）</div>
      <slot :steps="currentSteps" :current-step="currentStep" :auto-image="autoImage" />

      <div class="plab">各集状态（待处理 / 进行中 / 完成）</div>
      <div class="eplist">
        <div
          v-for="ep in episodeStates" :key="ep.episodeId"
          class="epcell" :class="{ done: ep.status === 'done', running: ep.status === 'running', failed: ep.status === 'failed', pending: ep.status === 'pending' }"
          @click="$emit('select-episode', { episodeId: ep.episodeId, episodeNumber: ep.episodeNumber })"
        >
          <div class="ectop">
            <span class="ecno">第 {{ ep.episodeNumber }} 集</span>
            <span class="ecdots"><i v-for="(s, i) in (ep.steps || [])" :key="i" :class="s.status" /></span>
          </div>
          <div class="ecmeta" :title="epMeta(ep)">{{ epMeta(ep) }}</div>
          <div class="ecstate">
            <svg v-if="ep.status === 'done'" class="ic" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" /></svg>
            <svg v-else-if="ep.status === 'failed'" class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            {{ epStateText(ep.status) }}
          </div>
          <div class="ecmini"><span :style="{ width: miniWidth(ep) }" /></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plab { font-size: 10px; font-weight: 700; color: var(--ink3); letter-spacing: .12em; margin: 0 0 9px; }
.pipe-status {
  display: flex; align-items: center; gap: 11px; padding: 12px 13px; border-radius: 12px;
  background: linear-gradient(100deg, var(--indigoS), var(--surface) 70%); border: 1px solid #DDE2F8;
}
.pipe-status.idle { background: var(--surface2); border-color: var(--line2); }
.psic {
  width: 34px; height: 34px; flex: 0 0 34px; border-radius: 10px; background: var(--indigo); color: #fff;
  display: grid; place-items: center; box-shadow: 0 4px 10px rgba(84, 104, 216, .24);
}
.pipe-status.idle .psic { background: var(--ink3); box-shadow: none; }
.psic .ic { width: 17px; height: 17px; }
.ps-main { min-width: 0; }
.pst { font-size: 12px; font-weight: 700; letter-spacing: -.01em; color: var(--ink); }
.pssub { font-size: 10px; color: var(--ink2); margin-top: 2px; }
.pspct { margin-left: auto; text-align: right; flex: 0 0 auto; }
.pspct b { font-size: 18px; font-weight: 700; color: var(--indigo); line-height: 1; }
.pspct span { font-size: 9px; color: var(--ink3); display: block; margin-top: 3px; }
.pbar { height: 8px; border-radius: 6px; background: var(--paper2); margin: 14px 0 5px; overflow: hidden; }
.pbar span { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, var(--indigo), #8EA0F0); transition: width .3s; }
.pbarlab { display: flex; justify-content: space-between; font-size: 9px; color: var(--ink3); margin-bottom: 16px; }
.eplist { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.epcell {
  border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; background: var(--surface2);
  display: flex; flex-direction: column; gap: 6px; position: relative; transition: all var(--t); cursor: pointer;
}
.epcell:hover { transform: translateY(-1px); border-color: var(--coral); }
.epcell.running { background: var(--coralS); border-color: #F2CFC4; box-shadow: 0 0 0 2px rgba(226, 89, 64, .08); }
.epcell.done { background: var(--greenS); border-color: #D7EADC; }
.epcell.failed { background: #FDECEA; border-color: #F4C7C2; }
.ectop { display: flex; align-items: center; gap: 6px; }
.ecno { font-size: 11px; font-weight: 700; }
.ecdots { margin-left: auto; display: flex; gap: 3px; }
.ecdots i { width: 5px; height: 5px; border-radius: 50%; background: #D8D2C8; }
.ecdots i.done { background: var(--green); }
.ecdots i.running { background: var(--coral); }
.ecdots i.failed { background: var(--err); }
.ecdots i.skipped { background: #D8D2C8; opacity: .45; }
.ecmeta { font-size: 9px; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ecstate { font-size: 9px; font-weight: 600; display: flex; align-items: center; gap: 4px; color: var(--ink3); }
.ecstate .ic { width: 11px; height: 11px; }
.epcell.done .ecstate { color: var(--green); }
.epcell.running .ecstate { color: var(--coralD); }
.epcell.failed .ecstate { color: var(--err); }
.ecmini { height: 3px; border-radius: 3px; background: var(--paper2); overflow: hidden; margin-top: 1px; }
.ecmini span { display: block; height: 100%; background: var(--green); border-radius: 3px; transition: width .3s; }
.epcell.running .ecmini span { background: var(--coral); animation: pulsew 1.6s ease-in-out infinite; }
.epcell.failed .ecmini span { background: var(--err); }
@keyframes pulsew { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
</style>
