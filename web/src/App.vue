<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api/index.js';
import { pipeline } from './pipelineLoop.js';
import { EXPERTS, parseExpertTag, toolDisplayName } from './config/experts.js';
import PipelineModal from './components/PipelineModal.vue';
import LogBar from './components/LogBar.vue';
import ChatPanel from './components/ChatPanel.vue';
import Canvas from './views/Canvas.vue';
import StoryboardView from './views/StoryboardView.vue';
import AssistantView from './views/AssistantView.vue';

const viewTabs = [
  { id: 'main', label: '主工作台', area: '创作画布' },
  { id: 'storyboard', label: '分镜视图', area: '分镜视图' },
  { id: 'assistant', label: '智能助手', area: '智能助手' },
];
const EP_STATE_TEXT = { done: '已完成', running: '处理中', pending: '已入队', failed: '失败' };

const view = ref('main');
const pipelineOpen = ref(false);
const chatOpen = ref(false);
const dramas = ref([]);
const currentId = ref(null);
const episodes = ref([]);
const currentEpisode = ref(null);
const shots = ref([]);
const canvasRef = ref(null);
const busy = ref('');
const logs = ref([]);
const serverOk = ref(false);
const serverVersion = ref('');
const assistantMessages = ref([]);
const assistantLoading = ref(false);

const drama = computed(() => dramas.value.find((d) => d.id === currentId.value) || null);
const currentEp = computed(() => episodes.value.find((e) => e.id === currentEpisode.value) || null);
const viewArea = computed(() => viewTabs.find((v) => v.id === view.value)?.area || '创作画布');

// 弹层内部自行驱动轮询；这里只读同一 store，给工具栏的禁用与「生成中…」提供状态
const pipelineActive = computed(() => pipeline.creating || pipeline.running || ['queued', 'running'].includes(pipeline.state?.status));
const pipelineStepLocked = computed(() => ['queued', 'running'].includes(pipeline.state?.status));
const stepTip = computed(() => pipelineStepLocked.value ? '流水线运行中，请勿手动重跑' : '手动单步·重跑用');
const epStateMap = computed(() => {
  const map = new Map();
  for (const e of pipeline.state?.episodeStates || []) if (e.episodeId) map.set(Number(e.episodeId), e.status);
  return map;
});

