/**
 * 基础接口：配置 / 项目 / 剧集 / 资产 / 分镜 / 画布
 * 生成类接口在 generate.mjs
 */
import { Router } from 'express';
import { db, now, plain, plainAll, parseJson, tx } from '../db/index.mjs';
import * as ai from '../adapters/ai.mjs';
import generate from './generate.mjs';
import chat from './chat.mjs';

const r = Router();
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, message, code = 400) => res.status(code).json({ success: false, error: { message } });
const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { bad(res, e.message || '服务内部错误', 500); }
};

/* ================= 健康检查 ================= */
r.get('/health', (req, res) =>
  ok(res, { status: 'ok', app: 'DramaForge', version: '0.1.0', time: now() })
);

/* ================= AI 配置 ================= */
r.get('/ai-configs', wrap((req, res) => {
  const { service_type } = req.query;
  const rows = service_type
    ? db.prepare('SELECT * FROM ai_configs WHERE service_type=? ORDER BY is_default DESC, priority DESC').all(service_type)
    : db.prepare('SELECT * FROM ai_configs ORDER BY service_type, is_default DESC, priority DESC').all();
  ok(res, plainAll(rows).map((x) => ({ ...x, api_key: maskKey(x.api_key) })));
}));

r.post('/ai-configs', wrap((req, res) => {
  const b = req.body || {};
  for (const f of ['service_type', 'name', 'base_url']) {
    if (!b[f]) return bad(res, `缺少必填字段: ${f}`);
  }
  if (!b.api_key) return bad(res, '缺少必填字段: api_key');

  const models = b.models === undefined ? [] : b.models;
  const info = db.prepare(
    `INSERT INTO ai_configs
     (service_type, provider, name, base_url, api_key, models, default_model,
      endpoint, query_endpoint, priority, is_default, is_active, settings, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.service_type,
    b.provider || 'openai',
    b.name,
    String(b.base_url).replace(/\/+$/, ''),
    b.api_key,
    // 该列是 JSON 字符串，传对象会直接失败
    typeof models === 'string' ? models : JSON.stringify(models),
    b.default_model || (Array.isArray(models) ? models[0] : null),
    b.endpoint || null,
    b.query_endpoint || null,
    b.priority ?? 0,
    b.is_default ? 1 : 0,
    b.is_active === false ? 0 : 1,
    typeof b.settings === 'string' ? b.settings : JSON.stringify(b.settings || {}),
    now()
  );

  // 同类型只保留一个默认
  if (b.is_default) {
    db.prepare('UPDATE ai_configs SET is_default=0 WHERE service_type=? AND id!=?')
      .run(b.service_type, info.lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM ai_configs WHERE id=?').get(info.lastInsertRowid);
  ok(res, { ...plain(row), api_key: maskKey(row.api_key) });
}));

r.put('/ai-configs/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM ai_configs WHERE id=?').get(id);
  if (!cur) return bad(res, '配置不存在', 404);
  const b = req.body || {};
  const sets = [], vals = [];
  const push = (col, v) => { sets.push(`${col}=?`); vals.push(v); };
  if (b.name !== undefined) push('name', b.name);
  if (b.base_url !== undefined) push('base_url', String(b.base_url).replace(/\/+$/, ''));
  if (b.api_key) push('api_key', b.api_key);
  if (b.models !== undefined) push('models', typeof b.models === 'string' ? b.models : JSON.stringify(b.models));
  if (b.default_model !== undefined) push('default_model', b.default_model);
  if (b.endpoint !== undefined) push('endpoint', b.endpoint);
  if (b.query_endpoint !== undefined) push('query_endpoint', b.query_endpoint);
  if (b.priority !== undefined) push('priority', b.priority);
  if (b.is_active !== undefined) push('is_active', b.is_active ? 1 : 0);
  if (b.settings !== undefined) push('settings', typeof b.settings === 'string' ? b.settings : JSON.stringify(b.settings));
  if (b.is_default !== undefined) push('is_default', b.is_default ? 1 : 0);
  if (!sets.length) return bad(res, '没有可更新字段');
  vals.push(id);
  db.prepare(`UPDATE ai_configs SET ${sets.join(',')} WHERE id=?`).run(...vals);
  if (b.is_default) {
    db.prepare('UPDATE ai_configs SET is_default=0 WHERE service_type=? AND id!=?').run(cur.service_type, id);
  }
  const row = db.prepare('SELECT * FROM ai_configs WHERE id=?').get(id);
  ok(res, { ...plain(row), api_key: maskKey(row.api_key) });
}));

r.delete('/ai-configs/:id', wrap((req, res) => {
  db.prepare('DELETE FROM ai_configs WHERE id=?').run(Number(req.params.id));
  ok(res, { deleted: true });
}));

r.post('/ai-configs/test', async (req, res) => {
  try {
    const { service_type = 'text', base_url, api_key, model } = req.body || {};
    if (!base_url || !api_key) return bad(res, '缺少 base_url 或 api_key');
    const out = await ai.probe({ serviceType: service_type, baseUrl: base_url, apiKey: api_key, model });
    ok(res, { message: out.message });
  } catch (e) {
    bad(res, e.message || '连接失败', 502);
  }
});

/** 已存配置的探针：不用再传 key */
r.post('/ai-configs/:id/test', async (req, res) => {
  try {
    const cfg = db.prepare('SELECT * FROM ai_configs WHERE id=?').get(Number(req.params.id));
    if (!cfg) return bad(res, '配置不存在', 404);
    const out = await ai.probe({
      serviceType: cfg.service_type, baseUrl: cfg.base_url,
      apiKey: cfg.api_key, model: cfg.default_model,
    });
    ok(res, { message: out.message });
  } catch (e) {
    bad(res, e.message || '连接失败', 502);
  }
});

/* ================= 项目 ================= */
r.get('/dramas', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT d.*,
            (SELECT COUNT(*) FROM episodes e WHERE e.drama_id=d.id AND e.deleted_at IS NULL) AS episode_count
     FROM dramas d WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC`
  ).all();
  ok(res, plainAll(rows).map((x) => ({ ...x, tags: parseJson(x.tags, []) })));
}));

