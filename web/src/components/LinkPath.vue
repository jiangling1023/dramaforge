<script setup>
/** 贝塞尔连线（world 层 SVG 内），按集 emphasis/opacity 控制凸显 */
defineProps({
  from: { type: Object, required: true }, // { x, y }
  to: { type: Object, required: true },   // { x, y }
  color: { type: String, default: '#98A1AE' },
  opacity: { type: Number, default: 0.32 },
  emphasis: { type: Boolean, default: false },
});
</script>

<template>
  <g :opacity="opacity">
    <path
      :d="`M${from.x},${from.y} C${(from.x + to.x) / 2},${from.y} ${(from.x + to.x) / 2},${to.y} ${to.x},${to.y}`"
      :stroke="color" :stroke-width="emphasis ? 2.2 : 1.3" fill="none"
    />
    <circle :cx="to.x" :cy="to.y" :r="emphasis ? 3.6 : 2.4" :fill="color" />
  </g>
</template>