function log(text, kind = 'info') {
  logs.value.unshift({ text, kind, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  if (logs.value.length > 60) logs.value.pop();
}

async function boot() {
  try {
    const h = await api.health();
    serverOk.value = h.status === 'ok';
    serverVersion.value = h.version || '';
    log(`后端连接正常 · v${h.version || '-'}`, 'ok');
  } catch (e) {
    serverOk.value = false;
    log('后端未连接：' + e.message, 'err');
    return;
  }
  await loadDramas();
}

async function loadDramas() {
  try {
    dramas.value = await api.listDramas();
    if (!currentId.value && dramas.value.length) currentId.value = dramas.value[0].id;
  } catch (e) { log('读取项目失败：' + e.message, 'err'); }
}

async function loadEpisodes(id) {
  if (!id) { episodes.value = []; return; }
  try {
    episodes.value = await api.listEpisodes(id);
    if (!currentEpisode.value || !episodes.value.some((e) => e.id === currentEpisode.value)) {
      currentEpisode.value = episodes.value[0]?.id ?? null;
    }
  } catch (e) { log('读取剧集失败：' + e.message, 'err'); }
}

// 分镜视图的 shots 由外壳统一取；mergeTask 由 StoryboardView 自持并轮询
async function loadShots() {
  if (!currentEpisode.value) { shots.value = []; return; }
  try {
    shots.value = (await api.listStoryboards(currentEpisode.value)) || [];
  } catch (e) { log('读取分镜失败：' + e.message, 'err'); }
}

watch(currentId, async (id) => { currentEpisode.value = null; await loadEpisodes(id); });
watch(currentEpisode, loadShots);

async function createDrama() {
  const title = prompt('新项目名称', '电不骗人');
  if (!title) return;
  busy.value = '创建项目';
  try {
    const d = await api.createDrama({ title, genre: '都市', style: '悬疑反转', audience: '通用' });
    await loadDramas();
    currentId.value = d.id;
    log(`已创建项目「${title}」`, 'ok');
  } catch (e) { log(e.message, 'err'); } finally { busy.value = ''; }
}

async function createEpisode() {
  if (!currentId.value) return;
  busy.value = '创建剧集';
  try {
    const e = await api.createEpisode({ drama_id: currentId.value });
    await loadEpisodes(currentId.value);
    currentEpisode.value = e.id;
    log(`已创建第 ${e.episode_number} 集`, 'ok');
    canvasRef.value?.reload();
  } catch (e) { log(e.message, 'err'); } finally { busy.value = ''; }
}

/** 手动单步：按当前集走同步生成接口，不碰流水线 advance */
async function run(kind) {
  if (!currentId.value) return log('请先选择项目', 'err');
  if (!currentEpisode.value) return log('请先选定要处理的剧集（避免默认全集生成）', 'err');

  const label = { script: '生成剧本', extract: '提取资产', storyboard: '拆解分镜' }[kind];
  busy.value = label;
  log(`${label} · 第 ${currentEp.value?.episode_number} 集 开始…`);
  try {
    const payload = { dramaId: currentId.value, episodeId: currentEpisode.value };
    if (kind === 'script') {
      const r = await api.genScript(payload);
      const x = r.results[0];
      log(x.ok ? `剧本完成：${x.chars} 字` : `失败：${x.error}`, x.ok ? 'ok' : 'err');
    } else if (kind === 'extract') {
      const r = await api.genExtract(payload);
      log(`资产完成：角色 +${r.characters} 场景 +${r.scenes} 道具 +${r.props}`, 'ok');
    } else {
      const r = await api.genStoryboard(payload);
      const x = r.results[0];
      if (x.ok) {
        log(`分镜完成：${x.count} 个（${x.blocks} 个场景块）`, 'ok');
        if (x.warnings?.length) log(`部分块告警：${x.warnings.join('；')}`, 'warn');
      } else {
        log(`失败：${x.error}`, 'err');
      }
    }
    await loadEpisodes(currentId.value);
    await loadShots();
    canvasRef.value?.reload();
  } catch (e) {
    log(e.message, 'err');
  } finally {
    busy.value = '';
  }
}

/** 资产是项目级，只需项目；已有图的跳过，避免重复消耗额度 */
async function outImageAssets() {
  if (!currentId.value) return log('请先选择项目', 'err');

  let d;
  try {
    d = await api.getDrama(currentId.value);
  } catch (e) {
    return log('读取资产失败：' + e.message, 'err');
  }
  const pending = (arr) => (arr || []).filter((x) => !x.image_url);
  const tasks = [
    ...pending(d.characters).map((x) => ({ targetType: 'character', targetId: x.id, name: x.name })),
    ...pending(d.scenes).map((x) => ({ targetType: 'scene', targetId: x.id, name: x.location })),
    ...pending(d.props).map((x) => ({ targetType: 'prop', targetId: x.id, name: x.name })),
  ];
  if (!tasks.length) return log('没有待出图资产（可能已全部出图，或需先「提取资产」）', 'warn');

  busy.value = `出图 0/${tasks.length}`;
  let okCount = 0;
  let failCount = 0;
  try {
    for (let i = 0; i < tasks.length; i++) {
      busy.value = `出图 ${i + 1}/${tasks.length}`;
      try {
        await api.genImage({ targetType: tasks[i].targetType, targetId: tasks[i].targetId });
        okCount++;
      } catch (e) {
        failCount++;
        log(`${tasks[i].name} 出图失败：${e.message}`, 'err');
      }
    }
    log(`出图资产完成：成功 ${okCount} 个，失败 ${failCount} 个`, failCount ? 'warn' : 'ok');
    canvasRef.value?.reload();
  } finally {
    busy.value = '';
  }
}

function onEpisodeFocus(id) {
  const next = Number(id);
  if (next) currentEpisode.value = next;
}

function onSelectEpisode(payload) {
  const id = Number(payload?.episodeId);
  if (id) currentEpisode.value = id;
}

function onPipelineLog(line) {
  if (!line) return;
  if (typeof line === 'string') return log(line);
  log(line.text || '', line.kind || 'info');
}

const loggedMergeId = ref(null);
function onMerge(next) {
  // 合成状态每 2 秒轮询一次，仅在终态首次到达时落一条日志
  if (next?.status !== 'completed' || loggedMergeId.value === next.id) return;
  loggedMergeId.value = next.id;
  const epNo = episodes.value.find((e) => e.id === next.episodeId)?.episode_number ?? next.episodeId;
  log(`合成完成：第 ${epNo} 集整集视频 ${next.duration || 0}s → ${next.mergedUrl || '-'}`, 'ok');
}

async function onAssistantSend({ text, expertId }) {
  if (assistantLoading.value || !text?.trim()) return;
  assistantMessages.value.push({ role: 'user', content: text, expert: expertId, ts: Date.now() });
  assistantLoading.value = true;
  try {
    const history = assistantMessages.value
      .filter((m) => m.role !== 'collab')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));
    // chat() 契约固定 4 参；expertId 仅在展示层标注发言人
    const res = await api.chat(currentId.value, currentEpisode.value, text, history);
    const { expertId: tagId, content } = parseExpertTag(res.reply || '');
    assistantMessages.value.push({
      role: 'assistant', content, expert: tagId || expertId, ts: Date.now(),
    });
    for (const tc of (Array.isArray(res.toolCalls) ? res.toolCalls : [])) {
      const failed = tc.status === 'error' || tc.result?.error || tc.result?.success === false;
      if (failed) {
        assistantMessages.value.push({
          role: 'system',
          content: '工具调用失败：' + ((tc.result && tc.result.error) || tc.error || '未知错误'),
          ts: Date.now(),
        });
      } else {
        assistantMessages.value.push({
          role: 'tool', name: toolDisplayName(tc.name, tc.expert), result: tc.result,
          status: 'done', expert: tc.expert, ts: Date.now(),
        });
      }
    }
  } catch (e) {
    assistantMessages.value.push({ role: 'system', content: '错误：' + e.message, ts: Date.now() });
  } finally {
    assistantLoading.value = false;
  }
}

