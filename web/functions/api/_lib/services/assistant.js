/**
 * 智能助手 · 工具集（Workers 版）
 *
 * 与 Node 版的差异：
 *   1. 所有工具改为 async，因为底层是 PostgREST 网络查询
 *   2. 移除 db.query 工具 —— PostgREST 无法执行任意 SQL，保留它只会让模型误用
 */

import { plain, plainAll, parseJson, now } from '../db.js';
import { create as createPipeline } from './pipeline.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/* ===== 三专家配置（冻结 §5.1，前端 U-014 逐字复用） ===== */
export const EXPERTS = {
  writer: {
    id: 'writer', name: '编剧·老周', role: '剧本改写 / 台词 / 冲突反转',
    color: '#8B5CF6', tools: ['generate.run(script)', 'storyboard.update(result)'],
  },
  producer: {
    id: 'producer', name: '制片·老元代', role: '资产统筹 / 项目剧集 / 成本',
    color: '#D98B2B', tools: ['project.*', 'generate.run(extract)'],
  },
  storyboard: {
    id: 'storyboard', name: '分镜师·阿镜', role: '镜头 / 机位 / 出图出视频',
    color: '#0E9F86', tools: ['storyboard.*', 'canvas.*', 'generate.run(storyboard)'],
  },
};

const EXPERT_PERSONAS = {
  writer: '你是编剧·老周，负责剧本改写/台词/冲突反转，优先用 generate.run(kind=script)、storyboard.update(result)',
  producer: '你是制片·老元代，负责资产统筹/项目剧集/成本，优先用 project.*、generate.run(kind=extract)',
  storyboard: '你是分镜师·阿镜，负责镜头/机位/出图出视频，优先用 storyboard.*、canvas.*、generate.run(kind=storyboard)',
};

/** 单一基座 + persona 注入（不传 expertId 则模型按内容自决） */
export function buildSystemPrompt(expertId) {
  const persona = EXPERT_PERSONAS[expertId];
  return persona ? `${ASSISTANT_SYSTEM}\n\n【当前专家 persona】\n${persona}` : ASSISTANT_SYSTEM;
}

/** 工具 → 专家映射（generate.run 按 kind、storyboard.update 按 result 字段细分） */
export function expertForTool(name, params = {}) {
  if (name === 'generate.run') {
    return { script: 'writer', extract: 'producer', storyboard: 'storyboard' }[params.kind] || null;
  }
  if (name === 'storyboard.update') return params.result !== undefined ? 'writer' : 'storyboard';
  if (name.startsWith('project.')) return 'producer';
  if (name.startsWith('canvas.')) return 'storyboard';
  if (name.startsWith('storyboard.')) return 'storyboard';
  return null;
}

