/**
 * 合成任务服务（API-M01~M04 共用逻辑）
 * 只认 (db, params)，不碰 Hono ctx；返回 { data } 或 { error:{ message, status, code } }。
 * merges 表零结构变更，DDL 列名保持 snake_case，仅在 toApi 出口转 camelCase。
 */
import { now, parseJson } from '../db.js';

const done = (data) => ({ data });
const fail = (message, status = 400, code) => ({ error: { message, status, code } });

// 终态不再接受任何推进；pending 不能直接跳到 completed（§4.3 状态机）
const NEXT = {
  pending: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

/** DDL 列名 → API 字段，唯一出口，避免各处重复转换 */
function toApi(row) {
  return {
    id: row.id,
    dramaId: row.drama_id,
    episodeId: row.episode_id,
    segments: parseJson(row.segments, []),
    status: row.status,
    mergedUrl: row.merged_url,
    duration: row.duration,
    provider: row.provider,
    model: row.model,
    errorMsg: row.error_msg,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    // GPU 分发字段（G-003/G-005）：存量行为 NULL，前端据此判断是否已分发
    gpuProvider: row.gpu_provider || null,
    gpuTaskId: row.gpu_task_id || null,
    gpuInstanceId: row.gpu_instance_id || null,
    costEstimate: row.cost_estimate ?? null,
    startedAt: row.started_at || null,
  };
}

/** M01 响应只有三个字段 */
function toCreate(row) {
  return { mergeId: row.id, status: row.status, segments: parseJson(row.segments, []) };
}

/**
 * 提交整集合成任务。
 * 幂等只复用 pending/processing 记录：failed/completed 保留原记录并新建（E-05）。
 */
export async function create(db, { dramaId, episodeId, segments: raw } = {}) {
  if (!dramaId || !episodeId) return fail('缺少 dramaId 或 episodeId');

  const episode = await db.first('episodes', { id: Number(episodeId) });
  if (!episode) return fail('剧集不存在', 404);

  const segments = (Array.isArray(raw) ? raw : []).map(Number);
  if (!segments.length || segments.some((n) => !Number.isInteger(n) || n <= 0)) {
    return fail('该集没有可合成的分镜', 400, 'NO_STORYBOARDS');
  }

  // 逐段核对归属：不存在的 id 与跨集 id 一并按 E-12 拒绝
  const owned = await db.select('storyboards', { id__in: segments }, { columns: 'id,episode_id' });
  const owner = new Map(owned.map((s) => [Number(s.id), Number(s.episode_id)]));
  if (segments.some((sid) => owner.get(sid) !== Number(episodeId))) {
    return fail('分镜不属于该集', 400, 'NO_STORYBOARDS');
  }

  // segments 有序即身份：同集 + 同序同集合才命中幂等，避免重复提交堆积
  const key = JSON.stringify(segments);
  const active = await db.select('merges', {
    episode_id: Number(episodeId),
    status__in: ['pending', 'processing'],
  }, { order: 'created_at.desc,id.desc' });
  const hit = active.find((row) => JSON.stringify(parseJson(row.segments, [])) === key);
  if (hit) return done(toCreate(hit));

  const row = await db.insertOne('merges', {
    drama_id: Number(dramaId),
    episode_id: Number(episodeId),
    status: 'pending',
    segments: key,
    created_at: now(),
  });
  return done(toCreate(row));
}

export async function get(db, id) {
  const row = await db.first('merges', { id: Number(id) });
  if (!row) return fail('合成任务不存在', 404);
  return done(toApi(row));
}

/** 按集取最新一条供前端状态卡初始化，无任务返回 null */
export async function listByEpisode(db, episodeId) {
  const row = await db.first('merges', { episode_id: Number(episodeId) }, { order: 'created_at.desc,id.desc' });
  return done({ merge: row ? toApi(row) : null });
}

/** GPU 回调占位：仅推进状态，不做任何真实合成 */
export async function advance(db, id, body = {}) {
  const row = await db.first('merges', { id: Number(id) });
  if (!row) return fail('合成任务不存在', 404);

  const to = body.status;
  if (!NEXT[to]) return fail('status 只能是 processing / completed / failed');
  if (!NEXT[row.status].includes(to)) return fail(`不允许 ${row.status} → ${to}`, 409, 'CONFLICT');

  const patch = { status: to };
  if (to === 'completed' || to === 'failed') patch.completed_at = now();
  const fields = { mergedUrl: 'merged_url', duration: 'duration', errorMsg: 'error_msg', provider: 'provider', model: 'model' };
  for (const [api, col] of Object.entries(fields)) {
    if (body[api] !== undefined) patch[col] = body[api];
  }

  // CAS：带出态条件更新，changes=0 说明被并发回调抢占，按非法跃迁处理
  const cols = Object.keys(patch);
  const sql = `UPDATE merges SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`;
  const changes = await db.raw(sql, [...cols.map((c) => patch[c]), Number(id), row.status]);
  if (!changes) return fail('状态已被其他回调推进', 409, 'CONFLICT');

  return done(toApi(await db.first('merges', { id: Number(id) })));
}

/* ==================== GPU 自动/手动分发（G-003 / G-004） ==================== */

/** 10 秒超时 fetch：边缘函数不能让厂商接口挂死整个请求 */
async function fetchTimeout(url, options = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调厂商 API 创建 GPU 任务，返回 { taskId, instanceId }。
 * 多厂商载荷统一为 { segments, concat_params, output_path, webhook_url }，差异只在入口与鉴权。
 */
async function callProvider(provider, cfg, payload) {
  const key = cfg.api_key || cfg.apiKey;

  if (provider === 'runpod') {
    const ep = cfg.endpoint_id || cfg.endpointId;
    if (!ep || !key) throw new Error('RunPod 缺少 endpoint_id 或 api_key');
    const res = await fetchTimeout(`https://api.runpod.ai/v2/${ep}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: payload }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    return { taskId: data.id || data.jobId || null, instanceId: ep };
  }

  if (provider === 'vastai') {
    if (!key) throw new Error('Vast.ai 缺少 api_key');
    // Vast.ai 无原生任务队列，用实例 ID 作为任务载体，命令异步执行
    const instanceId = cfg.instance_id || cfg.instanceId || cfg.instance_label_filter || '';
    if (!instanceId) throw new Error('Vast.ai 缺少 instance_id');
    const res = await fetchTimeout('https://console.vast.ai/api/v0/commands/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ instance_id: instanceId, command: JSON.stringify(payload) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    return { taskId: String(data.id || data.command_id || ''), instanceId: String(instanceId) };
  }

  // 自建 / AutoDL：对齐 RunPod REST 语义，入口与鉴权可配。
  // AutoDL 算力云走「链接转代码」——容器中自启 HTTP 服务，base_url 即 seetacloud 访问链接。
  const base = (cfg.base_url || cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error(`${provider === 'autodl' ? 'AutoDL' : '自建'}缺少 base_url`);
  const res = await fetchTimeout(`${base}/api/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(cfg.custom_headers || {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json().catch(() => ({}));
  return { taskId: data.id || data.task_id || null, instanceId: data.instance_id || null };
}

/**
 * 分发到 GPU：查自动分发配置 → 调厂商 → 回写 processing + GPU 字段。
 * 无配置时保持 pending，交给前端「发送到 GPU」手动触发（G-004 复用本函数）。
 * @param origin 请求来源，用于拼 webhook 回调地址（由路由层透传）
 */
export async function dispatch(db, mergeId, origin = '') {
  const row = await db.first('merges', { id: Number(mergeId) });
  if (!row) return fail('合成任务不存在', 404);
  if (row.status !== 'pending') return fail(`当前状态 ${row.status} 不可分发`, 409, 'CONFLICT');

  const cfg = await db.first('gpu_configs', { auto_dispatch: 1 });
  if (!cfg) return fail('未配置自动分发，请先在「云 GPU 配置」新增并开启自动分发', 409, 'NO_GPU_CONFIG');

  let config;
  try {
    config = JSON.parse(cfg.config_json || '{}');
  } catch {
    return fail('GPU 配置格式异常，请重新保存', 500);
  }

  // 回调地址优先用配置里显式指定的（GPU 侧需公网可达）
  const webhookUrl = cfg.webhook_url || `${origin}/api/gpu/webhook`;
  const payload = {
    // merge_id/config_id 让回调能精确定位任务与验签配置，避免靠 output_path 反推（G-005）
    merge_id: row.id,
    config_id: cfg.id,
    segments: parseJson(row.segments, []),
    output_path: `runs/${row.id}/merged.mp4`,
    webhook_url: webhookUrl,
    webhook_secret: cfg.webhook_secret || '',
  };

  let result;
  try {
    result = await callProvider(cfg.provider, config, payload);
  } catch (e) {
    // 分发失败必须可见：标 failed 并留错误摘要，供前端重试（E-G05）
    await db.update('merges', { id: Number(mergeId) }, {
      status: 'failed', error_msg: `分发失败: ${e.message}`, completed_at: now(),
    });
    return fail(`分发失败: ${e.message}`, 502, 'UPSTREAM_ERROR');
  }

  // CAS：仅 pending 可跃迁，防止并发重复分发产生两个 GPU 任务（E-G07 幂等）
  const changes = await db.raw(
    'UPDATE merges SET status = ?, gpu_provider = ?, gpu_task_id = ?, gpu_instance_id = ?, started_at = ? WHERE id = ? AND status = ?',
    ['processing', cfg.provider, result.taskId, result.instanceId, now(), Number(mergeId), 'pending']
  );
  if (!changes) return fail('任务已被其他分发抢占', 409, 'CONFLICT');

  return done({
    mergeId: Number(mergeId),
    status: 'processing',
    gpuProvider: cfg.provider,
    gpuTaskId: result.taskId,
    gpuInstanceId: result.instanceId,
  });
}
