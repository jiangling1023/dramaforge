<script setup>
/** ExpertSwitcher · 三专家切换条 + 协作状态条；compact 形态只留头像+简称 */
import { EXPERTS } from '../config/experts.js';

const props = defineProps({
  experts: { type: Array, default: () => EXPERTS },
  activeId: { type: String, default: 'writer' },
  collaborating: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(['switch']);
</script>

<template>
  <div class="expert-switcher" :class="{ compact }">
    <div class="cards">
      <button
        v-for="e in experts"
        :key="e.id"
        type="button"
        class="expert-card"
        :class="[{ on: e.id === activeId }, e.cssClass]"
        :title="`${e.name} · ${e.duty}`"
        :aria-pressed="e.id === activeId"
        @click="emit('switch', e.id)"
      >
        <span class="avatar" :style="{ background: e.gradVar }">{{ e.avatar }}</span>
        <span class="meta">
          <span class="name">{{ compact ? e.short : e.name }}</span>
          <span v-if="!compact" class="duty">{{ e.duty }}</span>
        </span>
        <span class="dot" :class="{ busy: collaborating }" />
      </button>
    </div>
    <transition name="fade">
      <div v-if="collaborating" class="collab-chip">
        <span class="wave"><i /><i /><i /><i /></span>
        <span>专家协作中</span>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.expert-switcher { display: flex; align-items: center; gap: var(--sp-3); }
.cards { display: flex; gap: var(--sp-2); flex-wrap: wrap; }

.expert-card {
  display: flex; align-items: center; gap: var(--sp-2);
  min-width: 0; padding: var(--sp-1h) var(--sp-2h);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--rs); text-align: left;
  transition: transform var(--t), box-shadow var(--t), border-color var(--t), background var(--t);
}
.expert-card:hover { transform: translateY(-1px); box-shadow: var(--s1); }
.expert-card:focus-visible { outline: none; box-shadow: var(--ring); }
.expert-card.on { border-color: var(--coral); background: var(--coralS); box-shadow: var(--ring); }

.avatar {
  flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center; color: #fff; font-size: var(--fs-body); font-weight: 700;
}
.meta { display: flex; flex-direction: column; min-width: 0; }
.name { font-size: var(--fs-node); font-weight: 600; color: var(--ink); white-space: nowrap; }
.duty { font-size: var(--fs-label); color: var(--ink3); white-space: nowrap; }
.dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.dot.busy { background: var(--amber); }

.collab-chip {
  display: inline-flex; align-items: center; gap: var(--sp-1h);
  font-size: var(--fs-label); color: var(--amber); white-space: nowrap;
}
.wave { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.wave i { width: 2px; height: 4px; background: var(--amber); border-radius: 2px; animation: bounce 900ms ease-in-out infinite; }
.wave i:nth-child(2) { animation-delay: 120ms; }
.wave i:nth-child(3) { animation-delay: 240ms; }
.wave i:nth-child(4) { animation-delay: 360ms; }
@keyframes bounce { 0%, 100% { height: 3px; } 50% { height: 12px; } }
.fade-enter-active, .fade-leave-active { transition: opacity var(--t); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 停靠面板精简形态：头像+简称即可 */
.compact .expert-card { padding: 3px 6px; gap: 4px; }
.compact .avatar { width: 20px; height: 20px; font-size: var(--fs-label); }
.compact .name { font-size: var(--fs-label); }
</style>
