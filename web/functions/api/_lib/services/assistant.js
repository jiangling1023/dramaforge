/**
 * 智能助手 · 工具集（Workers 版）
 *
 * 与 Node 版的差异：
 *   1. 所有工具改为 async，因为底层是 PostgREST 网络查询
 *   2. 移除 db.query 工具 —— PostgREST 无法执行任意 SQL，保留它只会让模型误用
 */

import { plain, plainAll, parseJson, now } from '../db.js';

const norm = (s) => String(s || '').trim().toLowerCase();

export function buildTools(db) {
  return (dramaId) => ({
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

    /* -------- 生成触发 -------- */
    'generate.run': async (params) => {
      const { kind, episodeIds, storyboardNumbers } = params || {};
      const valid = ['script', 'extract', 'storyboard'];
      if (!kind || !valid.includes(kind)) {
        throw new Error(`kind 必须是 ${valid.join(' / ')} 之一`);
      }
      // 返回目标信息，前端会直接调用真实接口
      return {
        type: 'generate_plan',
        kind,
        dramaId,
        episodeIds: episodeIds || null,
        storyboardNumbers: storyboardNumbers || null,
        hint: `建议调用 POST /api/generate/${kind}，payload: { dramaId:${dramaId}, episodeIds:${JSON.stringify(episodeIds || []) }, scope:{ episodeIds:${JSON.stringify(episodeIds || [])} } }`,
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
