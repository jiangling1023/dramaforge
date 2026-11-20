<script setup>
/**
 * NodeThumb · 首帧/资产缩略图统一外壳
 * 无 src 时渲染内联 SVG 占位（离线可见、零外部图片请求），有 src 时显示真实图、加载失败回退占位。
 * 不同 seed 派生确定性差异图形；seed 含类型关键字（如 storyboard:12）时套用该类型配色与图标。
 */
import { computed, getCurrentInstance, ref, watch } from 'vue';

const props = defineProps({
  seed: { type: [String, Number], default: 0 },    // 差异化种子，可含类型关键字
  ratio: { type: String, default: '9:16' },        // 宽高比 '9:16' / '16:9' / '1:1' …
  size: { type: [String, Number], default: null }, // 缩略图宽度（px 数值或 CSS 长度）；空则撑满父容器
  src: { type: String, default: '' },              // 真实图片地址；空则显示占位
});

// 同页多实例共用 <defs> 会串色，渐变 id 必须随实例唯一
const uid = getCurrentInstance()?.uid ?? 0;
const gid = `nt-g-${uid}`;
const hid = `nt-h-${uid}`;

const imgFailed = ref(false);
watch(() => props.src, () => { imgFailed.value = false; }); // src 变化要撤销上一次的失败态
const showImage = computed(() => !!props.src && !imgFailed.value);

const ratioCss = computed(() => {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(props.ratio || '');
  return m ? `${m[1]} / ${m[2]}` : '9 / 16';
});
const boxStyle = computed(() => ({
  aspectRatio: ratioCss.value,
  width: props.size == null ? '100%' : (typeof props.size === 'number' ? `${props.size}px` : props.size),
}));

/* 类型视觉：seed 命中关键字则用固定配色/图标，否则按 hash 从调色板派生 */
const TYPE_VISUALS = {
  drama: ['#3A2E5C', '#6A5AA8', '#C9B6FF', 'clapper'],
  episode: ['#233A55', '#4A86C7', '#A8D2FF', 'layers'],
  character: ['#1F4A45', '#3FB6A5', '#A8F0E4', 'people'],
  scene: ['#2C4A38', '#6FB684', '#C8ECCF', 'image'],
  prop: ['#5A3E1C', '#DDA24A', '#FFE0A0', 'target'],
  storyboard: ['#5C2E45', '#D96A9C', '#FFBEDC', 'film'],
  video: ['#5A2A2A', '#E2706A', '#FFC0B0', 'play'],
};
const PALETTES = [
  ['#1B2A3F', '#4A3A31', '#FFD79A'],
  ['#6E4A3E', '#3A3340', '#F09070'],
  ['#8A6238', '#2E2A28', '#FFD9A0'],
  ['#39404F', '#8A5A55', '#FFC9B2'],
  ['#2F3B52', '#566380', '#A8C0E0'],
  ['#2C4A38', '#5C8A68', '#BFE0C4'],
  ['#4A2E45', '#8A5A78', '#F0BAD0'],
  ['#5A3E1C', '#A8742F', '#FFE0A0'],
];
const ICONS = {
  clapper: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 8l2.5-5 4 5M9.5 8l2.5-5 4 5M16 8l2.5-5 3 5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3 3 0 010 6M18 14c2 .9 3 2.8 3 5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M4 17l5-5 3.5 3.5 3-3 4.5 4.5"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5L10 15.5z"/>',
};
const ICON_KEYS = Object.keys(ICONS);

// FNV-1a：同一 seed 恒定得到同一张图，避免重渲染时占位跳变
function hash(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const art = computed(() => {
  const s = String(props.seed ?? '');
  const h = hash(s);
  const type = Object.keys(TYPE_VISUALS).find((k) => s.includes(k));
  const [c0, c1, glow] = type ? TYPE_VISUALS[type] : PALETTES[h % PALETTES.length];
  const iconKey = type ? TYPE_VISUALS[type][3] : ICON_KEYS[h % ICON_KEYS.length];
  return {
    c0, c1, glow,
    icon: ICONS[iconKey],
    gx: 22 + ((h >> 4) & 45),          // 光晕错位
    gy: 34 + ((h >> 9) & 40),
    horizon: 100 + ((h >> 13) & 26),   // 地平线高低
    personX: 16 + ((h >> 17) & 40),
    twin: (h >> 21) & 1,               // 是否出现第二个人物剪影
  };
});
</script>

<template>
  <div class="node-thumb" :style="boxStyle">
    <img v-if="showImage" :src="src" alt="" @error="imgFailed = true" />
    <svg v-else viewBox="0 0 90 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient :id="gid" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" :stop-color="art.c0" />
          <stop offset="1" :stop-color="art.c1" />
        </linearGradient>
        <radialGradient :id="hid">
          <stop stop-color="#FFFFFF" stop-opacity=".7" />
          <stop offset="1" :stop-color="art.glow" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="90" height="160" :fill="`url(#${gid})`" />
      <circle :cx="art.gx" :cy="art.gy" r="34" :fill="`url(#${hid})`" opacity=".55" />
      <!-- 地平线 + 人物剪影：几何参数随 seed 变化，形成可区分占位 -->
      <rect x="0" :y="art.horizon" width="90" :height="160 - art.horizon" fill="#101820" opacity=".5" />
      <path :d="`M${art.personX} ${art.horizon}c0-13 6-20 12-20s12 7 12 20z`" fill="#0C121C" opacity=".88" />
      <path v-if="art.twin" :d="`M${art.personX + 26} ${art.horizon}c0-10 5-16 10-16s10 6 10 16z`" fill="#0C121C" opacity=".7" />
      <!-- 类型图标：内联 SVG path 居中叠加，不用 emoji 当主图标 -->
      <g transform="translate(27 58) scale(1.5)" fill="none" stroke="#fff" stroke-opacity=".3"
         stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" v-html="art.icon" />
    </svg>
  </div>
</template>

<style scoped>
.node-thumb {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 6px;
  background: #2B3040;
  line-height: 0;
}
.node-thumb > svg,
.node-thumb > img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>