r.post('/dramas', wrap((req, res) => {
  const b = req.body || {};
  if (!b.title) return bad(res, '缺少项目标题');
  const t = now();
  const info = db.prepare(
    `INSERT INTO dramas (title, description, genre, style, audience, inspiration,
                         aspect_ratio, resolution, status, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.title, b.description || null, b.genre || null, b.style || null,
    b.audience || null, b.inspiration || null,
    b.aspect_ratio || '9:16', b.resolution || '1080p',
    'draft', JSON.stringify(b.tags || []), t, t
  );
  ok(res, plain(db.prepare('SELECT * FROM dramas WHERE id=?').get(info.lastInsertRowid)));
}));

r.get('/dramas/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(id);
  if (!d) return bad(res, '项目不存在', 404);
  ok(res, {
    ...plain(d),
    tags: parseJson(d.tags, []),
    episodes: plainAll(db.prepare(
      'SELECT * FROM episodes WHERE drama_id=? AND deleted_at IS NULL ORDER BY episode_number'
    ).all(id)),
    characters: plainAll(db.prepare(
      'SELECT * FROM characters WHERE drama_id=? AND deleted_at IS NULL ORDER BY sort_order, id'
    ).all(id)).map((x) => ({ ...x, reference_images: parseJson(x.reference_images, []) })),
    scenes: plainAll(db.prepare(
      'SELECT * FROM scenes WHERE drama_id=? AND deleted_at IS NULL ORDER BY id'
    ).all(id)),
    props: plainAll(db.prepare(
      'SELECT * FROM props WHERE drama_id=? AND deleted_at IS NULL ORDER BY id'
    ).all(id)),
  });
}));

r.put('/dramas/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cols = ['title', 'description', 'genre', 'style', 'audience', 'inspiration',
    'aspect_ratio', 'resolution', 'status', 'thumbnail'];
  const sets = [], vals = [];
  for (const c of cols) if (b[c] !== undefined) { sets.push(`${c}=?`); vals.push(b[c]); }
  if (b.tags !== undefined) { sets.push('tags=?'); vals.push(JSON.stringify(b.tags)); }
  if (!sets.length) return bad(res, '没有可更新字段');
  sets.push('updated_at=?'); vals.push(now(), id);
  db.prepare(`UPDATE dramas SET ${sets.join(',')} WHERE id=?`).run(...vals);
  ok(res, plain(db.prepare('SELECT * FROM dramas WHERE id=?').get(id)));
}));

r.delete('/dramas/:id', wrap((req, res) => {
  db.prepare('UPDATE dramas SET deleted_at=? WHERE id=?').run(now(), Number(req.params.id));
  ok(res, { deleted: true });
}));

/* ================= 剧集 ================= */
r.get('/dramas/:id/episodes', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT e.*,
            (SELECT COUNT(*) FROM storyboards s WHERE s.episode_id=e.id) AS storyboard_count,
            (SELECT COUNT(*) FROM storyboards s WHERE s.episode_id=e.id AND s.video_url IS NOT NULL) AS video_count
     FROM episodes e WHERE e.drama_id=? AND e.deleted_at IS NULL ORDER BY e.episode_number`
  ).all(Number(req.params.id));
  ok(res, plainAll(rows));
}));

