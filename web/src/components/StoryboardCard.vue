<script setup>
/** StoryboardCard · 分镜卡：首帧 + 序号/时长 + 景别 + 机位/场景 + 剧情 + 氛围 */
import { computed } from 'vue';
import NodeThumb from './NodeThumb.vue';

const props = defineProps({
  data: { type: Object, default: () => ({}) },
  active: { type: Boolean, default: false },
});
const emit = defineEmits(['select']);

const pad = (n) => String(n || 0).padStart(2, '0');
const no = computed(() => Number(props.data.storyboard_number) || 0);
const dur = computed(() => Number(props.data.duration_sec) || 0);
const firstFrame = computed(() => props.data.first_frame_image || props.data.composed_image || '');
// listStoryboards 返回 snake_case；机位/运动/场景拼成元信息 pill
const metaPills = computed(() => {
  const d = props.data;
  const pills = [d.angle, d.movement].filter(Boolean);
  if (d.location) pills.push(`${d.location}${d.time_of_day ? '/' + d.time_of_day : ''}`);
  return pills;
});
</script>

<template>
  <div class="sb-card card" :class="{ sel: active }" @click="emit('select', data)">
    <div class="sb-thumb">
      <NodeThumb :seed="`storyboard:${no}`" :src="firstFrame" ratio="9:16" />
      <span class="sb-no mono">S{{ pad(no) }}</span>
      <span class="sb-dur mono">{{ dur }}s</span>
    </div>
    <div class="sb-body">
      <div class="sb-head">
        <span class="sb-title">{{ data.title || `分镜 S${pad(no)}` }}</span>
        <span v-if="data.shot_type" class="sb-shot">{{ data.shot_type }}</span>
      </div>
      <div class="sb-meta">
        <span v-for="(p, i) in metaPills" :key="i" class="sb-pill">{{ p }}</span>
      </div>
      <p class="sb-plot">{{ data.result || data.description || '—' }}</p>
      <div v-if="data.atmosphere" class="sb-atmo">
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="3.5"/></svg>
        <span>{{ data.atmosphere }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sb-card { display: flex; gap: 12px; padding: 10px; cursor: pointer; min-width: 0; }
.sb-thumb { position: relative; flex: 0 0 74px; align-self: flex-start; }
.sb-no, .sb-dur { position: absolute; padding: 1px 5px; border-radius: var(--r-tag); font-size: var(--fs-label); color: #fff; background: rgba(16, 24, 32, .72); }
.sb-no { top: 5px; left: 5px; }
.sb-dur { bottom: 5px; right: 5px; }
.sb-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sb-head { display: flex; align-items: center; gap: 8px; }
.sb-title { font-size: 13px; font-weight: 700; color: var(--ink); }
.sb-shot { padding: 1px 7px; border-radius: var(--r-tag); background: var(--coralS); color: var(--coralD); font-size: var(--fs-label); font-weight: 600; }
.sb-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.sb-pill { padding: 1px 7px; border-radius: var(--r-tag); background: var(--paper2); color: var(--ink2); font-size: var(--fs-label); }
.sb-plot { margin: 7px 0 0; font-size: var(--fs-body); line-height: 1.6; color: var(--ink2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sb-atmo { display: flex; align-items: center; gap: 4px; margin-top: auto; padding-top: 7px; color: var(--coralD); font-size: var(--fs-meta); }
.sb-atmo .ic { width: 13px; height: 13px; }
</style>
