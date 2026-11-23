/**
 * 流水线轮询的模块级单例（E-10）。
 * 轮询生命周期挂模块而非弹层 DOM：弹层 v-if 销毁后 advance 循环照常推进；
 * 重开走 P02 恢复，刷新靠 localStorage 记住 taskId，均不清零进度。
 * 进度字段一律来自 API 响应（原样 render），前端不重算/改写语义；ETA 是唯一例外（纯前端估算）。
 */
import { reactive } from 'vue';
import { api } from './api/index.js';

const POLL_MS = 2000;
const LS_KEY = 'dramaforge:pipeline';
const FINAL = ['completed', 'failed'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STEP_LABEL = { script: '剧本改写', extract: '资产提取', storyboard: '拆解分镜', image: '出图资产' };
export const stepLabel = (key) => STEP_LABEL[key] || key || '';

function readPersisted() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
const saved = readPersisted();

export const pipeline = reactive({
  taskId: saved.taskId ?? null,
  totalSteps: saved.totalSteps ?? 0,
  createdAt: saved.createdAt ?? null, // 起点：优先响应 createdAt，缺失回退首次轮询前端时间戳
  firstPollAt: null,
  state: null,        // 最近一次 API-P02/P03 响应，原样 render
  creating: false,    // create 在途：E-03 同步禁用，杜绝双击双建
  running: false,     // advance 循环存活
  createdInfo: null,  // create 返回的 scriptChars / totalEpisodes，供核对
  error: null,        // create / restore 的错误文案
  notice: '',         // 重跑成功等临时引导
  logs: [],
  logSeq: 0,
});

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      taskId: pipeline.taskId, totalSteps: pipeline.totalSteps, createdAt: pipeline.createdAt,
    }));
  } catch { /* 隐私模式禁用 localStorage 时降级为仅内存恢复 */ }
}

let logCursor = 0;
/** 弹层重新挂载时取走未 emit 的日志，避免弹层销毁期间的日志丢失 */
export function drainLogs() {
  const out = pipeline.logs.filter((l) => l.id > logCursor);
  if (out.length) logCursor = out[out.length - 1].id;
  return out;
}

function pushLog(text, kind = 'info') {
  pipeline.logs.push({
    id: ++pipeline.logSeq, text, kind,
    at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  });
  if (pipeline.logs.length > 80) pipeline.logs.shift();
}

function markStart(state) {
  // 冻结契约 P02/P01 无 createdAt：优先读响应，缺失则回退首次轮询记录的前端时间戳
  if (pipeline.createdAt) return;
  pipeline.firstPollAt = pipeline.firstPollAt || Date.now();
  pipeline.createdAt = state.createdAt || pipeline.firstPollAt;
  persist();
}

function render(state) {
  markStart(state);
  pipeline.state = state; // 只 render，不改字段语义
  if (!pipeline.totalSteps && Array.isArray(state.episodeStates)) {
    pipeline.totalSteps = state.episodeStates.reduce((n, e) => n + (e.steps?.length || 0), 0);
    persist();
  }
  if (state.status === 'completed') {
    pushLog(state.errorSummary ? `流水线完成 · ${state.errorSummary}` : '流水线完成', state.errorSummary ? 'warn' : 'ok');
  } else if (state.currentEpisode) {
    pushLog(`流水线：第 ${state.currentEpisode} 集 / 共 ${state.totalEpisodes} 集 · ${stepLabel(state.currentStep)}`, 'info');
  }
}

function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/已有|重复|DUPLICATE/i.test(m)) return '已有任务正在处理，请勿重复提交';
  if (/剧本内容过短|至少 20 字|SCRIPT_TOO_SHORT/i.test(m)) return '剧本内容过少，无法生成（至少 20 字）';
  if (/额度不足/i.test(m)) return '额度不足，请检查配置';
  if (/繁忙|429|RATE_LIMITED/i.test(m)) return 'AI 服务繁忙，请稍后重试';
  return m || '创建任务失败，请重试';
}