export function buildTools(db) {
  return (dramaId, episodeId) => ({
    /* -------- 画布操作 -------- */
    'canvas.list_nodes': async () => {
      const rows = await db.select('canvas_layout', { drama_id: dramaId }, { order: 'z_index.asc' });
      return { type: 'canvas_nodes', data: plainAll(rows) };
    },

    'canvas.create_node': async (params) => {
      const { node_type, node_id, x = 0, y = 0, w = 280, h = 160, collapsed = false } = params || {};
      if (!node_type || !node_id) throw new Error('缺少 node_type 或 node_id');
      await db.upsert('canvas_layout', {
        drama_id: dramaId, node_type, node_id: Number(node_id),
        x, y, w, h, z_index: Date.now(), collapsed: collapsed ? 1 : 0, updated_at: now(),
      }, 'drama_id,node_type,node_id');
      return { type: 'node_created', node_type, node_id: Number(node_id), x, y, w, h };
    },

    'canvas.update_node': async (params) => {
      const { node_id, node_type, x, y, w, h, collapsed } = params || {};
      if (!node_id) throw new Error('缺少 node_id');
      const patch = {};
      if (x !== undefined) patch.x = x;
      if (y !== undefined) patch.y = y;
      if (w !== undefined) patch.w = w;
      if (h !== undefined) patch.h = h;
      if (collapsed !== undefined) patch.collapsed = collapsed ? 1 : 0;
      if (!Object.keys(patch).length) throw new Error('没有可更新字段');
      patch.updated_at = now();
      await db.update('canvas_layout',
        { drama_id: dramaId, node_type, node_id: Number(node_id) }, patch);
      return { type: 'node_updated', node_id: Number(node_id) };
    },

    'canvas.focus': async (params) => {
      const { node_type, node_id } = params || {};
      if (!node_type || !node_id) throw new Error('缺少 node_type 或 node_id');
      const row = await db.first('canvas_layout',
        { drama_id: dramaId, node_type, node_id: Number(node_id) },
        { columns: 'x,y,w,h' });
      if (!row) throw new Error(`节点不存在：${node_type}:${node_id}`);
      // 返回目标坐标，前端可以把相机移到 (x + w/2, y + h/2)
      return {
        type: 'focus_target',
        x: (row.x || 0) + (row.w || 280) / 2,
        y: (row.y || 0) + (row.h || 160) / 2,
        zoom: 1.2,
        node: { node_type, node_id: Number(node_id), x: row.x, y: row.y },
      };
    },

    /* -------- 项目数据 -------- */
    'project.info': async () => {
      const d = await db.first('dramas', { id: dramaId, deleted_at__is: null });
      if (!d) throw new Error('项目不存在');
      return { type: 'project_info', data: { ...plain(d), tags: parseJson(d.tags, []) } };
    },

    'project.episodes': async () => {
      const rows = plainAll(await db.select('episodes',
        { drama_id: dramaId, deleted_at__is: null }, { order: 'episode_number.asc' }));
      const ids = rows.map((e) => e.id);
      const sbs = ids.length
        ? await db.select('storyboards', { episode_id__in: ids }, { columns: 'episode_id' })
        : [];
      const counts = new Map();
      for (const s of sbs) counts.set(s.episode_id, (counts.get(s.episode_id) || 0) + 1);
      return {
        type: 'episodes',
        data: rows.map((e) => ({ ...e, storyboard_count: counts.get(e.id) || 0 })),
      };
    },

    'project.characters': async () => {
      const rows = await db.select('characters',
        { drama_id: dramaId, deleted_at__is: null }, { order: 'sort_order.asc,id.asc' });
      return {
        type: 'characters',
        data: plainAll(rows).map((c) => ({ ...c, reference_images: parseJson(c.reference_images, []) })),
      };
    },

    'project.scenes': async () => {
      const rows = await db.select('scenes',
        { drama_id: dramaId, deleted_at__is: null }, { order: 'id.asc' });
      return { type: 'scenes', data: plainAll(rows) };
    },

    'project.props': async () => {
      const rows = await db.select('props',
        { drama_id: dramaId, deleted_at__is: null }, { order: 'id.asc' });
      return { type: 'props', data: plainAll(rows) };
    },

    /* -------- 分镜 -------- */
    'storyboard.list': async (params) => {
      const epId = params?.episode_id;
      if (!epId) {
        const eps = plainAll(await db.select('episodes',
          { drama_id: dramaId, deleted_at__is: null },
          { columns: 'id,episode_number,title', order: 'episode_number.asc' }));
        const ids = eps.map((e) => e.id);
        const sbs = ids.length
          ? await db.select('storyboards', { episode_id__in: ids }, { order: 'storyboard_number.asc' })
          : [];
        const out = eps.map((ep) => ({
          episode_id: ep.id, episode_number: ep.episode_number,
          storyboards: plainAll(sbs.filter((s) => s.episode_id === ep.id)),
        }));
        return { type: 'all_storyboards', data: out };
      }
      const rows = await db.select('storyboards',
        { episode_id: Number(epId) }, { order: 'storyboard_number.asc' });
      return { type: 'storyboards', episode_id: Number(epId), data: plainAll(rows) };
    },

    'storyboard.update': async (params) => {
      const { storyboard_id, ...fields } = params || {};
      if (!storyboard_id) throw new Error('缺少 storyboard_id');
      const keys = Object.keys(fields);
      if (!keys.length) throw new Error('没有可更新字段');
      const patch = { updated_at: now() };
      for (const k of keys) patch[k] = fields[k];
      await db.update('storyboards', { id: Number(storyboard_id) }, patch);
      return { type: 'storyboard_updated', storyboard_id: Number(storyboard_id) };
    },

    /* -------- 生成触发：真实建流水线任务（TOOL-01） -------- */
    'generate.run': async (params) => {
      const { kind, episodeIds } = params || {}; // storyboardNumbers 保留字段，本轮不参与
      const valid = ['script', 'extract', 'storyboard'];
      if (!kind || !valid.includes(kind)) {
        throw new Error(`kind 必须是 ${valid.join(' / ')} 之一`);
      }

      const dramaNum = Number(dramaId);
      let targetIds = Array.isArray(episodeIds) && episodeIds.length
        ? episodeIds.map(Number)
        : episodeId ? [Number(episodeId)] : null;

      // 越权防护：指定的集必须全部属于当前 dramaId
      if (targetIds) {
        const owned = await db.select('episodes',
          { id__in: targetIds, drama_id: dramaNum, deleted_at__is: null },
          { columns: 'id,episode_number', order: 'episode_number.asc' });
        if (owned.length !== new Set(targetIds).size) throw new Error('指定的集不属于当前项目');
        targetIds = owned.map((e) => e.id);
      } else {
        const all = await db.select('episodes',
          { drama_id: dramaNum, deleted_at__is: null },
          { columns: 'id,episode_number', order: 'episode_number.asc' });
        if (!all.length) throw new Error('当前项目还没有剧集');
        targetIds = all.map((e) => e.id);
      }

      const eps = await db.select('episodes',
        { id__in: targetIds, drama_id: dramaNum, deleted_at__is: null },
        { order: 'episode_number.asc' });
      // 拼回带集标记的整部剧本，直接复用 pipeline.create 的切集与 script_hash 幂等
      const script = eps.map((e) => `第${e.episode_number}集\n${e.script_content || e.content || ''}`).join('\n\n');
      const res = await createPipeline(db, null, { dramaId: dramaNum, script, steps: [kind] });
      const taskId = res.data?.taskId ?? res.error?.data?.existingTaskId;
      if (!taskId) throw new Error(res.error?.message || '创建生成任务失败');

      return {
        type: 'generate_task',
        kind,
        dramaId: dramaNum,
        taskId,
        status: 'queued',
        hint: `已创建生成任务 #${taskId}，前端请轮询 /api/pipeline/${taskId} 或继续 advance 直至完成`,
      };
    },
  });
}

