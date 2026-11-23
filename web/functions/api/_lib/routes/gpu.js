/**
 * GPU 配置路由：CRUD + 连通性测试
 * 挂载到 /api/gpu
 */
import { Hono } from 'hono';
import { now, plain, plainAll, parseJson } from '../db.js';

const ok = (c, data) => c.json({ success: true, data });
const CODES = { 400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT', 502: 'UPSTREAM_ERROR' };
const bad = (c, message, status = 400, code) => c.json(
  { success: false, error: { message, code: code || CODES[status] || 'INTERNAL_ERROR' } },
  status
);

/** 仅保留后 4 位，如 ***abcd / sk-xxxxabcd */
function maskApiKey(key) {
  if (!key) return '';
  const s = String(key);
  return s.length <= 8 ? '****' : `***${s.slice(-4)}`;
}

/** config_json 深度脱敏：只处理 api_key / apiKey / key 字段 */
function maskConfigJson(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  for (const k of ['api_key', 'apiKey', 'key']) {
    if (out[k]) out[k] = maskApiKey(out[k]);
  }
  return out;
}

/** 10 秒超时的 fetch 封装 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/** HMAC-SHA256 验签：头 X-DramaForge-Signature: sha256=<hex>，签名内容为原始请求体 */
async function verifySignature(rawBody, secret, signature) {
  if (!secret || !signature) return false;
  const expected = String(signature).replace(/^sha256=/i, '').trim().toLowerCase();
  if (!expected) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === expected;
}

/** 执行连通性测试，返回 { ok, detail, sample? } */
export async function testConnectivity(provider, config) {
  if (provider === 'runpod') {
    // RunPod: GET /v2/{endpoint_id}/health, Authorization: Bearer {api_key}
    const endpointId = config.endpoint_id || config.endpointId;
    const apiKey = config.api_key || config.apiKey;
    if (!endpointId || !apiKey) throw new Error('缺少 endpoint_id 或 api_key');
    const url = `https://api.runpod.ai/v2/${endpointId}/health`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 404 || res.status === 401) throw new Error(`${res.status} ${res.statusText}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    // 成功时尝试读取 pods 列表片段作为样例
    const listRes = await fetchWithTimeout('https://api.runpod.ai/v2/pods', { headers: { Authorization: `Bearer ${apiKey}` } });
    let sample = null;
    if (listRes.ok) {
      const data = await listRes.json().catch(() => ({}));
      const pods = data.data || data || [];
      if (pods.length) sample = { id: pods[0].id, url: pods[0].connect?.http || pods[0].connect?.tcp };
    }
    return { ok: true, detail: '连通正常', sample };
  }

  if (provider === 'vastai') {
    // Vast.ai: GET /api/v0/instances/, Authorization: Bearer {api_key}
    const apiKey = config.api_key || config.apiKey;
    if (!apiKey) throw new Error('缺少 api_key');
    const url = 'https://console.vast.ai/api/v0/instances/';
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    const instances = data.instances || [];
    const sample = instances.length ? { id: instances[0].id, gpu: instances[0].gpu_name } : null;
    return { ok: true, detail: '连通正常', sample };
  }

  if (provider === 'custom' || provider === 'autodl') {
    // 自建 / AutoDL: GET {base_url}/health，200 且 JSON 含 status:"ok"
    const baseUrl = config.base_url || config.baseUrl;
    const apiKey = config.api_key || config.apiKey;
    if (!baseUrl) throw new Error('缺少 base_url');
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== 'ok') throw new Error('health 返回 status 非 ok');
    return { ok: true, detail: '连通正常', sample: { status: data.status } };
  }

  throw new Error(`未知厂商: ${provider}`);
}

export function gpuRoutes(db, ai) {
  const r = new Hono();

  /* ================= 列表 ================= */
  r.get('/configs', async (c) => {
    const rows = await db.select('gpu_configs', {}, { order: 'updated_at.desc' });
    return ok(c, plainAll(rows).map((x) => ({
      ...x,
      config_json: maskConfigJson(parseJson(x.config_json, {})),
      webhook_secret: x.webhook_secret ? maskApiKey(x.webhook_secret) : '',
      capabilities: parseJson(x.capabilities, []),
    })));
  });

  /* ================= 新增 ================= */
  r.post('/configs', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const { name, provider, config_json, webhook_secret, auto_dispatch, capabilities } = b;
    if (!name || !provider || !config_json) return bad(c, '缺少必填字段: name, provider, config_json');
    if (!['runpod', 'vastai', 'custom', 'autodl'].includes(provider)) return bad(c, 'provider 必须是 runpod/vastai/custom/autodl');

    const t = now();
    // auto_dispatch=1 时，先把其他配置置 0（互斥，E-G02 兜底）
    if (auto_dispatch === 1) {
      await db.update('gpu_configs', { auto_dispatch: 1 }, { auto_dispatch: 0, updated_at: t });
    }

    const id = crypto.randomUUID();
    const row = await db.insertOne('gpu_configs', {
      id,
      name,
      provider,
      config_json: typeof config_json === 'string' ? config_json : JSON.stringify(config_json),
      webhook_secret: webhook_secret || null,
      auto_dispatch: auto_dispatch ? 1 : 0,
      capabilities: capabilities ? (typeof capabilities === 'string' ? capabilities : JSON.stringify(capabilities)) : null,
      status: 'disconnected',
      last_test_at: null,
      last_test_error: null,
      created_at: t,
      updated_at: t,
    });
    return ok(c, {
      ...plain(row),
      config_json: maskConfigJson(parseJson(row.config_json, {})),
      webhook_secret: row.webhook_secret ? maskApiKey(row.webhook_secret) : '',
      capabilities: parseJson(row.capabilities, []),
    });
  });

  /* ================= 更新 ================= */
  r.put('/configs/:id', async (c) => {
    const id = c.req.param('id');
    const cur = await db.first('gpu_configs', { id });
    if (!cur) return bad(c, '配置不存在', 404);

    const b = await c.req.json().catch(() => ({}));
    const patch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.provider !== undefined) {
      if (!['runpod', 'vastai', 'custom', 'autodl'].includes(b.provider)) return bad(c, 'provider 必须是 runpod/vastai/custom/autodl');
      patch.provider = b.provider;
    }
    if (b.config_json !== undefined) patch.config_json = typeof b.config_json === 'string' ? b.config_json : JSON.stringify(b.config_json);
    if (b.webhook_secret !== undefined) patch.webhook_secret = b.webhook_secret || null;
    if (b.capabilities !== undefined) patch.capabilities = typeof b.capabilities === 'string' ? b.capabilities : JSON.stringify(b.capabilities);
    if (b.auto_dispatch !== undefined) {
      const next = b.auto_dispatch ? 1 : 0;
      patch.auto_dispatch = next;
      // 互斥：开启时先重置其他为 0
      if (next === 1) {
        const t = now();
        await db.update('gpu_configs', { auto_dispatch: 1, id__neq: id }, { auto_dispatch: 0, updated_at: t });
      }
    }
    if (!Object.keys(patch).length) return bad(c, '没有可更新字段');
    patch.updated_at = now();

    await db.update('gpu_configs', { id }, patch);
    const row = await db.first('gpu_configs', { id });
    return ok(c, {
      ...plain(row),
      config_json: maskConfigJson(parseJson(row.config_json, {})),
      webhook_secret: row.webhook_secret ? maskApiKey(row.webhook_secret) : '',
      capabilities: parseJson(row.capabilities, []),
    });
  });

  /* ================= 删除 ================= */
  r.delete('/configs/:id', async (c) => {
    const id = c.req.param('id');
    const cur = await db.first('gpu_configs', { id });
    if (!cur) return bad(c, '配置不存在', 404);
    // E-G14：auto_dispatch=1 的配置不允许删除
    if (cur.auto_dispatch === 1) return bad(c, '自动分发生效中，不可删除', 409, 'CONFIG_IN_USE');
    await db.remove('gpu_configs', { id });
    return ok(c, { deleted: true });
  });

  /* ================= 测试连通性 ================= */
  r.post('/configs/:id/test', async (c) => {
    const id = c.req.param('id');
    const cfg = await db.first('gpu_configs', { id });
    if (!cfg) return bad(c, '配置不存在', 404);

    const config = parseJson(cfg.config_json, {});
    const testAt = now();
    let result;

    try {
      result = await testConnectivity(cfg.provider, config);
    } catch (e) {
      result = { ok: false, detail: `连通异常：${e.message}` };
    }

    // 回写测试结果
    await db.update('gpu_configs', { id }, {
      status: result.ok ? 'connected' : 'error',
      last_test_at: testAt,
      last_test_error: result.ok ? null : result.detail,
      updated_at: testAt,
    });

    return ok(c, result);
  });

  /* ================= 自然语言解析（GPU-002） ================= */
  r.post('/parse', async (c) => {
    const { natural_text } = await c.req.json().catch(() => ({}));
    if (!natural_text) return bad(c, 'natural_text 为空', 400);
    try {
      const { gpuParseConnection } = await import('../services/gpu-parse.js');
      const parsed = gpuParseConnection(natural_text);
      // 若用户已明确要保存（消息中含"保存/写入/创建"等动词），自动落库并测试
      const shouldSave = /保存|写入|创建|落库|接入.*确认/.test(natural_text);
      if (shouldSave && parsed.provider && Object.keys(parsed.config_json).length) {
        const { gpuConfigSave, gpuTestConnectivity } = await import('../services/gpu-parse.js');
        const saved = await gpuConfigSave(db, parsed);
        if (saved.success) {
          let testResult = null;
          try { testResult = await gpuTestConnectivity(db, saved.data.id); } catch { /* 测试失败不阻断 */ }
          return ok(c, { ...parsed, saved: true, configId: saved.data.id, test: testResult });
        }
        return bad(c, saved.error || '保存失败', 400);
      }
      return ok(c, parsed);
    } catch (e) {
      return bad(c, e.message || '解析失败', 400);
    }
  });

  /* ================= GPU 回调（G-005 / G-006） =================
   * GPU 任务完成后 POST /api/gpu/webhook：
   *   header: X-DramaForge-Signature: sha256=<HMAC_SHA256(rawBody, webhook_secret)>
   *   body:   { config_id, status, task_type?: 'merge'|'storyboard_video', ... }
   *   task_type=merge（默认）：{ merge_id, merged_url?, duration?, error_msg? }
   *   task_type=storyboard_video：{ storyboard_id, video_url?, error_msg? }
   * 幂等：终态重复投递直接返回成功；CAS 保证并发回调只有一个生效。
   */
  r.post('/webhook', async (c) => {
    const raw = await c.req.text();
    let body;
    try { body = JSON.parse(raw); } catch { return bad(c, '请求体不是合法 JSON'); }

    const taskType = body.task_type || 'merge';

    // 定位验签配置：优先 payload 携带的 config_id，回退到自动分发配置
    let cfg = body.config_id ? await db.first('gpu_configs', { id: body.config_id }) : null;
    if (!cfg) cfg = await db.first('gpu_configs', { auto_dispatch: 1 });
    if (!cfg || !cfg.webhook_secret) return bad(c, '未找到签名密钥，无法验签', 401, 'NO_SECRET');

    const signature = c.req.header('X-DramaForge-Signature') || c.req.header('X-Signature') || '';
    if (!(await verifySignature(raw, cfg.webhook_secret, signature))) {
      return bad(c, '签名校验失败', 401, 'INVALID_SIGNATURE');
    }

    const s = String(body.status || '').toLowerCase();
    const status = (s === 'completed' || s === 'success') ? 'completed'
      : (s === 'failed' || s === 'error') ? 'failed' : null;
    if (!status) return bad(c, 'status 必须是 completed 或 failed');

    /* ---------- G-006：分镜视频回调，回写 storyboards.video_url ---------- */
    if (taskType === 'storyboard_video') {
      const sid = Number(body.storyboard_id || body.storyboardId);
      if (!sid) return bad(c, '缺少 storyboard_id');
      const sb = await db.first('storyboards', { id: sid });
      if (!sb) return bad(c, '分镜不存在', 404);

      const videoUrl = body.video_url || body.videoUrl;
      const errorMsg = body.error_msg || body.errorMsg;
      if (status === 'completed' && !videoUrl) return bad(c, '完成回调缺少 video_url');

      // 更新分镜视频地址 + 同步 gen_tasks（错误详情写 gen_tasks，storyboards 无 error_msg 列）
      const patch = { video_url: videoUrl || null, status: status === 'completed' ? 'done' : 'failed', updated_at: now() };
      const cols = Object.keys(patch);
      await db.raw(
        `UPDATE storyboards SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...cols.map((k) => patch[k]), sid]
      );
      const gTasks = await db.select('gen_tasks', { storyboard_id: sid, task_type: 'storyboard_video', status: 'processing' }, { limit: 1 });
      if (gTasks.length) {
        await db.update('gen_tasks', { id: gTasks[0].id }, {
          status: status === 'completed' ? 'completed' : 'failed',
          result_url: videoUrl || null,
          error_msg: errorMsg || null,
          completed_at: now(),
        });
      }
      return ok(c, { taskType, storyboardId: sid, status, videoUrl: videoUrl || null });
    }

    /* ---------- G-005：合成任务回调（原逻辑不变） ---------- */
    const mergeId = Number(body.merge_id || body.mergeId);
    if (!mergeId) return bad(c, '缺少 merge_id');
    const merge = await db.first('merges', { id: mergeId });
    if (!merge) return bad(c, '合成任务不存在', 404);

    // 幂等：终态重复回调不再推进
    if (merge.status === 'completed' || merge.status === 'failed') {
      return ok(c, { mergeId, status: merge.status, idempotent: true });
    }
    if (merge.status !== 'processing') {
      return bad(c, `当前状态 ${merge.status} 不可回调`, 409, 'CONFLICT');
    }

    const patch = { status, completed_at: now() };
    const mergedUrl = body.merged_url || body.mergedUrl;
    if (mergedUrl) patch.merged_url = mergedUrl;
    if (body.duration !== undefined) patch.duration = body.duration;
    const errorMsg = body.error_msg || body.errorMsg;
    if (errorMsg) patch.error_msg = errorMsg;

    const cols = Object.keys(patch);
    const changes = await db.raw(
      `UPDATE merges SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status = ?`,
      [...cols.map((k) => patch[k]), mergeId, 'processing']
    );
    if (!changes) return bad(c, '状态已被其他回调推进', 409, 'CONFLICT');

    return ok(c, { mergeId, status, mergedUrl: mergedUrl || null });
  });

  return r;
}