let loopToken = 0;
/** 冻结调用约定：advance → render → 终态 break → sleep 2000；最大次数 totalSteps×2 */
export async function startLoop(taskId, totalSteps) {
  if (pipeline.running) return; // 幂等：任一时刻仅一个循环
  const token = ++loopToken;
  pipeline.running = true;
  pipeline.error = null;
  const max = Math.max(1, (totalSteps || pipeline.totalSteps || 0) * 2);
  let advances = 0;
  while (token === loopToken && advances < max) {
    if (FINAL.includes(pipeline.state?.status)) break;
    try {
      const state = await api.pipelineAdvance(taskId);
      if (token !== loopToken) return;
      advances++;
      render(state);
      if (FINAL.includes(state.status)) break;
    } catch (e) {
      // 409 CAS 抢占 / 网络抖动不是整体失败：记录后按 2s 重试，后端为幂等读
      pushLog(`流水线推进重试：${e.message}`, 'warn');
    }
    await sleep(POLL_MS);
  }
  if (token !== loopToken) return;
  pipeline.running = false;
  if (advances >= max && !FINAL.includes(pipeline.state?.status)) {
    pipeline.error = '流水线推进次数已达上限，请关闭弹层后重试';
    pushLog(pipeline.error, 'err');
  }
}

export async function createTask({ dramaId, script, aspect, autoImage, useGpuVideo = false }) {
  if (pipeline.creating || pipeline.running) {
    pipeline.error = '已有任务正在处理，请勿重复提交';
    return null;
  }
  pipeline.creating = true; // 同步置位：双击只发一次 create（E-03）
  pipeline.error = null;
  pipeline.state = null;
  pipeline.createdAt = null;
  pipeline.firstPollAt = null;
  pipeline.notice = '';
  pipeline.createdInfo = null;
  pushLog('流水线：正在创建任务…');
  try {
    // API-P01 的 steps 为可选字段：显式给全四步，autoImage 关时后端将 image 建为 skipped
    const data = await api.pipelineCreate({
      dramaId, script, aspect, autoImage, useGpuVideo,
      steps: ['script', 'extract', 'storyboard', 'image'],
    });
    pipeline.taskId = data.taskId;
    pipeline.totalSteps = data.totalSteps || 0;
    pipeline.createdInfo = { scriptChars: data.scriptChars, totalEpisodes: data.totalEpisodes };
    persist();
    pushLog(`流水线：任务 #${data.taskId} 已创建 · 识别 ${data.totalEpisodes} 集`, 'ok');
    startLoop(data.taskId, data.totalSteps); // 不 await：循环脱离弹层调用栈
    return data;
  } catch (e) {
    pipeline.error = friendlyError(e);
    pushLog(`流水线创建失败：${pipeline.error}`, 'err');
    return null;
  } finally {
    pipeline.creating = false;
  }
}

/** 重开/刷新恢复：GET P02 纯读拿同一结构；仍 running/queued 才恢复 advance 循环 */
export async function restore() {
  if (!pipeline.taskId) return null;
  if (FINAL.includes(pipeline.state?.status)) return pipeline.state;
  try {
    const state = await api.pipelineGet(pipeline.taskId);
    render(state);
    if (!FINAL.includes(state.status) && !pipeline.running) {
      startLoop(pipeline.taskId, pipeline.totalSteps); // 不 await：脱离弹层
    }
    pipeline.error = null;
    return state;
  } catch (e) {
    pipeline.error = '进度恢复失败，请重试'; // §5 taskId 错误文案
    pushLog(`${pipeline.error}：${e.message}`, 'err');
    return null;
  }
}

/** ETA 纯前端估算（§11.2 Q-1），文案带「约」，无样本显示占位，绝不伪造为后端字段 */
export function estimateEta(state, createdAt, totalSteps, now = Date.now()) {
  const steps = (state?.episodeStates || []).flatMap((e) => e.steps || []);
  const remaining = steps.filter((s) => s.status === 'pending' || s.status === 'running').length;
  const denom = (totalSteps || steps.length) - remaining; // 已完成步数 = totalSteps - (pending+running)
  if (!denom || !remaining || !createdAt) return '估算中…';
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return '估算中…';
  const minutes = Math.max(1, Math.ceil((Math.max(0, now - start) / denom) * remaining / 60000));
  return `预计剩余约 ${minutes} 分钟`;
}

/** 集识别：正则与后端 script-parser.js 一致，同集号合并计数 */
const EPISODE_RE = /^#{0,3}[ \t]*(?:第[ \t]*(\d+)[ \t]*集|EP[ \t]*(\d+))/gim;
export const countChars = (s) => String(s || '').replace(/\s+/g, '').length;
export function detectEpisodes(script) {
  const nums = [...String(script || '').matchAll(EPISODE_RE)].map((m) => Number(m[1] || m[2]) || 0);
  return new Set(nums.filter(Boolean)).size || 1; // 无集标记整部作 1 集，与后端一致
}
