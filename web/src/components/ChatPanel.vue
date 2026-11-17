<script setup>
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { api } from '../api/index.js';

const props = defineProps({ dramaId: Number, episodeId: Number });
const emit = defineEmits(['close']);

const messages = ref([]);
const input = ref('');
const loading = ref(false);
// 由 App 用 v-if 控制渲染：组件一旦挂载即为打开状态
const panelOpen = ref(true);

const canSend = computed(() => !!input.value.trim() && !loading.value);

/** 欢迎语 + 滚动到底 */
async function greet() {
  if (!messages.value.length && props.dramaId) {
    messages.value.push({
      role: 'system',
      content: '你好！我是 DramaForge 智能助手。我可以帮你：\n• 查看/修改角色、场景、道具\n• 拆解分镜、生成剧本\n• 操作无限画布\n\n试着对我说："列出所有角色" 或 "生成第1集剧本"',
      ts: Date.now(),
    });
    await nextTick();
    scrollBottom();
  }
}

onMounted(greet);

async function send() {
  const text = input.value.trim();
  if (!text || loading.value) return;
  input.value = '';
  messages.value.push({ role: 'user', content: text, ts: Date.now() });

  loading.value = true;
  try {
    const history = messages.value
      .filter(m => m.role !== 'pending')
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));

    const res = await api.chat(props.dramaId, props.episodeId, text, history);
    const reply = res.reply || '(无回复)';
    const toolCalls = Array.isArray(res.toolCalls) ? res.toolCalls : [];

    // 先插入助手文本
    messages.value.push({ role: 'assistant', content: reply, ts: Date.now() });
    // 再逐个插入工具调用卡片
    for (const tc of toolCalls) {
      messages.value.push({
        role: 'tool',
        toolName: tc.name,
        content: formatToolResult(tc.result),
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

/** 把工具结果格式化为可读文本 */
function formatToolResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.slice(0, 300);
  // 结构化结果：取 data 字段
  const { type, data } = result;
  if (!data) return JSON.stringify(result).slice(0, 300);

  if (type === 'characters' && Array.isArray(data)) {
    return data.map(c => `👤 ${c.name} [${c.role || '未分类'}]\n   ${c.appearance || ''}`).join('\n\n');
  }
  if (type === 'scenes' && Array.isArray(data)) {
    return data.map(s => `🎬 ${s.location || '未命名'}${s.time_of_day ? ' · ' + s.time_of_day : ''}`).join('\n');
  }
  if (type === 'props' && Array.isArray(data)) {
    return data.map(p => `📦 ${p.name}`).join('\n');
  }
  if (type === 'episodes' && Array.isArray(data)) {
    return data.map(e => `第${e.episode_number}集 ${e.title || ''}（${e.storyboard_count || 0}镜）`).join('\n');
  }
  if (type === 'storyboards' && Array.isArray(data)) {
    return data.map(s => `S${String(s.storyboard_number).padStart(2,'0')} ${s.title||''} [${s.shot_type||''}] ${s.duration_sec||0}秒`).join('\n');
  }
  if (type === 'all_storyboards' && Array.isArray(data)) {
    return data.map(block =>
      `${block.episode_number}集: ${(block.storyboards||[]).map(s=>`S${String(s.storyboard_number).padStart(2,'0')} ${s.title||''}`).join(' | ')}`
    ).join('\n');
  }
  if (type === 'project_info' && data) {
    return `【${data.title}】题材：${data.genre || '-'} 风格：${data.style || '-'} 受众：${data.audience || '-'}`;
  }
  if (type === 'canvas_nodes' && Array.isArray(data)) {
    return `画布节点 (${data.length}个)：` + data.map(n => `${n.node_type}:${n.node_id} @(${n.x},${n.y})`).join(', ');
  }
  if (type === 'focus_target') {
    return `聚焦到节点 ${result.node?.node_type}:${result.node?.node_id} → 坐标(${Math.round(result.x)},${Math.round(result.y)}) zoom=${result.zoom}`;
  }
  if (type === 'generate_plan') {
    return `📋 建议生成操作：${result.kind} → 集ID: ${JSON.stringify(result.episodeIds)}\n${result.hint || ''}`;
  }
  return JSON.stringify(result).slice(0, 400);
}

function scrollBottom() {
  const el = document.querySelector('.chat-body');
  if (el) el.scrollTop = el.scrollHeight;
}

watch(() => props.dramaId, async () => {
  // 切换项目时重置对话，重新生成欢迎语
  messages.value = [];
  await greet();
}, { immediate: false });

function closePanel() { emit('close'); }
</script>

<template>
  <transition name="slide">
    <div v-if="panelOpen" class="panel">
      <div class="panel-hdr">
        <span class="title">🤖 智能助手</span>
        <button class="close" @click="closePanel">✕</button>
      </div>
      <div class="chat-body">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <!-- 工具调用卡片 -->
          <div v-if="m.role === 'tool'" class="tool-card">
            <div class="tool-hdr">
              <span class="tool-icon">⚙️</span>
              <span class="tool-name">{{ m.toolName }}</span>
            </div>
            <div class="tool-body">{{ m.content }}</div>
          </div>
          <!-- 普通消息气泡 -->
          <template v-else>
            <div class="bubble">{{ m.content }}</div>
            <div class="ts">{{ new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</div>
          </template>
        </div>
        <div v-if="loading" class="msg assistant">
          <div class="bubble typing">思考中…</div>
        </div>
      </div>
      <div class="chat-input">
        <input v-model="input" @keydown.enter.prevent="send" placeholder="输入消息…" :disabled="loading" />
        <button :disabled="!canSend" @click="send">发送</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }

.panel {
  position: absolute; right: 0; top: 0; bottom: 0;
  width: 400px; background: #12141c; border-left: 1px solid rgba(255,255,255,.08);
  display: flex; flex-direction: column; z-index: 100;
}
.panel-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,.08);
}
.panel-hdr .title { font-size: 14px; font-weight: 600; color: #eef1f7; }
.panel-hdr .close {
  background: none; border: none; color: rgba(255,255,255,.4); cursor: pointer;
  font-size: 16px; padding: 4px 8px;
}
.panel-hdr .close:hover { color: #fff; }
.chat-body {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.msg { display: flex; flex-direction: column; max-width: 92%; }
.msg.user { align-self: flex-end; }
.msg.assistant, .msg.system, .msg.tool { align-self: flex-start; }
.bubble {
  padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.user .bubble { background: rgba(74, 158, 255, .2); color: #c8e0ff; border-bottom-right-radius: 4px; }
.assistant .bubble { background: rgba(255, 255, 255, .06); color: #dfe4ee; border-bottom-left-radius: 4px; }
.system .bubble { background: rgba(255, 176, 32, .1); color: #ffd580; border-bottom-left-radius: 4px; font-size: 12px; }
.typing { opacity: .6; font-style: italic; }
.ts { font-size: 10px; color: rgba(255,255,255,.25); margin-top: 4px; }

/* 工具调用卡片 */
.tool-card {
  background: rgba(74, 158, 255, .08);
  border: 1px solid rgba(74, 158, 255, .2);
  border-radius: 10px; overflow: hidden;
  font-size: 12px; width: 100%;
}
.tool-hdr {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  background: rgba(74, 158, 255, .12);
  color: #7ab8ff; font-weight: 500;
  font-family: ui-monospace, "Noto Sans Mono", monospace;
}
.tool-body {
  padding: 8px 12px;
  color: #b8c4d8;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  line-height: 1.5;
}

.chat-input {
  display: flex; gap: 8px; padding: 12px 16px;
  border-top: 1px solid rgba(255,255,255,.08);
}
.chat-input input {
  flex: 1; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px; padding: 10px 14px; color: #eef1f7; font-size: 13px;
  outline: none;
}
.chat-input input:focus { border-color: rgba(74, 158, 255, .5); }
.chat-input input:disabled { opacity: .5; }
.chat-input button {
  background: rgba(74, 158, 255, .2); border: none; border-radius: 8px;
  padding: 0 18px; color: #7ab8ff; font-size: 13px; cursor: pointer;
}
.chat-input button:hover:not(:disabled) { background: rgba(74, 158, 255, .35); }
.chat-input button:disabled { opacity: .4; cursor: not-allowed; }
</style>
