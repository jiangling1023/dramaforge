<script setup>
/** LogBar · 三视图共用的底部运行日志栏（从 App.vue 抽出） */
defineProps({
  lines: { type: Array, default: () => [] },
  collapsed: { type: Boolean, default: false },
});

// 仅符号着色，正文保持弱文色，避免整屏彩色噪声
const MARK = { info: '·', ok: '✓', warn: '!', err: '×' };
</script>

<template>
  <footer class="logbar" :class="{ collapsed }">
    <div class="lg-h">运行日志 · {{ lines.length }} 条 · 实时</div>
    <div v-if="!collapsed" class="lg-body">
      <div v-for="(l, i) in lines" :key="i" class="line" :class="l.kind || 'info'">
        <span class="ts">{{ l.at || '' }}</span>
        <span class="mark">{{ MARK[l.kind] || '·' }}</span>
        <span class="txt">{{ typeof l === 'string' ? l : l.text }}</span>
      </div>
      <div v-if="!lines.length" class="line">等待操作…</div>
    </div>
  </footer>
</template>

<style scoped>
.logbar {
  height: 116px; flex: 0 0 116px; display: flex; flex-direction: column;
  background: var(--surface2); border-top: 1px solid var(--line);
  font-family: var(--font-mono); font-size: var(--fs-meta); line-height: 1.75;
  overflow: hidden;
}
.logbar.collapsed { height: 32px; flex-basis: 32px; }
.lg-h {
  flex: 0 0 28px; display: flex; align-items: center; padding: 0 var(--sp-4);
  color: var(--ink3); border-bottom: 1px solid var(--line2); letter-spacing: .04em;
}
.lg-body { flex: 1; overflow-y: auto; padding: var(--sp-1h) var(--sp-4); }
.line { display: flex; gap: var(--sp-2); color: var(--ink2); white-space: pre-wrap; word-break: break-word; }
.line .ts { flex: 0 0 62px; color: var(--ink3); }
.line .mark { flex: 0 0 10px; text-align: center; color: var(--indigo); }
.line.ok .mark { color: var(--ok); }
.line.warn .mark { color: var(--warn); }
.line.err .mark { color: var(--err); }
</style>