r.post('/episodes', wrap((req, res) => {
  const b = req.body || {};
  if (!b.drama_id) return bad(res, '缺少 drama_id');
  const t = now();
  // 集号：不传则自动取下一个
  let num = b.episode_number;
  if (!num) {
    const row = db.prepare(
      'SELECT COALESCE(MAX(episode_number),0) AS n FROM episodes WHERE drama_id=?'
    ).get(b.drama_id);
    num = Number(row.n) + 1;
  }
  const info = db.prepare(
    `INSERT INTO episodes (drama_id, episode_number, title, content, outline, hook_type,
                           duration_sec, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.drama_id, num, b.title || `第 ${num} 集`, b.content || null,
    b.outline || null, b.hook_type || null, b.duration_sec || 0, 'draft', t, t
  );
  db.prepare('UPDATE dramas SET total_episodes=(SELECT COUNT(*) FROM episodes WHERE drama_id=? AND deleted_at IS NULL), updated_at=? WHERE id=?')
    .run(b.drama_id, t, b.drama_id);
  ok(res, plain(db.prepare('SELECT * FROM episodes WHERE id=?').get(info.lastInsertRowid)));
}));

r.put('/episodes/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cols = ['title', 'content', 'script_content', 'outline', 'hook_type',
    'duration_sec', 'status', 'video_url'];
  const sets = [], vals = [];
  for (const c of cols) if (b[c] !== undefined) { sets.push(`${c}=?`); vals.push(b[c]); }
  if (!sets.length) return bad(res, '没有可更新字段');
  sets.push('updated_at=?'); vals.push(now(), id);
  db.prepare(`UPDATE episodes SET ${sets.join(',')} WHERE id=?`).run(...vals);
  ok(res, plain(db.prepare('SELECT * FROM episodes WHERE id=?').get(id)));
}));

r.delete('/episodes/:id', wrap((req, res) => {
  db.prepare('UPDATE episodes SET deleted_at=? WHERE id=?').run(now(), Number(req.params.id));
  ok(res, { deleted: true });
}));

/* ================= 分镜 ================= */
r.get('/episodes/:id/storyboards', wrap((req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare(
    'SELECT * FROM storyboards WHERE episode_id=? ORDER BY storyboard_number'
  ).all(id);
  const list = plainAll(rows).map((s) => ({
    ...s,
    character_ids: db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=?')
      .all(s.id).map((x) => x.character_id),
    prop_ids: db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id=?')
      .all(s.id).map((x) => x.prop_id),
    reference_images: parseJson(s.reference_images, []),
  }));
  ok(res, list);
}));

r.post('/storyboards', wrap((req, res) => {
  const b = req.body || {};
  if (!b.episode_id) return bad(res, '缺少 episode_id');
  const t = now();
  let num = b.storyboard_number;
  if (!num) {
    const row = db.prepare(
      'SELECT COALESCE(MAX(storyboard_number),0) AS n FROM storyboards WHERE episode_id=?'
    ).get(b.episode_id);
    num = Number(row.n) + 1;
  }
  const info = db.prepare(
    `INSERT INTO storyboards
     (episode_id, scene_id, storyboard_number, title, location, time_of_day, shot_type, angle,
      movement, result, atmosphere, image_prompt, video_prompt, bgm_prompt, sound_effect,
      description, duration_sec, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.episode_id, b.scene_id || null, num, b.title || `S${String(num).padStart(2, '0')}`,
    b.location || null, b.time_of_day || null, b.shot_type || '中景', b.angle || '平视',
    b.movement || '固定', b.result || null, b.atmosphere || null,
    b.image_prompt || null, b.video_prompt || null, b.bgm_prompt || null, b.sound_effect || null,
    b.description || null, b.duration_sec ?? 10, 'pending', t, t
  );
  ok(res, plain(db.prepare('SELECT * FROM storyboards WHERE id=?').get(info.lastInsertRowid)));
}));

r.put('/storyboards/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cols = ['title', 'location', 'time_of_day', 'shot_type', 'angle', 'movement', 'result',
    'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect', 'description',
    'duration_sec', 'first_frame_image', 'last_frame_image', 'composed_image', 'video_url',
    'subtitle_url', 'status', 'scene_id'];
  const sets = [], vals = [];
  for (const c of cols) if (b[c] !== undefined) { sets.push(`${c}=?`); vals.push(b[c]); }
  if (!sets.length) return bad(res, '没有可更新字段');
  sets.push('updated_at=?'); vals.push(now(), id);
  db.prepare(`UPDATE storyboards SET ${sets.join(',')} WHERE id=?`).run(...vals);

  // 同步两张关联表
  if (Array.isArray(b.character_ids)) {
    db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO storyboard_characters(storyboard_id, character_id) VALUES (?,?)');
    for (const cid of b.character_ids) ins.run(id, cid);
  }
  if (Array.isArray(b.prop_ids)) {
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO storyboard_props(storyboard_id, prop_id) VALUES (?,?)');
    for (const pid of b.prop_ids) ins.run(id, pid);
  }
  ok(res, plain(db.prepare('SELECT * FROM storyboards WHERE id=?').get(id)));
}));

