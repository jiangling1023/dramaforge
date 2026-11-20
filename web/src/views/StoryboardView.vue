<script setup>
/**
 * StoryboardView · V-2 分镜视图容器
 * 合成任务链路：初始化 mergeByEpisode → 提交 mergeCreate → 轮询 mergeGet；三态以 API 返回为准，前端只 render。
 * M04(mergeAdvance) 是 GPU 回调契约，本视图按约束不调用。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api/index.js';
import MergeStatusCard from '../components/MergeStatusCard.vue';
import FilmTimeline from '../components/FilmTimeline.vue';
import StoryboardCard from '../components/StoryboardCard.vue';

const props = defineProps({
  dramaId: { type: [Number, String], required: true },
  episodeId: { type: [Number, String], required: true },
  shots: { type: Array, default: () => [] },
  mergeTask: { type: Object, default: null },
});
const emit = defineEmits(['merge', 'select-shot']);

const task = ref(props.mergeTask ? { ...props.mergeTask } : null);
const submitting = ref(false);
const submitError = ref('');
const activeNo = ref(null);
let pollTimer = null;

const MERGE_TOOLTIP = '把本集全部分镜按顺序拼接成整集成片（合成任务提交到 GPU 实例执行）';
const TERMINAL = ['completed', 'failed'];

const sortedShots = computed(() => [...props.shots].sort(
  (a, b) => (Number(a.storyboard_number) || 0) - (Number(b.storyboard_number) || 0),
));
// segments 取按 storyboard_number 升序的分镜 ID 数组（AC-006-2）
const segmentIds = computed(() => sortedShots.value.map((s) => Number(s.id)).filter(Boolean));
const hasShots = computed(() => segmentIds.value.length > 0);
const totalDuration = computed(() => sortedShots.value.reduce((sum, s) => sum + (Number(s.duration_sec) || 0), 0));

// 卡片按顺序渲染 Sxx：用当前集 id→storyboard_number 映射，映射不到时回退数组次序
const displaySegments = computed(() => {
  if (!task.value?.segments?.length) return [];
  const map = new Map(props.shots.map((s) => [Number(s.id), Number(s.storyboard_number) || 0]));
  return task.value.segments.map((id, i) => map.get(Number(id)) || i + 1);
});

// GPU 用时由 completedAt - createdAt 派生；提交后首轮 GET 尚未回填 createdAt，用前端提交时间兜底
const gpuTime = computed(() => {
  const t = task.value;
  if (!t?.createdAt) return null;
  const start = new Date(t.createdAt).getTime();
  const end = t.completedAt ? new Date(t.completedAt).getTime() : (t._startedAt || null);
  if (!start || !end || end < start) return null;
  return Math.round((end - start) / 1000);
});

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function publish(next) {
  task.value = next;
  emit('merge', next); // U-012 依此最新 merge 状态渲染 Inspector「整集已合成」
}
function pollOnce() {
  const id = task.value?.id;
  if (!id) return;
  api.mergeGet(id).then((res) => {
    publish(res);
    if (TERMINAL.includes(res?.status)) stopPoll();
  }).catch((e) => {
    console.error('[merge] 轮询失败', e);
    stopPoll();
  });
}
function startPoll() {
  stopPoll();
  pollTimer = setInterval(pollOnce, 2000);
}

async function refreshFromApi() {
  try {
    const res = await api.mergeByEpisode(props.episodeId);
    publish(res?.merge ?? null);
    if (task.value && !TERMINAL.includes(task.value.status)) startPoll();
  } catch (e) {
    console.error('[merge] 初始化失败', e);
  }
}

async function submitMerge() {
  if (!hasShots.value || submitting.value) return; // E-12：无分镜不调 create
  submitting.value = true;
  submitError.value = '';
  try {
    const res = await api.mergeCreate({
      dramaId: props.dramaId,
      episodeId: props.episodeId,
      segments: segmentIds.value,
    });
    publish({
      id: res.mergeId,
      status: res.status,
      segments: res.segments,
      mergedUrl: null, duration: null, errorMsg: null,
      createdAt: new Date().toISOString(), completedAt: null,
      _startedAt: Date.now(),
    });
    startPoll();
    pollOnce();
  } catch (e) {
    submitError.value = e?.message || '提交失败';
    console.error('[merge] 提交失败', e); // 提交失败写日志、按钮恢复
  } finally {
    submitting.value = false;
  }
}

function onSelect(shot) {
  activeNo.value = Number(shot?.storyboard_number) || Number(shot?.no) || null;
  emit('select-shot', shot);
}
function onPlay() {
  if (task.value?.mergedUrl) window.open(task.value.mergedUrl, '_blank');
}
function onDownload() {
  if (!task.value?.mergedUrl) return;
  const a = document.createElement('a');
  a.href = task.value.mergedUrl;
  a.download = '';
  a.click();
}

onMounted(refreshFromApi);
watch(() => props.episodeId, () => { stopPoll(); activeNo.value = null; refreshFromApi(); });
watch(() => props.shots, (list) => {
  if (activeNo.value == null && list.length) activeNo.value = Number(list[0].storyboard_number) || null;
}, { immediate: true });
onBeforeUnmount(stopPoll);
</script>

<template>
  <section class="storyboard-view">
    <header class="sv-head">
      <div class="sv-heading">
        <h2>分镜视图 · 第 {{ episodeId }} 集</h2>
        <div class="sv-sub">{{ sortedShots.length }} 个分镜 · {{ totalDuration }}s · 16:9 · 1080p</div>
      </div>
      <div class="sv-actions">
        <span class="sv-chip mono">总时长 {{ totalDuration }}s</span>
        <button
          class="btn primary gen pipeline"
          :disabled="!hasShots || submitting"
          :title="hasShots ? MERGE_TOOLTIP : '本集暂无可合成分镜'"
          @click="submitMerge"
        >
          <svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>
          {{ submitting ? '提交中…' : '合成整集视频' }}
        </button>
      </div>
    </header>

    <div v-if="submitError" class="sv-err">合成提交失败：{{ submitError }}</div>
    <div v-if="!hasShots" class="sv-noshots">本集暂无可合成分镜</div>

    <MergeStatusCard
      :segments="displaySegments"
      :merged-url="task?.mergedUrl || ''"
      :duration="task?.duration ?? null"
      :status="task?.status || ''"
      :error-msg="task?.errorMsg || ''"
      :gpu-time="gpuTime"
      @play="onPlay"
      @download="onDownload"
      @retry="submitMerge"
    />

    <FilmTimeline :shots="sortedShots" :active-no="activeNo" @select="onSelect" />

    <div class="sv-grid">
      <StoryboardCard
        v-for="s in sortedShots"
        :key="s.id"
        :data="s"
        :active="activeNo === Number(s.storyboard_number)"
        @select="onSelect"
      />
    </div>
  </section>
</template>

<style scoped>
.storyboard-view { padding: 18px 20px; }
.sv-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.sv-heading h2 { margin: 0; font-size: var(--fs-title); font-weight: 700; color: var(--ink); }
.sv-sub { margin-top: 3px; font-size: var(--fs-meta); color: var(--ink3); }
.sv-actions { display: flex; align-items: center; gap: 10px; }
.sv-chip { padding: 4px 10px; border-radius: var(--r-pill); background: var(--paper2); color: var(--ink2); font-size: var(--fs-meta); }
.gen.pipeline .ic { width: 14px; height: 14px; }
.sv-err { margin-bottom: 10px; padding: 7px 10px; border-radius: var(--r-tag); background: #FBE3E1; color: var(--err); font-size: var(--fs-body); }
.sv-noshots { margin-bottom: 10px; padding: 7px 10px; border-radius: var(--r-tag); background: var(--amberS); color: var(--amber); font-size: var(--fs-body); }
.sv-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 760px) { .sv-grid { grid-template-columns: 1fr; } }
</style>