/* ====================================================================
 * 系统提示词
 * ==================================================================== */

export const ASSISTANT_SYSTEM = `你是 DramaForge 智能助手，一个短剧创作平台的 AI 助手。

你的职责：
1. 帮助用户创建短剧项目、剧集、角色、场景、道具
2. 帮助用户拆解剧本为分镜，生成视频提示词
3. 操作无限画布，管理节点和连线
4. 触发AI生成任务（剧本改写、资产提取、分镜拆解、图片生成、视频生成）

你可以通过工具执行操作。每次回复时，如果用户提出了一个需要执行的动作，先调用工具，再汇报结果。

可用工具：
- canvas.list_nodes / canvas.create_node / canvas.update_node / canvas.focus：画布操作
- project.info / project.episodes / project.characters / project.scenes / project.props：查询项目数据
- storyboard.list / storyboard.update：查看和修改分镜
- generate.run：触发AI生成

输出规范：
- 调用工具后，用简短的中文汇报结果
- 如果多个步骤，逐个调用工具并汇报
- 如果不确定，先问用户再执行
- 不要在没有工具调用的情况下编造数据

【专家团规则段】
你有三位专家身份。根据用户请求或当前激活专家，以相应身份发言，并在回复文本末尾标注 [expert:writer|producer|storyboard]。
每次只以一位专家身份主答；确需协作时说明「正在与 X 协作」。

工具调用格式（任选一种，平台自动识别）：
格式A（推荐）：<tool_use name="project.characters">\n{}\n</tool_use>
格式B：<tool_calls_begin>\n{"tool":"project.characters","args":{}}\n<tool_calls_end>`;

