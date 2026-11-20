<script setup>
/**
 * 结构化 Inspector：预览 + 元数据 + 摘要 + 动作 + 状态条 + 合成标识。
 * 详情元数据与大图读 node._data（listStoryboards 全字段），与画布缩略图（canvas-data 聚合）双源不混用。
 */
import { computed } from 'vue';
import NodeThumb from './NodeThumb.vue';

const props = defineProps({
  node: { type: Object, default: null },
  status: { type: String, default: '' },
  busy: { type: String, default: '' },
  message: { type: String, default: '' },
  mergedBadge: { type: Boolean, default: false },
});
const emit = defineEmits(['image', 'video', 'close']);

const LABEL = { drama: '项目', episode: '剧集', character: '角色', scene: '场景', prop: '道具', storyboard: '分镜' };
const GENERATABLE = ['storyboard', 'character', 'scene', 'prop'];
const STATUS_TEXT = { pending: '待生成', imaged: '已出图', done: '已完成', failed: '失败' };

const d = computed(() => props.node?._data || {});
const isStoryboard = computed(() => props.node?.node_type === 'storyboard');
const canImage = computed(() => GENERATABLE.includes(props.node?.node_type));
const canVideo = computed(() => isStoryboard.value);
const no = computed(() => d.value.storyboard_number ?? props.node?.storyboardNumber ?? '');
const title = computed(() => d.value.title || (isStoryboard.value ? '首帧图' : LABEL[props.node?.node_type] || ''));
const bigSrc = computed(() => (isStoryboard.value
  ? (d.value.first_frame_image || d.value.composed_image || '')
  : (d.value.image_url || '')));
const seed = computed(() => `${props.node?.node_type || 'node'}:${props.node?.node_id ?? 0}`);

const meta = computed(() => {
  if (!isStoryboard.value) return [];
  const out = [];
  if (d.value.shot_type) out.push(['景别', d.value.shot_type]);
  if (d.value.angle) out.push(['机位', d.value.angle]);
  if (d.value.movement) out.push(['运动', d.value.movement]);
  if (d.value.duration_sec != null) out.push(['时长', `${d.value.duration_sec}s`]);
  if (d.value.scene_id != null) out.push(['场景', `#${d.value.scene_id}`]);
  const c = (d.value.character_ids || []).length;
  const p = (d.value.prop_ids || []).length;
  out.push(['关联', `角色 ${c} · 道具 ${p}`]);
  return out;
});

const summary = computed(() => d.value.result || '');
const statusText = computed(() => STATUS_TEXT[props.status] || props.status || '待生成');

const strip = computed(() => {
  if (!isStoryboard.value) return '';
  const img = d.value.first_frame_image ? '首帧图已就绪' : '首帧图待生成';
  const vid = d.value.video_url ? '视频已就绪' : '视频待生成';
  return `${img} · ${vid}`;
});
</script>

<template>
  <div v-if="node" class="inspector">
    <div class="row">
      <span v-if="isStoryboard" class="badge">S{{ String(no).padStart(2, '0') }}</span>
      <b>{{ isStoryboard ? '分镜' : (LABEL[node.node_type] || '节点') }} · {{ title }}</b>
      <span class="chip" :class="status">{{ statusText }}</span>
      <button class="close" title="关闭" @click="emit('close')">×</button>
    </div>

    <div class="preview">
      <div class="thumb"><NodeThumb :seed="seed" ratio="9:16" :size="96" :src="bigSrc" /></div>
      <div class="meta">
        <div v-for="(m, i) in meta" :key="i" class="kv"><span>{{ m[0] }}</span>{{ m[1] }}</div>
        <div v-if="!meta.length" class="kv muted">{{ node.key }}</div>
      </div>
    </div>

    <div v-if="summary" class="summary" :title="summary">{{ summary }}</div>

    <div v-if="canImage || canVideo" class="acts">
      <button v-if="canImage" class="primary" :disabled="!!busy" @click="emit('image')">
        {{ busy === '出图' ? '处理中…' : (isStoryboard ? '出首帧图' : '出图') }}
      </button>
      <button v-if="canVideo" :disabled="!!busy" @click="emit('video')">
        {{ busy === '生成视频' ? '处理中…' : '生成视频' }}
      </button>
    </div>
    <div v-if="message" class="msg">{{ message }}</div>

    <div class="statusbar">
      <span>{{ strip || node.key }}</span>
      <span v-if="isStoryboard" class="mono">{{ node.node_type }}:{{ node.node_id }}</span>
      <span v-if="mergedBadge" class="merged">★ 整集已合成</span>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  position: absolute; left: 20px; bottom: 20px; width: 322px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px; padding: 14px 16px;
  box-shadow: var(--s3);
  animation: rise .18s ease;
}
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--ink); font-size: 13px; }
.row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  background: var(--coralS); color: var(--coralD); padding: 2px 7px; border-radius: var(--r-tag);
}
.chip {
  margin-left: auto; font-size: 10px; white-space: nowrap;
  padding: 2px 8px; border-radius: var(--r-pill); background: var(--paper2); color: var(--ink3);
}
.chip.done { background: var(--greenS); color: var(--green); }
.chip.imaged { background: var(--indigoS); color: var(--indigo); }
.chip.failed { background: #FCEAEA; color: var(--err); }
.close { flex: 0 0 auto; width: 20px; height: 20px; line-height: 1; color: var(--ink3); font-size: 17px; border-radius: 6px; }
.close:hover { background: var(--paper2); color: var(--ink); }

.preview { display: flex; gap: 12px; }
.thumb { flex: 0 0 auto; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.kv { font-size: 11px; color: var(--ink2); display: flex; gap: 6px; }
.kv span { color: var(--ink3); min-width: 30px; flex: 0 0 auto; }
.kv.muted { color: var(--ink3); }

.summary {
  margin-top: 10px; font-size: 11px; line-height: 1.6; color: var(--ink2);
  max-height: 54px; overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}

.acts { display: flex; gap: 8px; margin-top: 12px; }
.acts button {
  font-size: 11px; font-weight: 600; padding: 6px 12px; border-radius: var(--rs);
  background: var(--paper2); color: var(--ink2); border: 1px solid var(--line);
}
.acts button:hover:not(:disabled) { border-color: var(--ink3); }
.acts button.primary { background: var(--coral); color: #fff; border-color: var(--coral); }
.acts button.primary:hover:not(:disabled) { background: var(--coralD); }
.msg { margin-top: 8px; font-size: 11px; color: var(--ok); }

.statusbar {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line2);
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 10px; color: var(--ink3);
}
.statusbar .mono { font-family: var(--font-mono); }
.merged { margin-left: auto; color: var(--amber); font-weight: 700; }
</style>