onMounted(boot);
</script>

<template>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <span class="dot" :class="serverOk ? 'on' : 'off'" />
        <b>DramaForge</b>
      </div>
      <div class="health" :class="serverOk ? 'on' : 'off'">
        {{ serverOk ? '服务连接正常' : '后端未连接' }}
        <span v-if="serverVersion">v{{ serverVersion }}</span>
      </div>

      <div class="sec">
        <div class="sec-h"><span>项目</span><button class="mini" :disabled="!!busy" @click="createDrama">＋</button></div>
        <div class="list">
          <div
            v-for="d in dramas" :key="d.id" class="item" :class="{ active: d.id === currentId }"
            @click="currentId = d.id"
          >
            <div class="t">{{ d.title }}</div>
            <div class="s">{{ d.episode_count || 0 }} 集 · {{ d.genre || '未设题材' }}</div>
            <div class="chips">
              <span v-if="d.style" class="tag">{{ d.style }}</span>
              <span class="tag">{{ d.aspect_ratio || '9:16' }} · {{ d.resolution || '1080p' }}</span>
            </div>
          </div>
          <div v-if="!dramas.length" class="empty">左侧还没有项目，先新建一个</div>
        </div>
      </div>

      <div class="sec grow">
        <div class="sec-h"><span>剧集</span><button class="mini" :disabled="!currentId || !!busy" @click="createEpisode">＋</button></div>
        <div class="list">
          <div
            v-for="e in episodes" :key="e.id" class="item" :class="{ active: e.id === currentEpisode }"
            @click="currentEpisode = e.id"
          >
            <div class="t">
              第 {{ e.episode_number }} 集
              <span v-if="epStateMap.get(e.id)" class="tag pst" :class="epStateMap.get(e.id)">
                {{ EP_STATE_TEXT[epStateMap.get(e.id)] || epStateMap.get(e.id) }}
              </span>
            </div>
            <div class="s">{{ e.title || '未命名' }} · {{ e.storyboard_count || 0 }} 镜</div>
          </div>
          <div v-if="currentId && !episodes.length" class="empty">还没有剧集</div>
        </div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="crumbs">
          <span>工作区</span><span class="slash">/</span>
          <b>{{ drama?.title || '未选择项目' }}</b><span class="slash">/</span>
          <span>{{ viewArea }}</span>
        </div>
        <div class="seg">
          <label v-for="v in viewTabs" :key="v.id" :class="{ on: view === v.id }">
            <input v-model="view" type="radio" name="view" :value="v.id" />
            {{ v.label }}
          </label>
        </div>
        <div class="decor">
          <span>⌘K</span><span>配置</span><span class="avatar">D</span>
        </div>
      </header>

      <div class="toolbar">
        <div class="ctx">
          <b>{{ drama?.title || '未选择项目' }}</b>
          <span v-if="currentEp" class="chip">第 {{ currentEp.episode_number }} 集 · {{ currentEp.storyboard_count || 0 }} 镜</span>
          <span v-else class="chip warn">未选剧集</span>
          <span class="chip spec">{{ drama?.aspect_ratio || '9:16' }} · {{ drama?.resolution || '1080p' }}</span>
        </div>
        <div class="ops">
          <button
            class="btn primary main-act" :disabled="!currentId || pipelineActive"
            :title="!currentId ? '请先新建项目' : ''"
            @click="pipelineOpen = true"
          >
            <svg class="ic" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>
            {{ pipelineActive ? '生成中…' : '一键成片流水线' }}
          </button>
          <span class="ready" :class="{ busy: !!busy }"><i />{{ busy ? busy + '中…' : '就绪' }}</span>
          <button class="btn out dim" :title="stepTip" :disabled="!currentId || !currentEpisode || !!busy || pipelineStepLocked" @click="run('script')">生成剧本</button>
          <button class="btn out dim" :title="stepTip" :disabled="!currentId || !currentEpisode || !!busy || pipelineStepLocked" @click="run('extract')">提取资产</button>
          <button class="btn out dim" :title="stepTip" :disabled="!currentId || !currentEpisode || !!busy || pipelineStepLocked" @click="run('storyboard')">拆解分镜</button>
          <button class="btn out dim" title="手动单步·重跑用" :disabled="!currentId || !!busy" @click="outImageAssets">出图资产</button>
          <button v-if="view !== 'assistant'" class="btn out toggle" :class="{ on: chatOpen }" @click="chatOpen = !chatOpen">助手</button>
        </div>
      </div>

      <div class="body">
        <div class="views" :class="{ 'with-chat': chatOpen && view !== 'assistant' }">
          <section v-show="view === 'main'" class="pane">
            <Canvas
              v-if="currentId" ref="canvasRef" :drama-id="currentId"
              :current-episode-id="currentEpisode" @episode-focus="onEpisodeFocus"
            />
            <div v-else class="blank">左侧还没有项目，先新建一个</div>
          </section>
          <section v-show="view === 'storyboard'" class="pane">
            <StoryboardView
              v-if="currentId && currentEpisode" :drama-id="currentId"
              :episode-id="currentEpisode" :shots="shots" @merge="onMerge"
            />
            <div v-else class="blank">{{ currentId ? '还没有剧集' : '左侧还没有项目，先新建一个' }}</div>
          </section>
          <section v-show="view === 'assistant'" class="pane">
            <AssistantView :messages="assistantMessages" :experts="EXPERTS" :loading="assistantLoading" @send="onAssistantSend" />
          </section>
        </div>
        <ChatPanel
          v-if="chatOpen && currentId && view !== 'assistant'"
          :drama-id="currentId" :episode-id="currentEpisode" @close="chatOpen = false"
        />
      </div>

      <LogBar :lines="logs" />
    </main>

    <PipelineModal
      :open="pipelineOpen" :drama-id="currentId" :episode-id="currentEpisode"
      :status="pipeline.state?.status || ''"
      :current-episode="pipeline.state?.currentEpisode ?? currentEpisode"
      :current-step="pipeline.state?.currentStep || ''"
      :total-episodes="pipeline.state?.totalEpisodes || 0"
      :percent="pipeline.state?.percent || 0"
      :error-summary="pipeline.state?.errorSummary || ''"
      :episode-states="pipeline.state?.episodeStates || []"
      @close="pipelineOpen = false" @log="onPipelineLog" @select-episode="onSelectEpisode"
    />
  </div>
