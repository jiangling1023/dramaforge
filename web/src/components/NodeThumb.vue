<script setup>
/**
 * NodeThumb · 统一缩略图组件
 * 根据 type 渲染内联 SVG，用 data.color 填充；无 data 时取类型语义色并显示首字母
 * Props：type / data / size(sm/md/lg)
 */
import { computed } from 'vue';

const props = defineProps({
  type: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
  size: { type: String, default: 'md' }, // sm | md | lg
});

// 尺寸映射
const SIZE_MAP = { sm: 32, md: 48, lg: 72 };
const px = computed(() => SIZE_MAP[props.size] ?? 48);

// 类型 → 语义色 CSS 变量（无 data 时兜底）
const TYPE_COLOR_VAR = {
  project: '--violet',
  drama: '--violet',
  episode: '--indigo',
  character: '--violet',
  scene: '--green',
  prop: '--amber',
  shot: '--teal',
};

// 类型 → SVG 路径（内联图标，24x24 viewBox）
const ICON_PATHS = {
  project: 'M12 3L2 9v12l10 6 10-6V9L12 3z',           // 文档/项目
  drama: 'M12 3L2 9v12l10 6 10-6V9L12 3z',
  episode: 'M4 4h16v16H4zM8 8h8v8H8z',                   // 电视/剧集
  character: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z', // 用户
  scene: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z', // 场景/地图标记
  prop: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14H6v-2h6v2zm4-8H6V9h10v2zm0 4H6v-2h10v2z', // 盒子/道具
  shot: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z', // 电影/分镜
};

const typeKey = computed(() => (props.type || '').toLowerCase());
const iconPath = computed(() => ICON_PATHS[typeKey.value] || ICON_PATHS.project);

// 显示内容：data.name 首字母，或 type 首字母
const displayChar = computed(() => {
  const name = props.data?.name || props.type;
  return name?.charAt(0)?.toUpperCase() || '?';
});

// 填充色：data.color 优先，否则用 CSS 变量
const fillStyle = computed(() => {
  if (props.data?.color) return props.data.color;
  const varName = TYPE_COLOR_VAR[typeKey.value] || '--violet';
  return `var(${varName})`;
});
</script>

<template>
  <div
    class="node-thumb"
    :style="{ width: `${px}px`, height: `${px}px` }"
    role="img"
    :aria-label="`${props.type}: ${props.data?.name || '未命名'}`"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style="width:100%;height:100%;display:block;"
    >
      <!-- 背景圆/方 -->
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="3"
        :fill="fillStyle"
      />
      <!-- 图标路径 -->
      <path
        :d="iconPath"
        fill="white"
        opacity="0.95"
        transform="scale(0.65) translate(4, 4)"
      />
      <!-- 首字母兜底（当图标为空时显示） -->
      <text
        v-if="!iconPath"
        x="12"
        y="16"
        text-anchor="middle"
        fill="white"
        :font-size="px * 0.55"
        font-weight="600"
        :font-family="fontSans"
      >{{ displayChar }}</text>
    </svg>
  </div>
</template>

<style scoped>
.node-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-node);
  border: 1px solid var(--line);
  background: var(--surface);
  transition: transform var(--t), box-shadow var(--t);
  flex-shrink: 0;
}
.node-thumb:hover {
  transform: scale(1.05);
  box-shadow: var(--s2);
  z-index: 1;
}
.node-thumb:focus-visible {
  outline: none;
  box-shadow: var(--ring), var(--s2);
}
</style>