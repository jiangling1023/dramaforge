<script setup>
/**
 * 无限画布（F-003 按集连线 + F-004 按集分组）
 * - 滚轮以指针为锚点缩放，空格/中键拖拽平移；节点可拖动，位置保存到 canvas_layout
 * - 连线数据源是 canvas-data 的桥表聚合：桥表空则不连，绝不回退全项目角色（E-09）
 * - firstFrameImage 双源：画布缩略图取 canvas-data 聚合；Inspector 大图取 listStoryboards 全字段
 * - GET /canvas 响应已 breaking 为 {nodes, groups}（R7）
 */
import { computed, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '../api/index.js';
import EpisodeGroup from '../components/EpisodeGroup.vue';
import InspectorPanel from '../components/InspectorPanel.vue';
import LinkPath from '../components/LinkPath.vue';
import NodeThumb from '../components/NodeThumb.vue';
import ZoomToolbar from '../components/ZoomToolbar.vue';

const props = defineProps({
  dramaId: { type: Number, required: true },
  currentEpisodeId: { type: Number, default: null }, // 切集只切 focus，不 reload（E-08）
});
const emit = defineEmits(['episode-focus', 'select-node']);

const view = reactive({ x: 24, y: 24, zoom: 1 });
const nodes = ref([]);
const groups = ref([]);       // { episode_id, x, y, w, h, collapsed }
const links = ref([]);        // { from, to, episodeId }
const canvasData = ref(null); // API-C03 聚合数据
const loading = ref(true);
const error = ref('');
const selected = ref(null);
const canvasEl = ref(null);
const tsaving = ref('');
const focusedEpisodeId = ref(null);
const mergedBadge = ref(false);

// 浅底可见的语义色（令牌色值），用于六类节点与连线
const TYPE_META = {
  drama: { label: '项目', color: '#8B5CF6' },
  episode: { label: '剧集', color: '#5468D8' },
  character: { label: '角色', color: '#0E9F86' },
  scene: { label: '场景', color: '#3E9B64' },
  prop: { label: '道具', color: '#D98B2B' },
  storyboard: { label: '分镜', color: '#E25940' },
};
const LEGEND = Object.entries(TYPE_META).map(([t, m]) => ({ t, ...m }));

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- 布局：首次进入自动排布（按集分组） ---------------- */
function autoLayout(drama, data) {
  const out = [];
  const push = (type, id, x, y, w, h, extra = {}) =>
    out.push({ node_type: type, node_id: id, key: `${type}:${id}`, x, y, w, h,
      z_index: out.length, collapsed: 0, ...extra });

  const episodes = data?.episodes || drama.episodes || [];
  const shared = data?.sharedAssets || {};
  groups.value = []; // reload 时避免旧分组累积

  push('drama', drama.id, 24, 24, 240, 92);

  const colW = 860;
  let gy = 148;
  for (const ep of episodes) {
    const sbs = ep.storyboards || [];
    const rows = Math.max(1, Math.ceil(sbs.length / 2));
    const gh = 116 + rows * 150;
    groups.value.push({ episode_id: ep.id, x: 24, y: gy, w: colW, h: gh, collapsed: 0 });
    push('episode', ep.id, 40, gy + 58, 196, 82, { episode_id: ep.id });
    sbs.forEach((s, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      push('storyboard', s.id,
        252 + col * 296, gy + 58 + row * 150, 280, 136,
        { episode_id: ep.id, _thumb: s.firstFrameImage || '' });
    });
    gy += gh + 26;
  }

  const ax = 24 + colW + 44;
  const assetY = (arr, dx) => {
    let ay = 148;
    (arr || []).forEach((a) => { push(dx === 0 ? 'character' : (dx === 230 ? 'scene' : 'prop'),
      a.id, ax + dx, ay, 214, 84); ay += 98; });
  };
  assetY(shared.characters || drama.characters || [], 0);
  assetY(shared.scenes || drama.scenes || [], 230);
  assetY(shared.props || drama.props || [], 460);
  return out;
}

/* ---------------- 节点业务数据回填（非分镜节点用 getDrama 全字段） ---------------- */
function fillNodeData(drama) {
  const byKey = new Map();
  (drama.episodes || []).forEach((e) => byKey.set(`episode:${e.id}`, e));
  (drama.characters || []).forEach((c) => byKey.set(`character:${c.id}`, c));
  (drama.scenes || []).forEach((s) => byKey.set(`scene:${s.id}`, s));
  (drama.props || []).forEach((p) => byKey.set(`prop:${p.id}`, p));
  byKey.set(`drama:${drama.id}`, drama);
  nodes.value = nodes.value.map((n) => ({ ...n, _data: n._data || byKey.get(n.key) || null }));
}

function aggregateSb(s) {
  return {
    title: s.title, storyboard_number: s.storyboardNumber, duration_sec: s.durationSec,
    first_frame_image: s.firstFrameImage, status: s.status,
    character_ids: s.characterIds || [], prop_ids: s.propIds || [],
  };
}

/* ---------------- 连线：桥表驱动（E-09 桥表空不连、不回退全项目角色） ---------------- */
function buildLinks(data) {
  const out = [];
  const dramaKey = `drama:${data.drama?.id}`;
  for (const e of data.episodes || []) {
    const epKey = `episode:${e.id}`;
    out.push({ from: dramaKey, to: epKey, episodeId: e.id });
    (e.characterIds || []).forEach((id) => out.push({ from: epKey, to: `character:${id}`, episodeId: e.id }));
    (e.sceneIds || []).forEach((id) => out.push({ from: epKey, to: `scene:${id}`, episodeId: e.id }));
    (e.propIds || []).forEach((id) => out.push({ from: epKey, to: `prop:${id}`, episodeId: e.id }));
    for (const s of e.storyboards || []) {
      const sbKey = `storyboard:${s.id}`;
      out.push({ from: epKey, to: sbKey, episodeId: e.id });
      (s.characterIds || []).forEach((id) => out.push({ from: sbKey, to: `character:${id}`, episodeId: e.id }));
      (s.propIds || []).forEach((id) => out.push({ from: sbKey, to: `prop:${id}`, episodeId: e.id }));
    }
  }
  return out;
}

/* ---------------- 加载 ---------------- */
async function load() {
  loading.value = true;
  error.value = '';
  stopPolling();
  try {
    // getDrama/listStoryboards 保留现状（资产全字段 / Inspector 详情）；canvas-data 一次取齐分组与桥表
    const [drama, saved, data] = await Promise.all([
      api.getDrama(props.dramaId),
      api.getCanvas(props.dramaId),
      api.getCanvasData(props.dramaId),
    ]);
    canvasData.value = data;

    // R7 breaking：GET /canvas 由数组改为 {nodes, groups}；兼容读数组仅为容错，不作为契约
    const savedNodes = Array.isArray(saved) ? saved : (Array.isArray(saved?.nodes) ? saved.nodes : []);
    const savedGroups = Array.isArray(saved) ? [] : (Array.isArray(saved?.groups) ? saved.groups : []);
    const nodeMap = new Map(savedNodes.map((s) => [`${s.node_type}:${s.node_id}`, s]));
    const groupMap = new Map(savedGroups.map((g) => [g.episode_id, g]));

    const laid = autoLayout(drama, data);
    const merged = laid.map((b) => {
      const s = nodeMap.get(b.key);
      return s ? { ...b, x: s.x, y: s.y, w: s.w, h: s.h,
        z_index: s.z_index ?? b.z_index, collapsed: s.collapsed } : b;
    });
    groups.value = groups.value.map((g) => {
      const s = groupMap.get(g.episode_id);
      return s ? { ...g, x: s.x, y: s.y, w: s.w, h: s.h, collapsed: s.collapsed } : g;
    });

    // 分镜全字段：Inspector 大图/机位/摘要 + 出图写回（listStoryboards 全字段）
    const details = await Promise.all((data.episodes || []).map(async (e) => {
      try { return await api.listStoryboards(e.id); } catch { return []; }
    }));
    const detailMap = new Map();
    details.forEach((list) => list.forEach((s) => detailMap.set(`storyboard:${s.id}`, s)));
    const aggMap = new Map();
    (data.episodes || []).forEach((e) => (e.storyboards || []).forEach((s) => aggMap.set(`storyboard:${s.id}`, s)));
    merged.forEach((n) => {
      if (n.node_type !== 'storyboard') return;
      n._data = detailMap.get(n.key) || aggregateSb(aggMap.get(n.key) || {});
    });

    nodes.value = merged;
    fillNodeData(drama);
    links.value = buildLinks(data);

    if (!focusedEpisodeId.value || !(data.episodes || []).some((e) => e.id === focusedEpisodeId.value)) {
      focusedEpisodeId.value = props.currentEpisodeId ?? data.episodes?.[0]?.id ?? null;
    }
    if (!savedNodes.length) { view.x = 24; view.y = 24; view.zoom = 1; }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

/* ---------------- 分组视图 / 折叠 / focus ---------------- */
const episodeAgg = computed(() => new Map((canvasData.value?.episodes || []).map((e) => [e.id, e])));
const groupView = computed(() => groups.value.map((g) => {
  const ep = episodeAgg.value.get(g.episode_id) || {};
  return { ...g, index: ep.episodeNumber ?? 0, episode: ep, shots: ep.storyboards || [] };
}));
const collapsedSet = computed(() => new Set(groups.value.filter((g) => g.collapsed).map((g) => g.episode_id)));
const focusedNo = computed(() => episodeAgg.value.get(focusedEpisodeId.value)?.episodeNumber ?? null);

function focusEpisode(id) {
  if (focusedEpisodeId.value === id) return;
  focusedEpisodeId.value = id;          // 只切 focus：不 reload、不 resetView、不清 selected（E-08）
  emit('episode-focus', id);
}
function toggleGroup(id) {
  const g = groups.value.find((x) => x.episode_id === id);
  if (!g) return;
  g.collapsed = g.collapsed ? 0 : 1;
  scheduleSave();
}
function isDim(n) {
  return n.episode_id != null && focusedEpisodeId.value != null && n.episode_id !== focusedEpisodeId.value;
}
watch(() => props.currentEpisodeId, (id) => { if (id != null) focusEpisode(id); });

/* ---------------- 缩放 ---------------- */
function onWheel(e) {
  e.preventDefault();
  const rect = canvasEl.value.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz = clamp(view.zoom * factor, 0.15, 3);
  const wx = (px - view.x) / view.zoom;
  const wy = (py - view.y) / view.zoom;
  view.zoom = nz;
  view.x = px - wx * nz;
  view.y = py - wy * nz;
}

/* ---------------- 平移与拖拽 ---------------- */
let drag = null;
function onPointerDown(e) {
  if (e.button === 1 || e.target.dataset.bg === '1') {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
}
function onNodeDown(e, node) {
  e.stopPropagation();
  selected.value = node;
  emit('select-node', node);
  drag = { mode: 'node', node, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
  e.currentTarget.setPointerCapture(e.pointerId);
}
function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (drag.mode === 'pan') {
    view.x = drag.ox + dx;
    view.y = drag.oy + dy;
  } else {
    drag.node.x = drag.ox + dx / view.zoom;
    drag.node.y = drag.oy + dy / view.zoom;
  }
}
async function onPointerUp() {
  if (drag?.mode === 'node') await persist();
  drag = null;
}

/* ---------------- 保存位置 + 分组（API-C02 {nodes[含episode_id], groups}） ---------------- */
let saveTimer = null;
async function persist() {
  tsaving.value = '保存中';
  try {
    await api.saveCanvas(props.dramaId, {
      nodes: nodes.value.map((n) => ({
        node_type: n.node_type, node_id: n.node_id, episode_id: n.episode_id ?? null,
        x: n.x, y: n.y, w: n.w, h: n.h, z_index: n.z_index, collapsed: n.collapsed,
      })),
      groups: groups.value.map((g) => ({
        episode_id: g.episode_id, x: g.x, y: g.y, w: g.w, h: g.h, collapsed: g.collapsed,
      })),
    });
    tsaving.value = '已保存';
    setTimeout(() => { if (tsaving.value === '已保存') tsaving.value = ''; }, 1500);
  } catch (e) {
    tsaving.value = '保存失败：' + e.message;
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 600);
}

/* ---------------- 连线坐标 ---------------- */
function nodeMap() {
  const m = new Map();
  for (const n of nodes.value) m.set(n.key, n);
  return m;
}
const linkPaths = computed(() => {
  const m = nodeMap();
  const out = [];
  for (const l of links.value) {
    const a = m.get(l.from);
    const b = m.get(l.to);
    if (!a || !b) continue;
    if (collapsedSet.value.has(a.episode_id) || collapsedSet.value.has(b.episode_id)) continue;
    const emphasis = focusedEpisodeId.value == null || l.episodeId === focusedEpisodeId.value;
    out.push({
      from: { x: a.x + a.w, y: a.y + a.h / 2 },
      to: { x: b.x, y: b.y + b.h / 2 },
      color: TYPE_META[a.node_type]?.color || '#98A1AE',
      opacity: emphasis ? 0.85 : 0.2,
      emphasis,
    });
  }
  return out;
});

/* ---------------- 缩放控制 ---------------- */
function zoomBy(f) {
  const rect = canvasEl.value.getBoundingClientRect();
  const px = rect.width / 2;
  const py = rect.height / 2;
  const nz = clamp(view.zoom * f, 0.15, 3);
  const wx = (px - view.x) / view.zoom;
  const wy = (py - view.y) / view.zoom;
  view.zoom = nz;
  view.x = px - wx * nz;
  view.y = py - wy * nz;
}
function resetView() {
  view.zoom = 1;
  view.x = 24;
  view.y = 24;
}

/* ---------------- 节点内容 ---------------- */
function titleOf(n) {
  const d = n._data;
  switch (n.node_type) {
    case 'drama': return d?.title;
    case 'episode': return `第 ${d?.episode_number ?? episodeAgg.value.get(n.node_id)?.episodeNumber ?? '?'} 集`;
    case 'character': return d?.name;
    case 'scene': return d?.location;
    case 'prop': return d?.name;
    case 'storyboard': return `${d?.title || 'S'} · ${d?.shot_type || ''}`;
    default: return n.key;
  }
}
function subOf(n) {
  const d = n._data;
  switch (n.node_type) {
    case 'drama': return d?.genre || '';
    case 'episode': return d?.title || '';
    case 'character': return d?.role || '';
    case 'scene': return d?.time_of_day || '';
    case 'prop': return d?.type || '';
    case 'storyboard': return `${d?.duration_sec || 0}s · ${d?.movement || ''}`;
    default: return '';
  }
}

watch(() => props.dramaId, load, { immediate: false });
onMounted(async () => {
  await load();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  clearTimeout(saveTimer);
});
function onKey(e) {
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resetView(); }
}

/* ---------------- 合成标识（AC-006-6，数据来自 mergeByEpisode 最新状态） ---------------- */
watch(selected, async (n) => {
  mergedBadge.value = false;
  if (!n || n.node_type !== 'storyboard' || n.episode_id == null) return;
  try {
    const m = await api.mergeByEpisode(n.episode_id);
    if (selected.value?.key === n.key) mergedBadge.value = m?.status === 'completed';
  } catch { /* 合成服务未就绪不阻断画布 */ }
});

/* ---------------- 出图 / 出视频 ---------------- */
const GENERATABLE = ['storyboard', 'character', 'scene', 'prop'];
const actionBusy = ref('');
const actionMsg = ref('');
let pollTimer = null;

function isGeneratable(n) { return GENERATABLE.includes(n.node_type); }
function imageOf(n) { return n._thumb || n._data?.first_frame_image || n._data?.composed_image || ''; }
function videoOf(n) { return n.node_type === 'storyboard' ? (n._data?.video_url || '') : ''; }

function patchNode(node, patch) {
  const target = nodes.value.find((x) => x.key === node.key) || node;
  target._data = { ...(target._data || {}), ...patch };
  // 画布缩略图来自 canvas-data 聚合，出图后同步刷新两处，保持视觉一致
  if (patch.first_frame_image) target._thumb = patch.first_frame_image;
  if (patch.image_url) target._thumb = patch.image_url;
  selected.value = target;
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function genNodeImage() {
  const node = selected.value;
  if (!node || !isGeneratable(node)) return;
  actionBusy.value = '出图';
  actionMsg.value = '';
  try {
    const t = node.node_type;
    const r = await api.genImage({ targetType: t, targetId: node.node_id });
    patchNode(node, t === 'storyboard'
      ? { first_frame_image: r.imageUrl, status: 'imaged' }
      : { image_url: r.imageUrl });
    actionMsg.value = '出图完成';
  } catch (e) {
    actionMsg.value = '出图失败：' + e.message;
  } finally {
    actionBusy.value = '';
  }
}
async function genNodeVideo() {
  const node = selected.value;
  if (!node || node.node_type !== 'storyboard') return;
  actionBusy.value = '生成视频';
  actionMsg.value = '';
  stopPolling();
  try {
    const r = await api.genVideo({ storyboardId: node.node_id });
    if (r.videoUrl) {
      patchNode(node, { video_url: r.videoUrl, status: 'done' });
      actionMsg.value = '视频已生成';
      return;
    }
    if (r.taskId && !r.videoUrl) {
      actionMsg.value = '视频生成中…';
      await pollTask(node, r.taskId);
    } else {
      actionMsg.value = '视频任务已提交，请稍后刷新查看';
    }
  } catch (e) {
    actionMsg.value = '生成视频失败：' + e.message;
  } finally {
    actionBusy.value = '';
  }
}
function pollTask(node, taskId) {
  return new Promise((resolve) => {
    let tries = 0;
    const finish = () => { stopPolling(); resolve(); };
    const tick = async () => {
      if (tries++ >= 100) {
        actionMsg.value = '视频生成超时（5 分钟），请稍后刷新画布查看';
        finish(); return;
      }
      try {
        const t = await api.getTask(taskId);
        if (t.status === 'completed' && t.result_url) {
          patchNode(node, { video_url: t.result_url, status: 'done' });
          actionMsg.value = '视频已生成';
          finish(); return;
        }
        if (t.status === 'failed') {
          patchNode(node, { status: 'failed' });
          actionMsg.value = '视频生成失败：' + (t.error_msg || '上游任务失败');
          finish(); return;
        }
      } catch { /* 单次轮询失败不终止 */ }
    };
    stopPolling();
    pollTimer = setInterval(tick, 3000);
    tick();
  });
}
onUnmounted(stopPolling);

defineExpose({ reload: load });
</script>

<template>
  <div class="canvas-wrap">
    <div class="bar">
      <b>创作画布</b>
      <span class="sep">·</span>
      <span>1 张画布 / {{ groups.length }} 集分组</span>
      <span class="sep">·</span>
      <span>当前查看「第 {{ focusedNo ?? '—' }} 集」</span>
      <div class="legend">
        <span v-for="x in LEGEND" :key="x.t" class="lg"><i :style="{ background: x.color }" />{{ x.label }}</span>
      </div>
    </div>

    <div
      ref="canvasEl"
      class="canvas"
      data-bg="1"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="world" :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }">
        <!-- 集容器层 -->
        <EpisodeGroup
          v-for="g in groupView" :key="'g' + g.episode_id"
          :index="g.index" :episode="g.episode" :shots="g.shots"
          :focused="focusedEpisodeId === g.episode_id" :collapsed="!!g.collapsed"
          :x="g.x" :y="g.y" :w="g.w" :h="g.h"
          @focus="focusEpisode(g.episode_id)"
          @select="emit('episode-focus', g.episode_id)"
          @toggle-collapse="toggleGroup(g.episode_id)"
        />

        <!-- 连线层 -->
        <svg class="links" width="1" height="1">
          <LinkPath v-for="(l, i) in linkPaths" :key="i"
            :from="l.from" :to="l.to" :color="l.color" :opacity="l.opacity" :emphasis="l.emphasis" />
        </svg>

        <!-- 节点层 -->
        <div
          v-for="n in nodes" :key="n.key"
          v-show="n.episode_id == null || !collapsedSet.has(n.episode_id)"
          class="node"
          :class="[`t-${n.node_type}`, { sel: selected?.key === n.key, dim: isDim(n) }]"
          :style="{ left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }"
          @pointerdown="onNodeDown($event, n)"
        >
          <div class="tag">{{ TYPE_META[n.node_type]?.label }}</div>
          <div class="ttl">{{ titleOf(n) }}</div>
          <div class="sub">{{ subOf(n) }}</div>
          <div class="thumb">
            <NodeThumb :seed="`${n.node_type}:${n.node_id}`" ratio="3:2" :size="58" :src="imageOf(n)" @pointerdown.stop />
          </div>
          <a v-if="videoOf(n)" class="vbadge" :href="videoOf(n)" target="_blank" rel="noopener"
             @pointerdown.stop @click.stop>▶ 视频</a>
        </div>
      </div>

      <div v-if="loading" class="hint">正在载入画布…</div>
      <div v-if="error" class="hint err">{{ error }}</div>
    </div>

    <ZoomToolbar :zoom="view.zoom" :save-state="tsaving"
      @zoom-in="zoomBy(1.2)" @zoom-out="zoomBy(1 / 1.2)" @reset="resetView" />

    <InspectorPanel :node="selected" :status="selected?._data?.status || ''"
      :busy="actionBusy" :message="actionMsg" :merged-badge="mergedBadge"
      @image="genNodeImage" @video="genNodeVideo" @close="selected = null" />
  </div>
</template>

<style scoped>
.canvas-wrap { position: relative; width: 100%; height: 100%; overflow: hidden; }
.bar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 5; height: 44px;
  display: flex; align-items: center; gap: 6px; padding: 0 16px;
  background: var(--surface); border-bottom: 1px solid var(--line);
  font-size: 12px; color: var(--ink2);
}
.bar b { color: var(--ink); font-size: 13px; }
.bar .sep { color: var(--ink3); }
.legend { margin-left: auto; display: flex; gap: 12px; }
.lg { display: inline-flex; align-items: center; gap: 4px; color: var(--ink3); font-size: 11px; }
.lg i { width: 8px; height: 8px; border-radius: 2px; }

.canvas {
  position: absolute; inset: 0; top: 44px;
  background:
    radial-gradient(circle at 28% 18%, rgba(129, 140, 248, .08), transparent 55%),
    radial-gradient(circle at 76% 72%, rgba(14, 159, 134, .06), transparent 50%),
    var(--paper);
  background-image:
    linear-gradient(rgba(30, 38, 55, .045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(30, 38, 55, .045) 1px, transparent 1px);
  background-size: 40px 40px;
  cursor: grab;
  touch-action: none;
}
.canvas:active { cursor: grabbing; }
.world { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
.links { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }

.node {
  position: absolute;
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--s1);
  cursor: pointer;
  user-select: none;
  transition: border-color .15s, box-shadow .15s, opacity .15s;
  overflow: hidden;
}
.node:hover { box-shadow: var(--s2); }
.node.sel { border-color: var(--coral); box-shadow: var(--ring), var(--s2); }
.node.dim { opacity: .62; }
.node .tag {
  display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px;
  border-radius: var(--r-pill); margin-bottom: 6px;
}
.node .ttl { font-size: 13px; font-weight: 600; color: var(--ink); margin-bottom: 3px;
  max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node .sub { font-size: 11px; color: var(--ink3);
  max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.t-drama { border-left: 3px solid var(--violet); }
.t-episode { border-left: 3px solid var(--indigo); }
.t-character { border-left: 3px solid var(--teal); }
.t-scene { border-left: 3px solid var(--green); }
.t-prop { border-left: 3px solid var(--amber); }
.t-storyboard { border-left: 3px solid var(--coral); }
.t-drama .tag { background: var(--violetS); color: var(--violet); }
.t-episode .tag { background: var(--indigoS); color: var(--indigo); }
.t-character .tag { background: var(--tealS); color: var(--teal); }
.t-scene .tag { background: var(--greenS); color: var(--green); }
.t-prop .tag { background: var(--amberS); color: var(--amber); }
.t-storyboard .tag { background: var(--coralS); color: var(--coralD); }

.hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  color: var(--ink2); font-size: 13px;
  background: var(--surface); border: 1px solid var(--line);
  padding: 12px 20px; border-radius: 8px; box-shadow: var(--s2);
}
.hint.err { color: var(--err); }

.node .thumb { position: absolute; right: 8px; top: 8px; }
.node .vbadge {
  position: absolute; right: 8px; bottom: 8px; text-decoration: none;
  font-size: 10px; color: #fff; background: var(--coral);
  padding: 2px 8px; border-radius: var(--r-pill);
}
</style>