</template>

<style scoped>
.app { display: flex; height: 100%; overflow: hidden; background: var(--paper); }

/* 左侧栏 */
.side {
  width: 232px; flex: 0 0 232px; display: flex; flex-direction: column;
  background: var(--surface); border-right: 1px solid var(--line);
}
.brand {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-4h); font-size: var(--fs-brand); letter-spacing: .04em;
  border-bottom: 1px solid var(--line);
}
.brand .dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.on { background: var(--green); box-shadow: 0 0 8px rgba(62, 155, 100, .5); }
.dot.off { background: var(--err); }
.health {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-2) var(--sp-4h); font-size: var(--fs-label);
  color: var(--ink3); border-bottom: 1px solid var(--line2);
}
.health.on { color: var(--green); }
.health.off { color: var(--err); }
.sec { display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--line2); }
.sec.grow { flex: 1; border-bottom: none; }
.sec-h {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-3) var(--sp-4) var(--sp-2); font-size: var(--fs-label);
  color: var(--ink3); letter-spacing: .12em; text-transform: uppercase;
}
.mini {
  width: 22px; height: 22px; background: var(--paper2); color: var(--ink2);
  font-size: 14px; line-height: 1;
}
.mini:hover:not(:disabled) { background: var(--coralS); color: var(--coralD); }
.list { overflow-y: auto; padding: 0 var(--sp-2h) var(--sp-3); }
.item {
  padding: var(--sp-2h) var(--sp-3); border-radius: var(--rs); cursor: pointer;
  margin-bottom: var(--sp-1); border: 1px solid transparent;
}
.item:hover { background: var(--surface2); }
.item.active { background: var(--coralS); border-color: var(--coral); }
.item .t { font-size: var(--fs-section); font-weight: 600; color: var(--ink); }
.item .s { font-size: var(--fs-meta); color: var(--ink3); margin-top: 2px; }
.chips { display: flex; gap: var(--sp-1); margin-top: var(--sp-1); flex-wrap: wrap; }
.tag {
  font-size: var(--fs-label); padding: 1px 6px; border-radius: var(--r-tag);
  background: var(--paper2); color: var(--ink2);
}
.tag.pst.done { background: var(--greenS); color: var(--green); }
.tag.pst.running { background: var(--coralS); color: var(--coralD); }
.tag.pst.failed { background: #FDECEA; color: var(--err); }
.empty { padding: var(--sp-2h) var(--sp-3); font-size: var(--fs-body); color: var(--ink3); }

/* 主区 */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  height: 54px; flex: 0 0 54px; display: flex; align-items: center; gap: var(--sp-4);
  padding: 0 var(--sp-5); background: var(--surface); border-bottom: 1px solid var(--line);
}
.crumbs { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-body); color: var(--ink2); white-space: nowrap; }
.crumbs b { color: var(--ink); }
.crumbs .slash { color: var(--ink3); }
.topbar .seg { margin-left: auto; }
.seg label input { display: none; }
.decor { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-label); color: var(--ink3); }
.decor .avatar {
  width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  background: var(--indigoS); color: var(--indigo); font-weight: 700;
}

