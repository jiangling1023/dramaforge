<script setup>
import { computed, ref, watch } from 'vue';
import { pipeline, createTask, restore, drainLogs, countChars, detectEpisodes } from '../pipelineLoop.js';
import EpisodeProgress from './EpisodeProgress.vue';
import StepFlow from './StepFlow.vue';
import ManualStepBox from './ManualStepBox.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  dramaId: { type: [Number, String], default: null },
  episodeId: { type: [Number, String], default: null },
  // §7 契约 props：App 若自持状态可传入作 idle 兜底；运行中一律以模块级 store 的 API 响应为准
  status: { type: String, default: '' },
  currentEpisode: { type: [Number, String], default: null },
  currentStep: { type: String, default: '' },
  totalEpisodes: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  errorSummary: { type: String, default: '' },
  episodeStates: { type: Array, default: () => [] },
});
const emit = defineEmits(['start', 'close', 'rerun-step', 'restore', 'log', 'select-episode']);

const script = ref('');
const aspect = ref('9:16');   // A-07 冻结默认
const autoImageOn = ref(false); // A-07 冻结默认
const useGpuVideo = ref(false); // G-006：分镜视频走 GPU（需 GPU 支持 video_gen，否则自动回退直出）
const scriptError = ref('');

const st = computed(() => pipeline.state || (props.status ? {
  status: props.status, currentEpisode: props.currentEpisode, currentStep: props.currentStep,
  totalEpisodes: props.totalEpisodes, percent: props.percent, errorSummary: props.errorSummary,
  episodeStates: props.episodeStates,
} : null));
const starting = computed(() => pipeline.creating || pipeline.running); // E-03 立即禁用
const chars = computed(() => countChars(script.value));
const detected = computed(() => detectEpisodes(script.value));
const recognition = computed(() => pipeline.createdInfo
  ? `共 ${pipeline.createdInfo.scriptChars} 字 · 识别 ${pipeline.createdInfo.totalEpisodes} 集`
  : `共 ${chars.value} 字 · 识别 ${detected.value} 集`);
const startLabel = computed(() => starting.value ? '处理中…' : `开始生成 · 一键跑完全部 ${detected.value} 集`);

const manualBusy = computed(() => ['queued', 'running'].includes(st.value?.status));
const rerunEpisodeId = computed(() => {
  const list = st.value?.episodeStates || [];
  return (list.find((e) => e.status === 'failed') || list.find((e) => e.episodeNumber === st.value?.currentEpisode))?.episodeId ?? props.episodeId;
});
const bottomTip = computed(() => {
  if (pipeline.notice) return pipeline.notice;
  const s = st.value;
  if (!s) return '步骤藏在幕后自动执行；无需手动点 4 次按钮。跑完可直接在分镜视图「合成整集视频」。';
  if (s.status === 'completed' && (s.errorSummary || s.failedEpisodes > 0 || s.episodeStates?.some((e) => e.status === 'failed'))) {
    const failed = s.failedEpisodes ?? s.episodeStates?.filter((e) => e.status === 'failed').length ?? 0;
    return `已完成 · ${failed} 集失败：${s.errorSummary}；流水线结束后可从手动单步重跑该步`;
  }
  if (s.status === 'completed') return '全部完成，可去分镜视图「合成整集视频」';
  if (s.status === 'failed') return s.errorSummary || '流水线执行失败，请从手动单步重跑该步';
  return '步骤藏在幕后自动执行；无需手动点 4 次按钮。跑完可直接在分镜视图「合成整集视频」。';
});
const tipWarn = computed(() => !!pipeline.error || !!pipeline.notice || !!st.value?.errorSummary);

function flushLogs() { for (const line of drainLogs()) emit('log', line); }
watch(() => pipeline.logSeq, flushLogs);
// 弹层重开：先补发销毁期间的日志，再按 taskId 从 P02 恢复（不清零）
watch(() => props.open, async (open) => {
  if (!open) return;
  flushLogs();
  const state = await restore();
  if (state) emit('restore', state);
}, { immediate: true });