r.delete('/storyboards/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id=?').run(id);
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id=?').run(id);
    db.prepare('DELETE FROM storyboards WHERE id=?').run(id);
  });
  ok(res, { deleted: true });
}));

/* ================= 画布布局 ================= */
r.get('/dramas/:id/canvas', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM canvas_layout WHERE drama_id=?').all(Number(req.params.id));
  ok(res, plainAll(rows));
}));

/** 批量保存节点位置（前端拖拽结束后一次性提交） */
r.put('/dramas/:id/canvas', wrap((req, res) => {
  const dramaId = Number(req.params.id);
  const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
  const t = now();
  tx(() => {
    const up = db.prepare(
      `INSERT INTO canvas_layout (drama_id, node_type, node_id, x, y, w, h, z_index, collapsed, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(drama_id, node_type, node_id) DO UPDATE SET
         x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h,
         z_index=excluded.z_index, collapsed=excluded.collapsed, updated_at=excluded.updated_at`
    );
    for (const n of nodes) {
      up.run(dramaId, n.node_type, n.node_id, n.x ?? 0, n.y ?? 0,
        n.w ?? 280, n.h ?? 180, n.z_index ?? 0, n.collapsed ? 1 : 0, t);
    }
  });
  ok(res, { saved: nodes.length });
}));

/* ================= 生成（挂载子路由） ================= */
r.use('/chat', chat);
r.use('/generate', generate);

/* ---------------- 工具 ---------------- */
function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export default r;
