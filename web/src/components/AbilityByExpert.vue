<script setup>
/** AbilityByExpert · 能力分工清单：按专家归类，色点对应主题色（覆盖原全部能力项） */
import { ABILITY_GROUPS, expertOf } from '../config/experts.js';

defineProps({
  groups: { type: Array, default: () => ABILITY_GROUPS },
});

const dotColor = (id) => expertOf(id)?.colorVar || 'var(--ink3)';
</script>

<template>
  <section class="ability">
    <div class="hd">能力分工</div>
    <div v-for="g in groups" :key="g.expertId" class="group">
      <div class="group-name">
        <span class="dot" :style="{ background: dotColor(g.expertId) }" />
        {{ expertOf(g.expertId)?.short || g.expertId }}
      </div>
      <ul>
        <li v-for="item in g.items" :key="item">{{ item }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.ability {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: var(--sp-3); box-shadow: var(--s1);
}
.hd { font-size: var(--fs-section); font-weight: 700; color: var(--ink); margin-bottom: var(--sp-3); }
.group { margin-bottom: var(--sp-3); }
.group:last-child { margin-bottom: 0; }
.group-name {
  display: flex; align-items: center; gap: 6px;
  font-size: var(--fs-node); font-weight: 600; color: var(--ink2); margin-bottom: 6px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink3); }
ul { list-style: none; margin: 0; padding: 0 0 0 14px; display: flex; flex-wrap: wrap; gap: 4px 8px; }
li { font-size: var(--fs-label); color: var(--ink2); }
li::before { content: '·'; margin-right: 4px; color: var(--ink3); }
</style>