/* ====================================================================
 * 工具定义（供模型理解工具能力）
 * ==================================================================== */

export const TOOL_SCHEMA = [
  {
    name: 'canvas.list_nodes',
    description: '列出画布上所有节点，用于了解当前布局状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'canvas.create_node',
    description: '在画布上新建一个节点。type 可以是：drama / episode / character / scene / prop / storyboard',
    inputSchema: {
      type: 'object',
      required: ['node_type', 'node_id'],
      properties: {
        node_type: { type: 'string', enum: ['drama', 'episode', 'character', 'scene', 'prop', 'storyboard'] },
        node_id: { type: 'integer', description: '关联数据的 id' },
        x: { type: 'integer', default: 0 },
        y: { type: 'integer', default: 0 },
        w: { type: 'integer', default: 280 },
        h: { type: 'integer', default: 160 },
        collapsed: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'canvas.update_node',
    description: '修改已有节点的位置或大小',
    inputSchema: {
      type: 'object',
      required: ['node_id', 'node_type'],
      properties: {
        node_id: { type: 'integer' },
        node_type: { type: 'string', enum: ['drama', 'episode', 'character', 'scene', 'prop', 'storyboard'] },
        x: { type: 'integer' },
        y: { type: 'integer' },
        w: { type: 'integer' },
        h: { type: 'integer' },
        collapsed: { type: 'boolean' },
      },
    },
  },
  {
    name: 'canvas.focus',
    description: '把画布视图移到指定节点中央，返回目标坐标',
    inputSchema: {
      type: 'object',
      required: ['node_type', 'node_id'],
      properties: {
        node_type: { type: 'string', enum: ['drama', 'episode', 'character', 'scene', 'prop', 'storyboard'] },
        node_id: { type: 'integer' },
      },
    },
  },
  {
    name: 'project.info',
    description: '获取项目的基本信息（标题、题材、风格等）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project.episodes',
    description: '列出项目所有剧集',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project.characters',
    description: '列出项目所有角色及其外形锚点',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project.scenes',
    description: '列出项目所有场景',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'project.props',
    description: '列出项目所有道具',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'storyboard.list',
    description: '列出分镜。可传 episode_id 查单集，不传则查全部',
    inputSchema: {
      type: 'object',
      properties: {
        episode_id: { type: 'integer', description: '可选，指定某集' },
      },
    },
  },
  {
    name: 'storyboard.update',
    description: '修改单个分镜的属性（shot_type, angle, movement, result 等）',
    inputSchema: {
      type: 'object',
      required: ['storyboard_id'],
      properties: {
        storyboard_id: { type: 'integer' },
        shot_type: { type: 'string' },
        angle: { type: 'string' },
        movement: { type: 'string' },
        result: { type: 'string' },
        duration_sec: { type: 'integer' },
      },
    },
  },
  {
    name: 'generate.run',
    description: '触发AI生成任务：script=剧本改写 / extract=资产提取 / storyboard=分镜拆解',
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['script', 'extract', 'storyboard'] },
        episodeIds: { type: 'array', items: { type: 'integer' }, description: '可选，指定集ID数组，不传则只处理当前集' },
        storyboardNumbers: { type: 'array', items: { type: 'integer' }, description: '可选，只处理指定镜号' },
      },
    },
  },
];

/* ====================================================================
 * 工具执行
 * ==================================================================== */

export async function execToolCall(name, params, tools) {
  const fn = tools[name];
  if (!fn) throw new Error(`未知工具: ${name}`);
  return await fn(params || {});
}