function onStart() {
  if (starting.value) return; // 双击只发一次 create（E-03）
  if (!props.dramaId) { scriptError.value = '请先选择项目'; return; }
  if (chars.value < 20) { scriptError.value = '剧本内容过少，无法生成（至少 20 字）'; return; } // E-01 前端拦截
  scriptError.value = '';
  const payload = { dramaId: props.dramaId, script: script.value, aspect: aspect.value, autoImage: autoImageOn.value, useGpuVideo: useGpuVideo.value };
  emit('start', payload);
  createTask(payload); // create 后立即启动脱离弹层的循环
}

function onRerun(payload) {
  emit('rerun-step', payload);
  if (payload.ok) pipeline.notice = '已重跑完成，请关弹层到画布 / 分镜视图验收结果';
}

function onClose() { emit('close'); }
function onSelectEpisode(payload) { emit('select-episode', payload); }
function onScriptInput() { if (scriptError.value) scriptError.value = ''; }
</script>

<template>
  <div v-if="open" class="pm-mask" @click.self="onClose">
    <div class="pm">
      <header class="pm-h">
        <div class="pm-rocket">
          <svg class="ic" viewBox="0 0 24 24"><path d="M4 13c0-5 4-9 9-9 3 0 5 1 7 3-6 1-10 5-11 11l-5-5zM9 16l-3 3M14 9h.01" /></svg>
        </div>
        <div>
          <b>一键成片流水线</b>
          <p>贴一整部剧本进去，系统按集自动跑完全流程，你只需验收成片</p>
        </div>
        <button class="pm-x" title="关闭" @click="onClose">
          <svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <div class="pm-body">
        <div class="pm-l">
          <div class="plab">① 粘贴剧本</div>
          <div class="scriptbox" :class="{ invalid: scriptError }">
            <textarea
              v-model="script" class="sctxt" spellcheck="false"
              placeholder="粘贴整部剧本，系统按「第 N 集」或「EP N」自动切集…"
              @input="onScriptInput"
            />
            <div class="sccount">{{ recognition }}</div>
          </div>
          <div v-if="scriptError" class="scerr">{{ scriptError }}</div>
          <div v-if="pipeline.error" class="pm-alert">{{ pipeline.error }}</div>

          <button class="pm-go" :disabled="starting" @click="onStart">
            <svg class="ic" viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
            {{ startLabel }}
          </button>
          <div class="pm-opt">
            <span>画幅</span>
            <select v-model="aspect">
              <option value="9:16">9:16 竖屏 · 1080p</option>
              <option value="16:9">16:9 横屏 · 1080p</option>
            </select>
            <span>自动出图</span>
            <select v-model="autoImageOn">
              <option :value="false">关</option>
              <option :value="true">开</option>
            </select>
            <label class="pm-gpu" title="需云 GPU 支持 video_gen，否则自动回退 AI 直出">
              <input type="checkbox" v-model="useGpuVideo" /> 分镜视频走 GPU
            </label>
          </div>

          <ManualStepBox
            :busy="manualBusy" :drama-id="dramaId" :episode-id="rerunEpisodeId"
            @rerun="onRerun" @log="(l) => emit('log', l)"
          />
        </div>

        <div class="pm-r">
          <div class="plab">② 生成进度</div>
          <EpisodeProgress
            :current-episode="st?.currentEpisode"
            :current-step="st?.currentStep"
            :total-episodes="st?.totalEpisodes || 0"
            :percent="st?.percent || 0"
            :status="st?.status || ''"
            :error-summary="st?.errorSummary || ''"
            :episode-states="st?.episodeStates || []"
            :auto-image="autoImageOn"
            @select-episode="onSelectEpisode"
          >
            <template #default="{ steps, currentStep: cs, autoImage }">
              <StepFlow :steps="steps" :current-step="cs" :auto-image="autoImage" />
            </template>
          </EpisodeProgress>
        </div>
      </div>

      <footer class="pm-foot" :class="{ warn: tipWarn }">
        <svg v-if="!tipWarn" class="ic" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5" /></svg>
        <span>{{ bottomTip }}</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.pm-mask {
  position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center;
  background: rgba(30, 38, 55, .42); backdrop-filter: blur(3px); padding: 24px;
}
.pm {
  width: 940px; max-width: 100%; max-height: 100%; background: var(--surface);
  border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--s3);
  display: flex; flex-direction: column; overflow: hidden;
}
.pm-h {
  display: flex; align-items: center; gap: 12px; padding: 17px 20px 15px;
  border-bottom: 1px solid var(--line2); background: linear-gradient(105deg, var(--coralS), var(--surface) 55%);
}
.pm-rocket {
  width: 38px; height: 38px; border-radius: 11px; flex: 0 0 38px; display: grid; place-items: center; color: #fff;
  background: var(--grad-logo); box-shadow: 0 5px 14px rgba(226, 89, 64, .28);
}
.pm-rocket .ic { width: 20px; height: 20px; }
.pm-h b { font-size: 15.5px; letter-spacing: -.02em; }
.pm-h p { margin: 2px 0 0; font-size: 10.5px; color: var(--ink2); }
.pm-x { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: var(--ink2); }
.pm-x:hover { background: var(--paper2); color: var(--ink); }
.pm-x .ic { width: 15px; height: 15px; }
.pm-body { display: flex; min-height: 0; overflow: auto; }
.pm-l { width: 308px; flex: 0 0 308px; padding: 18px; border-right: 1px solid var(--line2); }
.pm-r { flex: 1; min-width: 0; padding: 18px 20px; }
.plab { font-size: 10px; font-weight: 700; color: var(--ink3); letter-spacing: .12em; margin-bottom: 9px; }

