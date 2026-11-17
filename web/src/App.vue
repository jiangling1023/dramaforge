<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from './api/index.js';
import Canvas from './views/Canvas.vue';
import ChatPanel from './components/ChatPanel.vue';

const dramas = ref([]);
const currentId = ref(null);
const episodes = ref([]);
const currentEpisode = ref(null);
const canvasRef = ref(null);
const chatOpen = ref(false);
const busy = ref('');
const logs = ref([]);
const serverOk = ref(false);

const drama = computed(() => dramas.value.find((d) => d.id === currentId.value) || null);

function log(text, kind = 'info') {
  logs.value.unshift({ text, kind, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  if (logs.value.length > 60) logs.value.pop();
}

async function boot() {
  try {
    const h = await api.health();
    serverOk.value = h.status === 'ok';
    log(`后端连接正常 · v${h.version}`, 'ok');
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

watch(currentId, async (id) => {
  currentEpisode.value = null;
  await loadEpisodes(id);
});

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

/** 统一的生成动作：必须先选定剧集，绝不默认扫全集 */
async function run(kind) {
  if (!currentId.value) return log('请先选择项目', 'err');
  if (!currentEpisode.value) return log('请先选定要处理的剧集（避免默认全集生成）', 'err');

  const label = { script: '生成剧本', extract: '提取资产', storyboard: '拆解分镜' }[kind];
  busy.value = label;
  log(`${label} · 第 ${episodes.value.find((e) => e.id === currentEpisode.value)?.episode_number} 集 开始…`);
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
    canvasRef.value?.reload();
  } catch (e) {
    log(e.message, 'err');
  } finally {
    busy.value = '';
  }
}

function toggleChat() { chatOpen.value = !chatOpen.value; }

onMounted(boot);
</script>

<template>
  <div class="app">
    <!-- 左栏 -->
    <aside class="side">
      <div class="brand">
        <span class="dot" :class="serverOk ? 'on' : 'off'" />
        <b>DramaForge</b>
      </div>

      <div class="sec">
        <div class="sec-h">
          <span>项目</span>
          <button class="mini" @click="createDrama">＋</button>
        </div>
        <div class="list">
          <div
            v-for="d in dramas"
            :key="d.id"
            class="item"
            :class="{ active: d.id === currentId }"
            @click="currentId = d.id"
          >
            <div class="t">{{ d.title }}</div>
            <div class="s">{{ d.episode_count }} 集 · {{ d.genre || '未设题材' }}</div>
          </div>
          <div v-if="!dramas.length" class="empty">还没有项目，点右上角 ＋ 新建</div>
        </div>
      </div>

      <div class="sec grow">
        <div class="sec-h">
          <span>剧集</span>
          <button class="mini" :disabled="!currentId" @click="createEpisode">＋</button>
        </div>
        <div class="list">
          <div
            v-for="e in episodes"
            :key="e.id"
            class="item"
            :class="{ active: e.id === currentEpisode }"
            @click="currentEpisode = e.id"
          >
            <div class="t">第 {{ e.episode_number }} 集</div>
            <div class="s">
              {{ e.title || '未命名' }} · {{ e.storyboard_count || 0 }} 镜
            </div>
          </div>
          <div v-if="currentId && !episodes.length" class="empty">还没有剧集</div>
        </div>
      </div>
    </aside>

    <!-- 主区 -->
    <main class="main">
      <!-- 助手按钮 -->
      <button class="chat-btn" :class="{ open: chatOpen }" @click="toggleChat" title="智能助手">🤖</button>

      <header class="bar">
        <div class="left">
          <b>{{ drama?.title || '未选择项目' }}</b>
          <span class="chip" v-if="currentEpisode">
            当前：第 {{ episodes.find((e) => e.id === currentEpisode)?.episode_number }} 集
          </span>
          <span class="chip warn" v-else>未选剧集</span>
        </div>
        <div class="right">
          <button class="act" :disabled="!currentEpisode || busy" @click="run('script')">生成剧本</button>
          <button class="act" :disabled="!currentEpisode || busy" @click="run('extract')">提取资产</button>
          <button class="act" :disabled="!currentEpisode || busy" @click="run('storyboard')">拆解分镜</button>
          <span v-if="busy" class="busy">{{ busy }}中…</span>
        </div>
      </header>

      <!-- 助手面板 -->
      <ChatPanel
        v-if="currentId && chatOpen"
        ref="chatPanelRef"
        :drama-id="currentId"
        :episode-id="currentEpisode"
        @close="chatOpen = false"
      />

      <div class="stage" :class="{ 'with-chat': chatOpen }">
        <Canvas v-if="currentId" ref="canvasRef" :drama-id="currentId" />
        <div v-else class="blank">左侧还没有项目，先新建一个</div>
      </div>

      <footer class="logbar">
        <div v-for="(l, i) in logs" :key="i" class="line" :class="l.kind">
          <span class="ts">{{ l.at }}</span>{{ l.text }}
        </div>
        <div v-if="!logs.length" class="line">等待操作…</div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; height: 100%; overflow: hidden; }
.side {
  width: 232px; flex: 0 0 232px; display: flex; flex-direction: column;
  background: var(--panel); border-right: 1px solid var(--line);
}
.brand {
  display: flex; align-items: center; gap: 8px;
  padding: 16px 18px; font-size: 15px; letter-spacing: .04em;
  border-bottom: 1px solid var(--line);
}
.brand .dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.on { background: var(--ok); box-shadow: 0 0 8px rgba(95, 201, 138, .7); }
.dot.off { background: var(--err); }
.sec { display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--line); }
.sec.grow { flex: 1; border-bottom: none; }
.sec-h {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px 8px; font-size: 12px; color: var(--txt-3);
  letter-spacing: .12em; text-transform: uppercase;
}
.mini {
  width: 22px; height: 22px; background: rgba(255, 255, 255, .07);
  color: var(--txt-2); font-size: 14px; line-height: 1;
}
.mini:hover:not(:disabled) { background: rgba(255, 176, 32, .2); color: var(--accent); }
.list { overflow-y: auto; padding: 0 10px 12px; }
.item {
  padding: 9px 11px; border-radius: 8px; cursor: pointer; margin-bottom: 4px;
  border: 1px solid transparent;
}
.item:hover { background: rgba(255, 255, 255, .04); }
.item.active { background: rgba(255, 176, 32, .1); border-color: rgba(255, 176, 32, .32); }
.item .t { font-size: 13px; font-weight: 500; color: var(--txt); }
.item .s { font-size: 11px; color: var(--txt-3); margin-top: 2px; }
.empty { padding: 10px 12px; font-size: 12px; color: var(--txt-3); }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.bar {
  height: 54px; flex: 0 0 54px; display: flex; align-items: center;
  justify-content: space-between; padding: 0 18px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
.bar .left { display: flex; align-items: center; gap: 10px; }
.bar .left b { font-size: 14px; }
.chip {
  font-size: 11px; padding: 3px 10px; border-radius: 99px;
  background: rgba(74, 158, 255, .16); color: #7ab8ff;
}
.chip.warn { background: rgba(255, 176, 32, .14); color: var(--accent); }
.bar .right { display: flex; align-items: center; gap: 8px; }
.act {
  padding: 8px 14px; font-size: 12px; color: var(--txt);
  background: rgba(255, 255, 255, .07);
}
.act:hover:not(:disabled) { background: rgba(255, 176, 32, .18); color: var(--accent); }
.busy { font-size: 12px; color: var(--accent); margin-left: 6px; }

.stage { flex: 1; position: relative; min-height: 0; }
.blank {
  position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; color: var(--txt-3); font-size: 13px;
}

/* 智能助手悬浮按钮 */
.chat-btn {
  position: absolute; right: 18px; top: 66px; z-index: 120;
  width: 42px; height: 42px; border-radius: 50%;
  background: linear-gradient(135deg, #4a9eff 0%, #7ab8ff 100%);
  color: #fff; font-size: 19px; line-height: 1;
  box-shadow: 0 6px 20px rgba(74, 158, 255, .45);
  display: flex; align-items: center; justify-content: center;
  transition: transform .15s, box-shadow .15s;
}
.chat-btn:hover { transform: scale(1.06); box-shadow: 0 8px 24px rgba(74, 158, 255, .55); }
.chat-btn.open { transform: rotate(90deg); }

.logbar {
  height: 116px; flex: 0 0 116px; overflow-y: auto; padding: 10px 18px;
  background: #0e1119; border-top: 1px solid var(--line);
  font-family: ui-monospace, "Noto Sans Mono", monospace; font-size: 11.5px; line-height: 1.85;
}
.line { color: var(--txt-3); }
.line.ok { color: var(--ok); }
.line.err { color: var(--err); }
.line.warn { color: var(--accent); }
.ts { color: rgba(255, 255, 255, .22); margin-right: 10px; }
</style>
