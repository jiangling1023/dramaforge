<script setup>
/** AssistantView · 智能助手全宽视图：对话流 + 能力清单 + 输入；受控组件，收发经事件 */
import { ref, computed, nextTick, watch } from 'vue';
import ExpertSwitcher from '../components/ExpertSwitcher.vue';
import ExpertMessage from '../components/ExpertMessage.vue';
import AbilityByExpert from '../components/AbilityByExpert.vue';
import ToolCard from '../components/ToolCard.vue';
import { EXPERTS, ABILITY_GROUPS } from '../config/experts.js';

const props = defineProps({
  messages: { type: Array, default: () => [] },
  experts: { type: Array, default: () => EXPERTS },
  loading: { type: Boolean, default: false },
  abilityGroups: { type: Array, default: () => ABILITY_GROUPS },
});
const emit = defineEmits(['send', 'switch-expert']);

const activeId = ref(props.experts[0]?.id || 'writer');
const input = ref('');
const bodyEl = ref(null);
const canSend = computed(() => !!input.value.trim() && !props.loading);

function doSend() {
  const text = input.value.trim();
  if (!text || props.loading) return;
  input.value = '';
  emit('send', { text, expertId: activeId.value });
}
function onSwitch(id) {
  activeId.value = id;
  emit('switch-expert', id);
}
async function scrollBottom() {
  await nextTick();
  if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
}
watch(() => props.messages.length, scrollBottom);
watch(() => props.loading, scrollBottom);
</script>

<template>
  <div class="assistant-view">
    <header class="av-head">
      <div class="titles">
        <span class="brand">专家团</span>
        <span class="sub">3 位在线</span>
      </div>
      <ExpertSwitcher
        :experts="experts"
        :active-id="activeId"
        :collaborating="loading"
        @switch="onSwitch"
      />
    </header>

    <div class="av-body">
      <div ref="bodyEl" class="stream">
        <template v-for="(m, i) in messages" :key="i">
          <div v-if="m.role === 'user'" class="msg user">
            <div class="bub">{{ m.content }}</div>
          </div>
          <div v-else-if="m.role === 'system'" class="msg system">
            <div class="bub">{{ m.content }}</div>
          </div>
          <div v-else-if="m.role === 'collab'" class="msg collab">
            <div class="mini-avatars">
              <span v-for="e in experts" :key="e.id" :style="{ background: e.gradVar }">{{ e.avatar }}</span>
            </div>
            <span>三位专家正在协作处理…</span>
          </div>
          <ToolCard
            v-else-if="m.role === 'tool'"
            :name="m.name || m.toolName"
            :result="m.result !== undefined ? m.result : m.content"
            :status="m.status || 'done'"
            :expert="m.expert"
          />
          <ExpertMessage
            v-else-if="m.role === 'assistant'"
            :expert="m.expert"
            :content="m.content"
            :time="m.ts"
          />
        </template>
        <div v-if="loading" class="msg system"><div class="bub typing">思考中…</div></div>
      </div>

      <aside class="side"><AbilityByExpert :groups="abilityGroups" /></aside>
    </div>

    <div class="av-input">
      <input
        v-model="input"
        placeholder="向专家团下达指令…"
        :disabled="loading"
        @keydown.enter.prevent="doSend"
      />
      <button :disabled="!canSend" @click="doSend">{{ loading ? '思考中…' : '发送' }}</button>
    </div>
  </div>
</template>

<style scoped>
.assistant-view {
  display: flex; flex-direction: column; height: 100%;
  background: var(--paper); color: var(--ink);
}
.av-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--line); background: var(--surface);
}
.titles { display: flex; align-items: baseline; gap: var(--sp-2); }
.brand { font-size: var(--fs-title); font-weight: 700; }
.sub { font-size: var(--fs-label); color: var(--ink3); }
.av-body { flex: 1; display: flex; min-height: 0; }
.stream {
  flex: 1; overflow-y: auto; padding: var(--sp-4);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
.side { flex: 0 0 240px; padding: var(--sp-4) var(--sp-4) 0 0; overflow-y: auto; }

.msg { display: flex; flex-direction: column; max-width: 92%; }
.msg.user { align-self: flex-end; }
.msg.user .bub {
  background: var(--coral); color: #fff; border-radius: 12px; border-bottom-right-radius: 4px;
}
.msg.system { align-self: flex-start; }
.msg.system .bub {
  background: var(--surface2); color: var(--ink2); border: 1px solid var(--line);
  border-radius: 12px; border-bottom-left-radius: 4px; font-size: var(--fs-label);
}
.bub {
  padding: 9px 13px; font-size: var(--fs-node); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.typing { opacity: .6; font-style: italic; }
.collab {
  align-self: center; flex-direction: row; align-items: center; gap: var(--sp-2);
  font-size: var(--fs-label); color: var(--ink2); background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--r-pill); padding: 6px 14px; box-shadow: var(--s1);
}
.mini-avatars { display: flex; }
.mini-avatars span {
  width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
  color: #fff; font-size: var(--fs-label); border: 2px solid var(--surface); margin-left: -6px;
}
.mini-avatars span:first-child { margin-left: 0; }

.av-input {
  display: flex; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--line); background: var(--surface);
}
.av-input input {
  flex: 1; background: var(--surface2); border: 1px solid var(--line); border-radius: var(--rs);
  padding: 10px 14px; color: var(--ink); font-size: var(--fs-node); outline: none;
}
.av-input input:focus { border-color: var(--coral); box-shadow: var(--ring); }
.av-input input:disabled { opacity: .5; }
.av-input button {
  background: var(--grad-primary); color: #fff; border-radius: var(--rs);
  padding: 0 20px; font-size: var(--fs-node); font-weight: 600;
}
.av-input button:disabled { opacity: .45; cursor: not-allowed; }
</style>
