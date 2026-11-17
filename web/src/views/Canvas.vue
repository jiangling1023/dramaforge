<script setup>
/**
 * 无限画布
 * - 滚轮以指针为锚点缩放，空格或中键拖拽平移
 * - 节点可拖动，位置保存到 canvas_layout
 * - 分镜 → 角色/道具 的连线直接来自桥表，不新增关系
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api/index.js';

const props = defineProps({ dramaId: { type: Number, required: true } });

const view = reactive({ x: 0, y: 0, zoom: 1 });
const nodes = ref([]);
const links = ref([]);
const loading = ref(true);
const error = ref('');
const selected = ref(null);
const canvasEl = ref(null);
const tsaving = ref('');

const TYPE_META = {
  drama: { label: '项目', color: '#8b7ce8' },
  episode: { label: '剧集', color: '#4a9eff' },
  character: { label: '角色', color: '#36d6c8' },
  scene: { label: '场景', color: '#5fc98a' },
  prop: { label: '道具', color: '#ffab3d' },
  storyboard: { label: '分镜', color: '#e86a9e' },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- 布局：首次进入自动排布 ---------------- */
function autoLayout(drama) {
  const out = [];
  const push = (type, id, x, y, w = 260, h = 150, extra = {}) =>
    out.push({ node_type: type, node_id: id, x, y, w, h, z_index: out.length, collapsed: 0, ...extra });

  push('drama', drama.id, 0, 0, 300, 170);

  const eps = drama.episodes || [];
  eps.forEach((e, i) => push('episode', e.id, 400, i * 200, 280, 150));

  const chars = drama.characters || [];
  chars.forEach((c, i) => push('character', c.id, 820, i * 180, 260, 150));

  const scenes = drama.scenes || [];
  scenes.forEach((s, i) => push('scene', s.id, 820 + 300, i * 180, 260, 150));

  const pps = drama.props || [];
  pps.forEach((p, i) => push('prop', p.id, 820 + 600, i * 180, 240, 140));

  return out;
}

