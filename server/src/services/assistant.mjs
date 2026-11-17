/**
 * 智能助手 · 工具集
 *
 * 助手通过函数调用（tool use）让模型能直接读写数据库、操作画布、触发生成。
 *
 * 工具清单：
 *   canvas.list_nodes        - 列出画布节点（用于查看状态）
 *   canvas.create_node       - 新建画布节点
 *   canvas.update_node       - 修改节点位置/大小/折叠状态
 *   canvas.focus             - 把视图移到某个节点（仅返回坐标，前端消费）
 *   project.info             - 项目基本信息（剧情设定、题材等）
 *   project.episodes         - 项目所有剧集
 *   project.characters       - 角色列表
 *   project.scenes           - 场景列表
 *   project.props            - 道具列表
 *   storyboard.list          - 分镜列表
 *   storyboard.update        - 修改单个分镜属性
 *   generate.run             - 触发生成（剧本/资产/分镜）
 */

import { db, plain, plainAll, parseJson, now } from '../db/index.mjs';

/* ====================================================================
 * 上下文包装器：把 db 查询封装成工具函数
 * ==================================================================== */

export function buildTools({ dramaId }) {
  return {
    /* -------- 画布操作 -------- */
    'canvas.list_nodes': () => {
      const rows = plainAll(db.prepare(
        'SELECT * FROM canvas_layout WHERE drama_id=? ORDER BY z_index'
      ).all(dramaId));
      return { type: 'canvas_nodes', data: rows };
    },

    'canvas.create_node': (params) => {
      const { node_type, node_id, x = 0, y = 0, w = 280, h = 160, collapsed = false } = params || {};
      if (!node_type || !node_id) throw new Error('缺少 node_type 或 node_id');
      db.prepare(
        `INSERT INTO canvas_layout (drama_id, node_type, node_id, x, y, w, h, z_index, collapsed, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(drama_id, node_type, node_id) DO UPDATE SET
           x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h,
           collapsed=excluded.collapsed, updated_at=excluded.updated_at`
      ).run(dramaId, node_type, Number(node_id), x, y, w, h, Date.now(), collapsed ? 1 : 0, now());
      return { type: 'node_created', node_type, node_id: Number(node_id), x, y, w, h };
    },

    'canvas.update_node': (params) => {
      const { node_id, node_type, x, y, w, h, collapsed } = params || {};
      if (!node_id) throw new Error('缺少 node_id');
      const sets = [];
      const vals = [];
      if (x !== undefined) { sets.push('x=?'); vals.push(x); }
      if (y !== undefined) { sets.push('y=?'); vals.push(y); }
      if (w !== undefined) { sets.push('w=?'); vals.push(w); }
      if (h !== undefined) { sets.push('h=?'); vals.push(h); }
      if (collapsed !== undefined) { sets.push('collapsed=?'); vals.push(collapsed ? 1 : 0); }
      if (!sets.length) throw new Error('没有可更新字段');
      sets.push('updated_at=?'); vals.push(now());
      vals.push(Number(node_id));
      db.prepare(`UPDATE canvas_layout SET ${sets.join(',')} WHERE drama_id=? AND node_type=? AND node_id=?`)
        .run(...vals, dramaId, node_type, Number(node_id));
      return { type: 'node_updated', node_id: Number(node_id) };
    },

    'canvas.focus': (params) => {
      const { node_type, node_id } = params || {};
      if (!node_type || !node_id) throw new Error('缺少 node_type 或 node_id');
      const row = db.prepare(
        'SELECT x, y, w, h FROM canvas_layout WHERE drama_id=? AND node_type=? AND node_id=?'
      ).get(dramaId, node_type, Number(node_id));
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
    'project.info': () => {
      const d = plain(db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId));
      if (!d) throw new Error('项目不存在');
      return { type: 'project_info', data: { ...d, tags: parseJson(d.tags, []) } };
    },

    'project.episodes': () => {
      const rows = plainAll(db.prepare(
        `SELECT e.*,
                (SELECT COUNT(*) FROM storyboards s WHERE s.episode_id=e.id) AS storyboard_count
         FROM episodes e WHERE e.drama_id=? AND e.deleted_at IS NULL
         ORDER BY e.episode_number`
      ).all(dramaId));
      return { type: 'episodes', data: rows };
    },

    'project.characters': () => {
      const rows = plainAll(db.prepare(
        'SELECT * FROM characters WHERE drama_id=? AND deleted_at IS NULL ORDER BY sort_order, id'
      ).all(dramaId));
      return { type: 'characters', data: rows.map((c) => ({ ...c, reference_images: parseJson(c.reference_images, []) })) };
    },

    'project.scenes': () => {
      const rows = plainAll(db.prepare(
        'SELECT * FROM scenes WHERE drama_id=? AND deleted_at IS NULL ORDER BY id'
      ).all(dramaId));
      return { type: 'scenes', data: rows };
    },

    'project.props': () => {
      const rows = plainAll(db.prepare(
        'SELECT * FROM props WHERE drama_id=? AND deleted_at IS NULL ORDER BY id'
      ).all(dramaId));
      return { type: 'props', data: rows };
    },

    /* -------- 分镜 -------- */
    'storyboard.list': (params) => {
      const epId = params?.episode_id;
      if (!epId) {
        // 返回所有剧集的分镜
        const eps = plainAll(db.prepare(
          'SELECT id, episode_number, title FROM episodes WHERE drama_id=? AND deleted_at IS NULL ORDER BY episode_number'
        ).all(dramaId));
        const out = [];
        for (const ep of eps) {
          const sbs = plainAll(db.prepare(
            'SELECT * FROM storyboards WHERE episode_id=? ORDER BY storyboard_number'
          ).all(ep.id));
          out.push({ episode_id: ep.id, episode_number: ep.episode_number, storyboards: sbs });
        }
        return { type: 'all_storyboards', data: out };
      }
      const rows = plainAll(db.prepare(
        'SELECT * FROM storyboards WHERE episode_id=? ORDER BY storyboard_number'
      ).all(Number(epId)));
      return { type: 'storyboards', episode_id: Number(epId), data: rows };
    },

    'storyboard.update': (params) => {
      const { storyboard_id, ...fields } = params || {};
      if (!storyboard_id) throw new Error('缺少 storyboard_id');
      const ids = Object.keys(fields);
      if (!ids.length) throw new Error('没有可更新字段');
      const sets = ids.map((k) => `${k}=?`).join(',');
      const vals = ids.map((k) => fields[k]);
      vals.push(now(), Number(storyboard_id));
      db.prepare(`UPDATE storyboards SET ${sets}, updated_at=? WHERE id=?`).run(...vals);
      return { type: 'storyboard_updated', storyboard_id: Number(storyboard_id) };
    },

    /* -------- 生成触发 -------- */
    'generate.run': async (params) => {
      // 动态引入（避免循环依赖）
      const gen = await import('../routes/generate.mjs').then((m) => m.default);
      // 这里我们直接返回调用描述，实际执行通过 /api/generate/* 路由
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

    /* -------- 查询辅助 -------- */
    'db.query': (params) => {
      const { sql, params: binds } = params || {};
      if (!sql) throw new Error('需要 sql 参数');
      // 只允许 SELECT
      const trimmed = sql.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT')) throw new Error('只允许查询类 SQL');
      try {
        const rows = binds ? db.prepare(sql).all(...binds) : db.prepare(sql).all();
        return { type: 'query_result', data: plainAll(rows) };
      } catch (e) {
        throw new Error(`SQL 执行失败: ${e.message}`);
      }
    },
  };
}

/* ====================================================================
 * 系统提示词：告诉模型它是什么、能做什么、输出格式
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
- db.query：直接SQL查询（只读）

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
  {
    name: 'db.query',
    description: '执行只读SQL查询，用于复杂数据分析',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: {
        sql: { type: 'string', description: 'SELECT 语句，支持 ? 占位符' },
        params: { type: 'array', description: '占位符对应的参数数组' },
      },
    },
  },
];

/* ====================================================================
 * 工具执行：解析模型的工具调用并执行
 * ==================================================================== */

/**
 * 根据工具名 + 参数执行对应函数，返回结果。
 * @param {string} name
 * @param {object} params
 * @param {object} tools 由 buildTools() 返回的工具字典
 * @returns {Promise<any>}
 */
export async function execToolCall(name, params, tools) {
  const fn = tools[name];
  if (!fn) throw new Error(`未知工具: ${name}`);
  return await fn(params || {});
}