.scriptbox { border: 1px solid var(--line); border-radius: 11px; background: var(--surface2); padding: 8px 10px 20px; position: relative; }
.scriptbox:focus-within { border-color: var(--coral); box-shadow: 0 0 0 3px rgba(226, 89, 64, .08); background: #fff; }
.scriptbox.invalid { border-color: var(--err); box-shadow: 0 0 0 3px rgba(217, 69, 61, .1); }
.sctxt { border: none; background: transparent; padding: 0; min-height: 240px; font-size: 10.5px; line-height: 1.75; box-shadow: none !important; }
.sctxt:focus { border: none; }
.sccount { position: absolute; right: 10px; bottom: 5px; font-size: 9px; color: var(--ink3); }
.sccount b { color: var(--ink2); }
.scerr, .pm-alert { font-size: 10px; color: var(--err); margin-top: 6px; }
.pm-alert { padding: 7px 9px; background: #FDECEA; border-radius: 7px; }
.pm-go {
  width: 100%; height: 39px; margin-top: 12px; border-radius: 10px; color: #fff; font-size: 12px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: var(--grad-primary); box-shadow: 0 5px 14px rgba(226, 89, 64, .28); transition: all var(--t);
}
.pm-go:hover:not(:disabled) { transform: translateY(-1px); background: var(--grad-primary-hover); }
.pm-go .ic { width: 16px; height: 16px; }
.pm-opt { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 10px; color: var(--ink2); }
.pm-opt select { flex: 1; height: 30px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface2); font-size: 10.5px; padding: 0 8px; }
.pm-foot {
  display: flex; align-items: center; gap: 8px; padding: 11px 20px; border-top: 1px solid var(--line2);
  background: var(--surface2); font-size: 10px; color: var(--ink3);
}
.pm-foot .ic { width: 12px; height: 12px; color: var(--ok); }
.pm-foot.warn { color: var(--coralD); }
.pm-foot.warn .ic { color: var(--coral); }
</style>