/* ---------------- 加载 ---------------- */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const drama = await api.getDrama(props.dramaId);
    const saved = await api.getCanvas(props.dramaId);
    const savedMap = new Map(saved.map((s) => [`${s.node_type}:${s.node_id}`, s]));

    const base = autoLayout(drama);
    const merged = base.map((b) => {
      const s = savedMap.get(`${b.node_type}:${b.node_id}`);
      return s ? { ...b, x: s.x, y: s.y, w: s.w, h: s.h, collapsed: s.collapsed } : b;
    });

    // 分镜节点：每个有分镜的集展开一层
    let row = 0;
    for (const e of drama.episodes || []) {
      const sbs = await api.listStoryboards(e.id);
      sbs.forEach((s, i) => {
        const key = `storyboard:${s.id}`;
        const s0 = savedMap.get(key);
        const node = {
          node_type: 'storyboard', node_id: s.id,
          x: s0 ? s0.x : 400 + 340,
          y: s0 ? s0.y : row * 190 + i * 190,
          w: 300, h: 160, z_index: 100 + merged.length + i, collapsed: 0,
          _data: s, _episodeId: e.id,
        };
        merged.push(node);
        // 连线：分镜 → 角色 / 道具
        for (const cid of s.character_ids || []) {
          links.value.push({ from: key, to: `character:${cid}` });
        }
        for (const pid of s.prop_ids || []) {
          links.value.push({ from: key, to: `prop:${pid}` });
        }
        if (s.scene_id) links.value.push({ from: key, to: `scene:${s.scene_id}` });
      });
      row += sbs.length;
    }

    // 剧集 → 角色/场景/道具 的归属连线
    for (const e of drama.episodes || []) {
      const full = drama.characters || [];
      for (const c of full) links.value.push({ from: `episode:${e.id}`, to: `character:${c.id}` });
    }

    nodes.value = merged.map((n) => ({ ...n, key: `${n.node_type}:${n.node_id}` }));
    // 首次进入把画布居中到项目节点
    if (!saved.length) {
      const rect = canvasEl.value?.getBoundingClientRect();
      if (rect) {
        view.x = rect.width / 2 - 150;
        view.y = rect.height / 2 - 85;
      }
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

/* ---------------- 缩放 ---------------- */
function onWheel(e) {
  e.preventDefault();
  const rect = canvasEl.value.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz = clamp(view.zoom * factor, 0.15, 3);
  // 以指针为锚点：缩放前后指针指向的世界坐标不变
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

/* ---------------- 保存位置 ---------------- */
let saveTimer = null;
async function persist() {
  tsaving.value = '保存中';
  try {
    await api.saveCanvas(props.dramaId, nodes.value.map((n) => ({
      node_type: n.node_type, node_id: n.node_id,
      x: n.x, y: n.y, w: n.w, h: n.h,
      z_index: n.z_index, collapsed: n.collapsed,
    })));
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
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    out.push({
      d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      color: TYPE_META[a.node_type]?.color || '#555',
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
  view.x = 60;
  view.y = 60;
}

/* ---------------- 节点内容 ---------------- */
function titleOf(n) {
  const d = n._data;
  switch (n.node_type) {
    case 'drama': return d?.title;
    case 'episode': return `第 ${d?.episode_number} 集`;
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

/* 项目节点需要基础数据 */
const dramaData = ref(null);

watch(() => props.dramaId, load, { immediate: false });

onMounted(async () => {
  await load();
  try { dramaData.value = await api.getDrama(props.dramaId); } catch { /* 忽略 */ }
  // 把业务数据塞进节点，供渲染使用
  const d = dramaData.value;
  if (d) {
    const byKey = new Map();
    (d.episodes || []).forEach((e) => byKey.set(`episode:${e.id}`, e));
    (d.characters || []).forEach((c) => byKey.set(`character:${c.id}`, c));
    (d.scenes || []).forEach((s) => byKey.set(`scene:${s.id}`, s));
    (d.props || []).forEach((p) => byKey.set(`prop:${p.id}`, p));
    byKey.set(`drama:${d.id}`, d);
    nodes.value = nodes.value.map((n) => ({ ...n, _data: n._data || byKey.get(n.key) }));
  }
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  clearTimeout(saveTimer);
});
function onKey(e) {
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resetView(); }
}

defineExpose({ reload: load });
</script>

<template>
  <div class="canvas-wrap">
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
      <div
        class="world"
        :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }"
      >
        <!-- 连线层 -->
        <svg class="links" width="1" height="1">
          <path
            v-for="(l, i) in linkPaths"
            :key="i"
            :d="l.d"
            :stroke="l.color"
            stroke-width="1.5"
            fill="none"
            opacity="0.35"
          />
        </svg>

        <!-- 节点层 -->
        <div
          v-for="n in nodes"
          :key="n.key"
          class="node"
          :class="[`t-${n.node_type}`, { sel: selected?.key === n.key }]"
          :style="{ left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }"
          @pointerdown="onNodeDown($event, n)"
        >
          <div class="tag">{{ TYPE_META[n.node_type]?.label }}</div>
          <div class="ttl">{{ titleOf(n) }}</div>
          <div class="sub">{{ subOf(n) }}</div>
        </div>
      </div>

      <div v-if="loading" class="hint">正在载入画布…</div>
      <div v-if="error" class="hint err">{{ error }}</div>
    </div>

    <!-- 工具条 -->
    <div class="tools">
      <button @click="zoomBy(1.2)">＋</button>
      <span class="pct">{{ Math.round(view.zoom * 100) }}%</span>
      <button @click="zoomBy(1 / 1.2)">－</button>
      <button class="wide" @click="resetView">复位</button>
      <span v-if="tsaving" class="save">{{ tsaving }}</span>
    </div>

    <!-- 选中信息 -->
    <div v-if="selected" class="inspector">
      <div class="row"><b>{{ TYPE_META[selected.node_type]?.label }}</b> {{ titleOf(selected) }}</div>
      <div class="kv">{{ subOf(selected) || '—' }}</div>
      <div class="kv mono">{{ selected.key }}</div>
    </div>
  </div>
</template>

<style scoped>
.canvas-wrap { position: relative; width: 100%; height: 100%; overflow: hidden; }
.canvas {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 30% 20%, rgba(90, 70, 180, 0.10), transparent 55%),
    radial-gradient(circle at 75% 70%, rgba(40, 120, 140, 0.08), transparent 50%),
    #0b0d12;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
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
  padding: 14px 16px;
  background: rgba(24, 28, 38, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  user-select: none;
  transition: border-color .15s, box-shadow .15s;
  overflow: hidden;
}
.node:hover { border-color: rgba(255, 255, 255, 0.24); }
.node.sel { border-color: #ffb020; box-shadow: 0 0 0 2px rgba(255, 176, 32, .35), 0 8px 28px rgba(0,0,0,.5); }
.node .tag {
  display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 99px;
  margin-bottom: 8px; font-weight: 600;
}
.node .ttl { font-size: 15px; font-weight: 600; color: #eef1f7; margin-bottom: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node .sub { font-size: 12px; color: rgba(255, 255, 255, 0.45);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.t-drama { border-left: 3px solid #8b7ce8; }
.t-episode { border-left: 3px solid #4a9eff; }
.t-character { border-left: 3px solid #36d6c8; }
.t-scene { border-left: 3px solid #5fc98a; }
.t-prop { border-left: 3px solid #ffab3d; }
.t-storyboard { border-left: 3px solid #e86a9e; }
.t-drama .tag { background: rgba(139, 124, 232, .18); color: #a99cf0; }
.t-episode .tag { background: rgba(74, 158, 255, .18); color: #7ab8ff; }
.t-character .tag { background: rgba(54, 214, 200, .18); color: #5fe0d4; }
.t-scene .tag { background: rgba(95, 201, 138, .18); color: #7fd6a2; }
.t-prop .tag { background: rgba(255, 171, 61, .18); color: #ffbe6a; }
.t-storyboard .tag { background: rgba(232, 106, 158, .18); color: #ef8fb4; }

.hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, .55); font-size: 14px;
  background: rgba(15, 18, 26, .9); padding: 12px 20px; border-radius: 8px;
}
.hint.err { color: #ff7b72; }

.tools {
  position: absolute; right: 20px; bottom: 20px;
  display: flex; align-items: center; gap: 8px;
  background: rgba(20, 24, 33, .94);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 10px; padding: 8px 12px;
}
.tools button {
  background: rgba(255, 255, 255, .07); border: none; color: #dfe4ee;
  width: 30px; height: 30px; border-radius: 7px; cursor: pointer; font-size: 16px;
}
.tools button:hover { background: rgba(255, 255, 255, .14); }
.tools button.wide { width: auto; padding: 0 12px; font-size: 12px; }
.tools .pct { font-size: 12px; color: rgba(255,255,255,.6); min-width: 42px; text-align: center; }
.tools .save { font-size: 11px; color: #5fc98a; margin-left: 4px; }

.inspector {
  position: absolute; left: 20px; bottom: 20px; max-width: 340px;
  background: rgba(20, 24, 33, .94);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 10px; padding: 12px 16px; font-size: 12px; color: rgba(255,255,255,.75);
}
.inspector .row { margin-bottom: 6px; color: #eef1f7; }
.inspector .kv { color: rgba(255,255,255,.5); margin-top: 2px; }
.inspector .mono { font-family: ui-monospace, monospace; font-size: 11px; }
</style>
