<script setup>
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { api } from '../api/index.js';
import ExpertSwitcher from './ExpertSwitcher.vue';
import ExpertMessage from './ExpertMessage.vue';
import ToolCard from './ToolCard.vue';
import { EXPERTS, parseExpertTag, toolDisplayName } from '../config/experts.js';

const props = defineProps({ dramaId: Number, episodeId: Number });
const emit = defineEmits(['close']);

const messages = ref([]);
const input = ref('');
const loading = ref(false);
const activeExpert = ref(EXPERTS[0].id);
// 由 App 用 v-if 控制渲染：组件一旦挂载即为打开状态
const panelOpen = ref(true);

const canSend = computed(() => !!input.value.trim() && !loading.value);
const quickAsks = ['列出所有角色', '拆解分镜', '合成整集视频'];

/** 欢迎语 + 滚动到底 */
async function greet() {
  if (!messages.value.length && props.dramaId) {
    messages.value.push({
      role: 'system',
      content: '专家团已就位：编剧·老周（剧本改写/台词/冲突反转）、制片·老元代（资产统筹/项目剧集/成本）、分镜师·阿镜（镜头/机位/出图出视频）。\n试着下达指令，例如「列出所有角色」或「改写第1集剧本」。',
      ts: Date.now(),
    });
    await nextTick();
    scrollBottom();
  }
}

onMounted(greet);

async function send(text) {
  const content = (typeof text === 'string' ? text : input.value).trim();
  if (!content || loading.value) return;
  input.value = '';
  messages.value.push({ role: 'user', content, expert: activeExpert.value, ts: Date.now() });

  loading.value = true;
  try {
    const history = messages.value
      .filter((m) => m.role !== 'pending' && m.role !== 'collab')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    // 透传 activeExpert 给后端 buildSystemPrompt，让 persona 按专家身份发言
    const res = await api.chat(props.dramaId, props.episodeId, content, history, activeExpert.value);
    const reply = res.reply || '(无回复)';
    const toolCalls = Array.isArray(res.toolCalls) ? res.toolCalls : [];

    // 解析文本末尾 [expert:xxx] 标记 → 发言人标与主题色
    const { expertId, content: clean } = parseExpertTag(reply);
    messages.value.push({ role: 'assistant', content: clean, expert: expertId, ts: Date.now() });

    for (const tc of toolCalls) {
      const result = tc.result;
      const failed = tc.status === 'error' || result?.error || result?.success === false;
      if (failed) {
        // E-11：工具失败以系统气泡呈现，不中断对话
        messages.value.push({
          role: 'system',
          content: '工具调用失败：' + ((result && result.error) || tc.error || '未知错误'),
          ts: Date.now(),
        });
        continue;
      }
      messages.value.push({
        role: 'tool',
        name: toolDisplayName(tc.name, tc.expert),
        result,
        status: 'done',
        expert: tc.expert,
        ts: Date.now(),
      });
    }
  } catch (e) {
    messages.value.push({ role: 'system', content: '错误：' + e.message, ts: Date.now() });
  } finally {
    loading.value = false;
    await nextTick();
    scrollBottom();
  }
}

function switchExpert(id) { activeExpert.value = id; }

function scrollBottom() {
  const el = document.querySelector('.chat-body');
  if (el) el.scrollTop = el.scrollHeight;
}

watch(() => props.dramaId, async () => {
  messages.value = [];
  await greet();
}, { immediate: false });

function closePanel() { emit('close'); }
</script>

