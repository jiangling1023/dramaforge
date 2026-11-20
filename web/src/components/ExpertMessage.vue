<script setup>
/** ExpertMessage · 专家发言气泡：发言人标(头像+姓名+职责tag) + 主题色气泡；解析 [expert:xxx] */
import { computed } from 'vue';
import { expertOf, parseExpertTag } from '../config/experts.js';

const props = defineProps({
  expert: { type: String, default: null },
  content: { type: String, default: '' },
  time: { type: [Number, String], default: null },
});

// 文本中的 [expert:xxx] 标记优先，其次用传入的 expert，保证不自行编造归属
const parsed = computed(() => parseExpertTag(props.content));
const expertId = computed(() => parsed.value.expertId || props.expert);
const info = computed(() => expertOf(expertId.value));
const text = computed(() => parsed.value.content);
const clock = computed(() => {
  if (!props.time) return '';
  const d = new Date(props.time);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
});
</script>

<template>
  <div class="msg" :class="info ? info.cssClass : ''">
    <div v-if="info" class="sender">
      <span class="avatar" :style="{ background: info.gradVar }">{{ info.avatar }}</span>
      <span class="who">{{ info.name }}</span>
      <span class="tag" :style="{ color: info.colorVar }">{{ info.duty }}</span>
    </div>
    <div class="bub">{{ text }}</div>
    <div v-if="clock" class="ts">{{ clock }}</div>
  </div>
</template>

<style scoped>
.msg { display: flex; flex-direction: column; align-self: flex-start; max-width: 92%; }
.sender { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.avatar {
  width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  color: #fff; font-size: var(--fs-label); font-weight: 700;
}
.who { font-size: var(--fs-label); font-weight: 700; color: var(--ink); }
.tag {
  font-size: var(--fs-label); padding: 1px 6px; border-radius: var(--r-tag);
  background: var(--surface2); border: 1px solid var(--line2);
}
/* 气泡主题色复用 U-006 的 .msg.exp-w/.exp-p/.exp-s .bub 令牌；此处仅补布局圆角 */
.bub {
  padding: 9px 13px; border-radius: 12px; border-bottom-left-radius: 4px;
  font-size: var(--fs-node); line-height: 1.6; white-space: pre-wrap; word-break: break-word;
}
.ts { font-size: var(--fs-label); color: var(--ink3); margin-top: 4px; }
</style>
