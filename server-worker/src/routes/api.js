/**
 * 基础接口（Workers 版）：配置 / 项目 / 剧集 / 资产 / 分镜 / 画布
 * 生成类在 generate.js，助手在 chat.js
 */
import { Hono } from 'hono';
import { now, plain, plainAll, parseJson } from '../db.js';
import { generateRoutes } from './generate.js';
import { chatRoutes } from './chat.js';

const ok = (c, data) => c.json({ success: true, data });
const bad = (c, message, code = 400) => c.json({ success: false, error: { message } }, code);

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-4)}`;
}

export function apiRoutes(db, ai) {
  const r = new Hono();

  /* ================= 健康检查 ================= */
  r.get('/health', (c) => ok(c, { status: 'ok', app: 'DramaForge', version: '0.2.0', time: now() }));

  /* ================= AI 配置 ================= */
  r.get('/ai-configs', async (c) => {
    const serviceType = c.req.query('service_type');
    const filters = serviceType ? { service_type: serviceType } : {};
    const order = serviceType
      ? 'is_default.desc,priority.desc'
      : 'service_type.asc,is_default.desc,priority.desc';
    const rows = await db.select('ai_configs', filters, { order });
    return ok(c, plainAll(rows).map((x) => ({ ...x, api_key: maskKey(x.api_key) })));
  });

  r.post('/ai-configs', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    for (const f of ['service_type', 'name', 'base_url']) {
      if (!b[f]) return bad(c, `缺少必填字段: ${f}`);
    }
    if (!b.api_key) return bad(c, '缺少必填字段: api_key');

    const models = b.models === undefined ? [] : b.models;
    const row = await db.insertOne('ai_configs', {
      service_type: b.service_type,
      provider: b.provider || 'openai',
      name: b.name,
      base_url: String(b.base_url).replace(/\/+$/, ''),
      api_key: b.api_key,
      models: typeof models === 'string' ? models : JSON.stringify(models),
      default_model: b.default_model || (Array.isArray(models) ? models[0] : null),
      endpoint: b.endpoint || null,
      query_endpoint: b.query_endpoint || null,
      priority: b.priority ?? 0,
      is_default: b.is_default ? 1 : 0,
      is_active: b.is_active === false ? 0 : 1,
      settings: typeof b.settings === 'string' ? b.settings : JSON.stringify(b.settings || {}),
      created_at: now(),
    });

    if (b.is_default) {
      await db.update(
        'ai_configs',
        { service_type: b.service_type, id__neq: row.id },
        { is_default: 0 }
      );
    }
    return ok(c, { ...plain(row), api_key: maskKey(row.api_key) });
  });

  r.put('/ai-configs/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const cur = await db.first('ai_configs', { id });
    if (!cur) return bad(c, '配置不存在', 404);

    const b = await c.req.json().catch(() => ({}));
    const patch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.base_url !== undefined) patch.base_url = String(b.base_url).replace(/\/+$/, '');
    if (b.api_key) patch.api_key = b.api_key;
    if (b.models !== undefined) patch.models = typeof b.models === 'string' ? b.models : JSON.stringify(b.models);
    if (b.default_model !== undefined) patch.default_model = b.default_model;
    if (b.endpoint !== undefined) patch.endpoint = b.endpoint;
    if (b.query_endpoint !== undefined) patch.query_endpoint = b.query_endpoint;
    if (b.priority !== undefined) patch.priority = b.priority;
    if (b.is_active !== undefined) patch.is_active = b.is_active ? 1 : 0;
    if (b.settings !== undefined) patch.settings = typeof b.settings === 'string' ? b.settings : JSON.stringify(b.settings);
    if (b.is_default !== undefined) patch.is_default = b.is_default ? 1 : 0;
    if (!Object.keys(patch).length) return bad(c, '没有可更新字段');

    await db.update('ai_configs', { id }, patch);
    if (b.is_default) {
      await db.update('ai_configs', { service_type: cur.service_type, id__neq: id }, { is_default: 0 });
    }
    const row = await db.first('ai_configs', { id });
    return ok(c, { ...plain(row), api_key: maskKey(row.api_key) });
  });

  r.delete('/ai-configs/:id', async (c) => {
    await db.remove('ai_configs', { id: Number(c.req.param('id')) });
    return ok(c, { deleted: true });
  });

  r.post('/ai-configs/test', async (c) => {
    const { service_type = 'text', base_url, api_key, model } = await c.req.json().catch(() => ({}));
    if (!base_url || !api_key) return bad(c, '缺少 base_url 或 api_key');
    try {
      const out = await ai.probe({ serviceType: service_type, baseUrl: base_url, apiKey: api_key, model });
      return ok(c, { message: out.message });
    } catch (e) {
      return bad(c, e.message || '连接失败', 502);
    }
  });

  r.post('/ai-configs/:id/test', async (c) => {
    const cfg = await db.first('ai_configs', { id: Number(c.req.param('id')) });
    if (!cfg) return bad(c, '配置不存在', 404);
    try {
      const out = await ai.probe({
        serviceType: cfg.service_type, baseUrl: cfg.base_url,
        apiKey: cfg.api_key, model: cfg.default_model,
      });
      return ok(c, { message: out.message });
    } catch (e) {
      return bad(c, e.message || '连接失败', 502);
    }
  });

  /* ================= 项目 ================= */
  r.get('/dramas', async (c) => {
    // 原版用子查询算 episode_count；PostgREST 没有子查询，改为两次查询后在内存里分组
    const dramas = await db.select('dramas', { deleted_at__is: null }, { order: 'updated_at.desc' });
    const ids = dramas.map((d) => d.id);
    const eps = ids.length
      ? await db.select('episodes', { drama_id__in: ids, deleted_at__is: null }, { columns: 'drama_id' })
      : [];
    const counts = new Map();
    for (const e of eps) counts.set(e.drama_id, (counts.get(e.drama_id) || 0) + 1);

    return ok(c, plainAll(dramas).map((x) => ({
      ...x, tags: parseJson(x.tags, []), episode_count: counts.get(x.id) || 0,
    })));
  });

  r.post('/dramas', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.title) return bad(c, '缺少项目标题');
    const t = now();
    const row = await db.insertOne('dramas', {
      title: b.title,
      description: b.description || null,
      genre: b.genre || null,
      style: b.style || null,
      audience: b.audience || null,
      inspiration: b.inspiration || null,
      aspect_ratio: b.aspect_ratio || '9:16',
      resolution: b.resolution || '1080p',
      total_episodes: 0,
      status: 'draft',
      tags: JSON.stringify(b.tags || []),
      created_at: t,
      updated_at: t,
    });
    return ok(c, plain(row));
  });

  r.get('/dramas/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const d = await db.first('dramas', { id, deleted_at__is: null });
    if (!d) return bad(c, '项目不存在', 404);

    const [episodes, characters, scenes, props] = await Promise.all([
      db.select('episodes', { drama_id: id, deleted_at__is: null }, { order: 'episode_number.asc' }),
      db.select('characters', { drama_id: id, deleted_at__is: null }, { order: 'sort_order.asc,id.asc' }),
      db.select('scenes', { drama_id: id, deleted_at__is: null }, { order: 'id.asc' }),
      db.select('props', { drama_id: id, deleted_at__is: null }, { order: 'id.asc' }),
    ]);

    return ok(c, {
      ...plain(d),
      tags: parseJson(d.tags, []),
      episodes: plainAll(episodes),
      characters: plainAll(characters).map((x) => ({ ...x, reference_images: parseJson(x.reference_images, []) })),
      scenes: plainAll(scenes),
      props: plainAll(props),
    });
  });

  r.put('/dramas/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json().catch(() => ({}));
    const patch = {};
    for (const col of ['title', 'description', 'genre', 'style', 'audience', 'inspiration',
      'aspect_ratio', 'resolution', 'status', 'thumbnail']) {
      if (b[col] !== undefined) patch[col] = b[col];
    }
    if (b.tags !== undefined) patch.tags = JSON.stringify(b.tags);
    if (!Object.keys(patch).length) return bad(c, '没有可更新字段');
    patch.updated_at = now();

    await db.update('dramas', { id }, patch);
    return ok(c, plain(await db.first('dramas', { id })));
  });

  r.delete('/dramas/:id', async (c) => {
    await db.update('dramas', { id: Number(c.req.param('id')) }, { deleted_at: now() });
    return ok(c, { deleted: true });
  });

  /* ================= 剧集 ================= */
  r.get('/dramas/:id/episodes', async (c) => {
    const dramaId = Number(c.req.param('id'));
    const eps = await db.select('episodes', { drama_id: dramaId, deleted_at__is: null }, { order: 'episode_number.asc' });
    const ids = eps.map((e) => e.id);
    const sbs = ids.length
      ? await db.select('storyboards', { episode_id__in: ids }, { columns: 'episode_id,video_url' })
      : [];

    const total = new Map();
    const withVideo = new Map();
    for (const s of sbs) {
      total.set(s.episode_id, (total.get(s.episode_id) || 0) + 1);
      if (s.video_url) withVideo.set(s.episode_id, (withVideo.get(s.episode_id) || 0) + 1);
    }

    return ok(c, plainAll(eps).map((e) => ({
      ...e,
      storyboard_count: total.get(e.id) || 0,
      video_count: withVideo.get(e.id) || 0,
    })));
  });

  r.post('/episodes', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.drama_id) return bad(c, '缺少 drama_id');
    const t = now();

    let num = b.episode_number;
    if (!num) {
      const last = await db.first('episodes', { drama_id: b.drama_id }, { order: 'episode_number.desc', columns: 'episode_number' });
      num = (Number(last?.episode_number) || 0) + 1;
    }

    const row = await db.insertOne('episodes', {
      drama_id: b.drama_id,
      episode_number: num,
      title: b.title || `第 ${num} 集`,
      content: b.content || null,
      outline: b.outline || null,
      hook_type: b.hook_type || null,
      duration_sec: b.duration_sec || 0,
      status: 'draft',
      created_at: t,
      updated_at: t,
    });

    const totalEpisodes = await db.count('episodes', { drama_id: b.drama_id, deleted_at__is: null });
    await db.update('dramas', { id: b.drama_id }, { total_episodes: totalEpisodes, updated_at: t });

    return ok(c, plain(row));
  });

  r.put('/episodes/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json().catch(() => ({}));
    const patch = {};
    for (const col of ['title', 'content', 'script_content', 'outline', 'hook_type',
      'duration_sec', 'status', 'video_url']) {
      if (b[col] !== undefined) patch[col] = b[col];
    }
    if (!Object.keys(patch).length) return bad(c, '没有可更新字段');
    patch.updated_at = now();

    await db.update('episodes', { id }, patch);
    return ok(c, plain(await db.first('episodes', { id })));
  });

  r.delete('/episodes/:id', async (c) => {
    await db.update('episodes', { id: Number(c.req.param('id')) }, { deleted_at: now() });
    return ok(c, { deleted: true });
  });

  /* ================= 分镜 ================= */
  r.get('/episodes/:id/storyboards', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const sbs = await db.select('storyboards', { episode_id: episodeId }, { order: 'storyboard_number.asc' });
    const ids = sbs.map((s) => s.id);

    const [scLinks, spLinks] = ids.length
      ? await Promise.all([
        db.select('storyboard_characters', { storyboard_id__in: ids }, { columns: 'storyboard_id,character_id' }),
        db.select('storyboard_props', { storyboard_id__in: ids }, { columns: 'storyboard_id,prop_id' }),
      ])
      : [[], []];

    const charMap = new Map();
    for (const l of scLinks) {
      if (!charMap.has(l.storyboard_id)) charMap.set(l.storyboard_id, []);
      charMap.get(l.storyboard_id).push(l.character_id);
    }
    const propMap = new Map();
    for (const l of spLinks) {
      if (!propMap.has(l.storyboard_id)) propMap.set(l.storyboard_id, []);
      propMap.get(l.storyboard_id).push(l.prop_id);
    }

    return ok(c, plainAll(sbs).map((s) => ({
      ...s,
      character_ids: charMap.get(s.id) || [],
      prop_ids: propMap.get(s.id) || [],
      reference_images: parseJson(s.reference_images, []),
    })));
  });

  r.post('/storyboards', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.episode_id) return bad(c, '缺少 episode_id');
    const t = now();

    let num = b.storyboard_number;
    if (!num) {
      const last = await db.first('storyboards', { episode_id: b.episode_id }, { order: 'storyboard_number.desc', columns: 'storyboard_number' });
      num = (Number(last?.storyboard_number) || 0) + 1;
    }

    const row = await db.insertOne('storyboards', {
      episode_id: b.episode_id,
      scene_id: b.scene_id || null,
      storyboard_number: num,
      title: b.title || `S${String(num).padStart(2, '0')}`,
      location: b.location || null,
      time_of_day: b.time_of_day || null,
      shot_type: b.shot_type || '中景',
      angle: b.angle || '平视',
      movement: b.movement || '固定',
      result: b.result || null,
      atmosphere: b.atmosphere || null,
      image_prompt: b.image_prompt || null,
      video_prompt: b.video_prompt || null,
      bgm_prompt: b.bgm_prompt || null,
      sound_effect: b.sound_effect || null,
      description: b.description || null,
      duration_sec: b.duration_sec ?? 10,
      status: 'pending',
      created_at: t,
      updated_at: t,
    });
    return ok(c, plain(row));
  });

  r.put('/storyboards/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json().catch(() => ({}));

    const patch = {};
    for (const col of ['title', 'location', 'time_of_day', 'shot_type', 'angle', 'movement', 'result',
      'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect', 'description',
      'duration_sec', 'first_frame_image', 'last_frame_image', 'composed_image', 'video_url',
      'subtitle_url', 'status', 'scene_id']) {
      if (b[col] !== undefined) patch[col] = b[col];
    }
    if (!Object.keys(patch).length) return bad(c, '没有可更新字段');
    patch.updated_at = now();

    await db.update('storyboards', { id }, patch);

    // 同步两张关联表
    if (Array.isArray(b.character_ids)) {
      await db.remove('storyboard_characters', { storyboard_id: id });
      if (b.character_ids.length) {
        await db.upsert(
          'storyboard_characters',
          b.character_ids.map((cid) => ({ storyboard_id: id, character_id: cid })),
          'storyboard_id,character_id'
        );
      }
    }
    if (Array.isArray(b.prop_ids)) {
      await db.remove('storyboard_props', { storyboard_id: id });
      if (b.prop_ids.length) {
        await db.upsert(
          'storyboard_props',
          b.prop_ids.map((pid) => ({ storyboard_id: id, prop_id: pid })),
          'storyboard_id,prop_id'
        );
      }
    }

    return ok(c, plain(await db.first('storyboards', { id })));
  });

  r.delete('/storyboards/:id', async (c) => {
    const id = Number(c.req.param('id'));
    await db.remove('storyboard_characters', { storyboard_id: id });
    await db.remove('storyboard_props', { storyboard_id: id });
    await db.remove('storyboards', { id });
    return ok(c, { deleted: true });
  });

  /* ================= 画布布局 ================= */
  r.get('/dramas/:id/canvas', async (c) => {
    const rows = await db.select('canvas_layout', { drama_id: Number(c.req.param('id')) });
    return ok(c, plainAll(rows));
  });

  r.put('/dramas/:id/canvas', async (c) => {
    const dramaId = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
    const t = now();

    if (nodes.length) {
      await db.upsert(
        'canvas_layout',
        nodes.map((n) => ({
          drama_id: dramaId,
          node_type: n.node_type,
          node_id: n.node_id,
          x: n.x ?? 0,
          y: n.y ?? 0,
          w: n.w ?? 280,
          h: n.h ?? 180,
          z_index: n.z_index ?? 0,
          collapsed: n.collapsed ? 1 : 0,
          updated_at: t,
        })),
        'drama_id,node_type,node_id'
      );
    }
    return ok(c, { saved: nodes.length });
  });

  /* ================= 子路由 ================= */
  r.route('/chat', chatRoutes(db, ai));
  r.route('/generate', generateRoutes(db, ai));

  return r;
}
