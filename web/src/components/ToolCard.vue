<script setup>
/** ToolCard · 工具调用结果卡：标题栏(专家归类命名) + 结果体 + 状态标；generate_task 展示真实任务引用 */
import { computed } from 'vue';
import { expertOf, formatToolResult } from '../config/experts.js';

const props = defineProps({
  name: { type: String, default: '' },
  result: { type: [String, Object], default: '' },
  status: { type: String, default: 'done' }, // done | error | pending
  expert: { type: String, default: null },
});

const info = computed(() => expertOf(props.expert));
const accent = computed(() => info.value?.colorVar || 'var(--indigo)');
const isGenerateTask = computed(() => props.result && typeof props.result === 'object' && props.result.type === 'generate_task');
const display = computed(() => (typeof props.result === 'string' ? props.result : formatToolResult(props.result)));
</script>

<template>
  <div class="tool-card" :style="{ borderColor: accent }">
    <div class="tool-hdr" :style="{ background: accent }">
      <span class="tool-icon">{{ status === 'error' ? '⚠️' : '⚙️' }}</span>
      <span class="tool-name mono">{{ name }}</span>
      <span v-if="status === 'done'" class="tool-status">✓完成</span>
      <span v-else-if="status === 'error'" class="tool-status err">失败</span>
      <span v-else class="tool-status pending">处理中</span>
    </div>
    <div class="tool-body" :class="{ err: status === 'error' }">
      <template v-if="isGenerateTask">
        ✅ 已创建生成任务 #{{ result.taskId }}，可轮询
        <span class="task-link mono">/api/pipeline/{{ result.taskId }}</span>
      </template>
      <template v-else>{{ display }}</template>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  align-self: flex-start; width: 100%; border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden; font-size: var(--fs-label);
  background: var(--surface2);
}
.tool-hdr {
  display: flex; align-items: center; gap: 6px; padding: 5px 10px;
  color: #fff; font-weight: 600;
}
.tool-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-status { font-size: var(--fs-label); opacity: .92; }
.tool-status.err { color: #fff; }
.tool-status.pending { opacity: .85; }
.tool-body {
  padding: 8px 10px; color: var(--ink2); white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow-y: auto; line-height: 1.5;
}
.tool-body.err { color: var(--err); }
.task-link { color: var(--indigo); }
</style>
