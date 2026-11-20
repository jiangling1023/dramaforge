/**
 * 三专家冻结配置与解析工具 · 前端唯一真相
 * EXPERTS 值逐字对齐《技术方案》§5.1（与后端 U-013 共用同一份），勿在组件内另行硬编码。
 * 色值走 U-006 语义令牌：--expert-writer/producer/storyboard 与 .msg.exp-w/.exp-p/.exp-s .bub
 */

export const EXPERTS = [
  {
    id: 'writer',
    name: '编剧·老周',
    short: '编剧',
    avatar: '编',
    duty: '剧本改写 / 台词 / 冲突反转',
    color: '#8B5CF6',
    cssClass: 'exp-w',
    colorVar: 'var(--expert-writer)',
    gradVar: 'var(--grad-writer)',
    tools: ['generate.run(script)', 'storyboard.update(result)'],
  },
  {
    id: 'producer',
    name: '制片·老元代',
    short: '制片',
    avatar: '制',
    duty: '资产统筹 / 项目剧集 / 成本',
    color: '#D98B2B',
    cssClass: 'exp-p',
    colorVar: 'var(--expert-producer)',
    gradVar: 'var(--grad-producer)',
    tools: ['project.*', 'generate.run(extract)'],
  },
  {
    id: 'storyboard',
    name: '分镜师·阿镜',
    short: '分镜师',
    avatar: '镜',
    duty: '镜头 / 机位 / 出图出视频',
    color: '#0E9F86',
    cssClass: 'exp-s',
    colorVar: 'var(--expert-storyboard)',
    gradVar: 'var(--grad-storyboard)',
    tools: ['storyboard.*', 'canvas.*', 'generate.run(storyboard)'],
  },
];

/** 能力分工清单：3 组各 2 项，覆盖原全部能力项（AC-005-6），文案取《产品设计说明》§4 V-3-R3 */
export const ABILITY_GROUPS = [
  { expertId: 'writer', items: ['剧本改写', '冲突反转'] },
  { expertId: 'producer', items: ['资产统筹', '项目与剧集'] },
  { expertId: 'storyboard', items: ['镜头设计', '出图与视频'] },
];

const IDS = EXPERTS.map((e) => e.id);
const TAG_RE = /\[expert:(writer|producer|storyboard)\]/i;

export function expertOf(id) {
  return EXPERTS.find((e) => e.id === id) || null;
}

/** 解析回复文本末尾的 [expert:xxx] 标记，返回归属专家 id 与去除标记后的正文 */
export function parseExpertTag(content) {
  const text = typeof content === 'string' ? content : '';
  const m = text.match(TAG_RE);
  return {
    expertId: m ? m[1].toLowerCase() : null,
    content: m ? text.replace(TAG_RE, '').trim() : text,
  };
}

/** 工具卡归类命名：writer.rewriteScript / producer.assetOverview / storyboard.listShots */
export function toolDisplayName(name, expert) {
  if (!name) return 'tool';
  if (String(name).includes('.')) return name;
  return IDS.includes(expert) ? `${expert}.${name}` : name;
}

/** 把工具结果格式化为可读文本；generate_task 展示真实任务引用而非 hint */
export function formatToolResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.slice(0, 300);
  const { type, data } = result;

  if (type === 'generate_task') {
    return `✅ 已创建生成任务 #${result.taskId}，可轮询 /api/pipeline/${result.taskId}`;
  }
  if (!data) return JSON.stringify(result).slice(0, 300);

  if (type === 'characters' && Array.isArray(data)) {
    return data.map((c) => `👤 ${c.name} [${c.role || '未分类'}]\n   ${c.appearance || ''}`).join('\n\n');
  }
  if (type === 'scenes' && Array.isArray(data)) {
    return data.map((s) => `🎬 ${s.location || '未命名'}${s.time_of_day ? ' · ' + s.time_of_day : ''}`).join('\n');
  }
  if (type === 'props' && Array.isArray(data)) {
    return data.map((p) => `📦 ${p.name}`).join('\n');
  }
  if (type === 'episodes' && Array.isArray(data)) {
    return data.map((e) => `第${e.episode_number}集 ${e.title || ''}（${e.storyboard_count || 0}镜）`).join('\n');
  }
  if (type === 'storyboards' && Array.isArray(data)) {
    return data.map((s) => `S${String(s.storyboard_number).padStart(2, '0')} ${s.title || ''} [${s.shot_type || ''}] ${s.duration_sec || 0}秒`).join('\n');
  }
  if (type === 'all_storyboards' && Array.isArray(data)) {
    return data.map((block) =>
      `${block.episode_number}集: ${(block.storyboards || []).map((s) => `S${String(s.storyboard_number).padStart(2, '0')} ${s.title || ''}`).join(' | ')}`
    ).join('\n');
  }
  if (type === 'project_info' && data) {
    return `【${data.title}】题材：${data.genre || '-'} 风格：${data.style || '-'} 受众：${data.audience || '-'}`;
  }
  if (type === 'canvas_nodes' && Array.isArray(data)) {
    return `画布节点 (${data.length}个)：` + data.map((n) => `${n.node_type}:${n.node_id} @(${n.x},${n.y})`).join(', ');
  }
  if (type === 'focus_target') {
    return `聚焦到节点 ${result.node?.node_type}:${result.node?.node_id} → 坐标(${Math.round(result.x)},${Math.round(result.y)}) zoom=${result.zoom}`;
  }
  if (type === 'generate_plan') {
    return `📋 建议生成操作：${result.kind} → 集ID: ${JSON.stringify(result.episodeIds)}\n${result.hint || ''}`;
  }
  return JSON.stringify(result).slice(0, 400);
}