.toolbar {
  height: 64px; flex: 0 0 64px; display: flex; align-items: center;
  justify-content: space-between; gap: var(--sp-3); padding: 0 var(--sp-5);
  background: var(--surface2); border-bottom: 1px solid var(--line);
}
.ctx { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.ctx b { font-size: var(--fs-title); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip {
  font-size: var(--fs-label); padding: 3px var(--sp-2h); border-radius: var(--r-pill);
  background: var(--indigoS); color: var(--indigo); white-space: nowrap;
}
.chip.warn { background: var(--amberS); color: var(--amber); }
.chip.spec { background: var(--paper2); color: var(--ink3); }
.ops { display: flex; align-items: center; gap: var(--sp-2); flex: 0 0 auto; }
.main-act { height: 36px; padding: 0 var(--sp-4); }
.dim { opacity: .72; }
.dim:hover:not(:disabled) { opacity: 1; }
.toggle.on { border-color: var(--coral); color: var(--coralD); background: var(--coralS); }
.ready { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-label); color: var(--ink3); white-space: nowrap; }
.ready i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
.ready.busy i { background: var(--amber); }

.body { flex: 1; display: flex; position: relative; min-height: 0; }
.views { flex: 1; position: relative; min-width: 0; }
.views.with-chat { margin-right: 312px; }
.pane { position: absolute; inset: 0; }
.blank {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; color: var(--ink3); font-size: var(--fs-body);
}
</style>