<template>
  <transition name="slide">
    <div v-if="panelOpen" class="panel">
      <div class="panel-hdr">
        <span class="title">🤖 专家团</span>
        <button class="close" @click="closePanel">✕</button>
      </div>
      <ExpertSwitcher
        :experts="EXPERTS"
        :active-id="activeExpert"
        :collaborating="loading"
        compact
        @switch="switchExpert"
      />
      <div class="quick">
        <button v-for="q in quickAsks" :key="q" :disabled="loading" @click="send(q)">{{ q }}</button>
      </div>
      <div class="chat-body">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <ToolCard
            v-if="m.role === 'tool'"
            :name="m.name"
            :result="m.result"
            :status="m.status"
            :expert="m.expert"
          />
          <ExpertMessage
            v-else-if="m.role === 'assistant'"
            :expert="m.expert"
            :content="m.content"
            :time="m.ts"
          />
          <template v-else>
            <div class="bubble">{{ m.content }}</div>
            <div class="ts">{{ new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</div>
          </template>
        </div>
        <div v-if="loading" class="msg collab">
          <div class="mini-avatars">
            <span v-for="e in EXPERTS" :key="e.id" :style="{ background: e.gradVar }">{{ e.avatar }}</span>
          </div>
          <span>三位专家正在协作处理…</span>
        </div>
      </div>
      <div class="chat-input">
        <input v-model="input" @keydown.enter.prevent="send()" placeholder="向专家团下指令…" :disabled="loading" />
        <button :disabled="!canSend" @click="send()">{{ loading ? '思考中…' : '发送' }}</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }

.panel {
  position: absolute; right: 0; top: 0; bottom: 0;
  width: 312px; background: var(--panel); border-left: 1px solid var(--line);
  display: flex; flex-direction: column; z-index: 100; overflow: hidden;
}
.panel-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
}
.panel-hdr .title { font-size: var(--fs-title); font-weight: 700; color: var(--ink); }
.panel-hdr .close { color: var(--ink3); font-size: 16px; padding: 4px 8px; }
.panel-hdr .close:hover { color: var(--ink); }

.panel > :deep(.expert-switcher) { padding: 10px 12px 6px; border-bottom: 1px solid var(--line2); }
.quick { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line2); }
.quick button {
  font-size: var(--fs-label); padding: 4px 10px; border-radius: var(--r-pill);
  color: var(--coral); background: var(--coralS); border: 1px solid var(--line);
}
.quick button:hover:not(:disabled) { border-color: var(--coral); }
.quick button:disabled { opacity: .5; cursor: not-allowed; }

.chat-body {
  flex: 1; overflow-y: auto; padding: 12px;
  display: flex; flex-direction: column; gap: 12px;
}
.msg { display: flex; flex-direction: column; max-width: 94%; }
.msg.user { align-self: flex-end; }
.msg.system { align-self: flex-start; }
.msg.user .bubble {
  background: var(--coral); color: #fff; border-radius: 12px; border-bottom-right-radius: 4px;
}
.msg.system .bubble {
  background: var(--surface2); color: var(--ink2); border: 1px solid var(--line);
  border-radius: 12px; border-bottom-left-radius: 4px; font-size: var(--fs-label);
}
.bubble {
  padding: 9px 12px; font-size: var(--fs-node); line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.ts { font-size: var(--fs-label); color: var(--ink3); margin-top: 4px; }
.collab {
  align-self: center; flex-direction: row; align-items: center; gap: var(--sp-2);
  font-size: var(--fs-label); color: var(--ink2); background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--r-pill); padding: 6px 12px;
}
.mini-avatars { display: flex; }
.mini-avatars span {
  width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
  color: #fff; font-size: var(--fs-label); border: 2px solid var(--surface); margin-left: -5px;
}
.mini-avatars span:first-child { margin-left: 0; }

.chat-input { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); }
.chat-input input {
  flex: 1; min-width: 0; background: var(--surface2); border: 1px solid var(--line);
  border-radius: var(--rs); padding: 9px 12px; color: var(--ink); font-size: var(--fs-node); outline: none;
}
.chat-input input:focus { border-color: var(--coral); box-shadow: var(--ring); }
.chat-input input:disabled { opacity: .5; }
.chat-input button {
  background: var(--grad-primary); color: #fff; border-radius: var(--rs);
  padding: 0 14px; font-size: var(--fs-node); font-weight: 600;
}
.chat-input button:disabled { opacity: .45; cursor: not-allowed; }
</style>
