/**
 * G-006 分镜视频生成复用 GPU（F-002 流水线 image 步骤）
 * 与 merge 的 ffmpeg 拼接不同：这里是让 GPU 生成分镜视频，载荷 task_type='storyboard_video'。
 * 复用 gpu_configs.auto_dispatch 配置与同一 Webhook 链路，但不引入真实 ffmpeg（A-06）。
 */
import { now, parseJson } from '../db.js';

const done = (data) => ({ data });
const fail = (message, status = 400, code) => ({ error: { message, status, code } });

/** 能力检测：配置 capabilities 含 video_gen 才可走 GPU 视频，否则回退 AI 直出（E-G12） */
export function supportsVideoGen(cfg) {
  const raw = cfg?.capabilities;
  if (!raw) return false;
  // capabilities 可能是 JSON 数组字符串或逗号分隔串；两种都覆盖
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim().startsWith('[')) arr = parseJson(raw, []);
  else arr = String(raw).split(',');
  return (Array.isArray(arr) ? arr : []).some((x) => String(x).trim().toLowerCase() === 'video_gen');
}

/** 取当前启用的自动分发配置（全局唯一），无则 null */
export async function getAutoConfig(db) {
  return db.first('gpu_configs', { auto_dispatch: 1 });
}

async function fetchTimeout(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

/** 调厂商创建视频任务；载荷语义为 storyboard_video，各家入口沿用 merge 的约定 */
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
    const d = await res.json().catch(() => ({}));
    return { taskId: d.id || d.jobId || null, instanceId: ep };
  }
  if (provider === 'vastai') {
    if (!key) throw new Error('Vast.ai 缺少 api_key');
    const instanceId = cfg.instance_id || cfg.instanceId || cfg.instance_label_filter || '';
    if (!instanceId) throw new Error('Vast.ai 缺少 instance_id');
    const res = await fetchTimeout('https://console.vast.ai/api/v0/commands/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ instance_id: instanceId, command: JSON.stringify(payload) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const d = await res.json().catch(() => ({}));
    return { taskId: String(d.id || d.command_id || ''), instanceId: String(instanceId) };
  }
  // AutoDL / 自建：链接转代码，容器内自启服务
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
  const d = await res.json().catch(() => ({}));
  return { taskId: d.id || d.task_id || null, instanceId: d.instance_id || null };
}

/**
 * 为单个分镜创建视频生成任务并分发到 GPU。
 * 调用方（pipeline.invokeCore）负责：能力检测、失败回退 AI 直出、把本步骤标记完成。
 * @returns {{data}|{error}} data 含 taskId / genTaskId / gpuProvider
 */
export async function dispatchStoryboardVideo(db, {
  storyboardId, episodeId, dramaId, imagePrompt, videoPrompt, origin = '',
} = {}) {
  const cfg = await getAutoConfig(db);
  if (!cfg) return fail('未配置自动分发 GPU', 409, 'NO_GPU_CONFIG');
  if (!supportsVideoGen(cfg)) return fail('GPU 不支持 video_gen，请回退 AI 直出', 409, 'NO_VIDEO_GEN');

  let config;
  try { config = JSON.parse(cfg.config_json || '{}'); }
  catch { return fail('GPU 配置格式异常', 500); }

  const webhookUrl = cfg.webhook_url || `${origin}/api/gpu/webhook`;
  const payload = {
    task_type: 'storyboard_video',
    config_id: cfg.id,
    storyboard_id: Number(storyboardId),
    image_prompt: imagePrompt || '',
    video_prompt: videoPrompt || '',
    webhook_url: webhookUrl,
    webhook_secret: cfg.webhook_secret || '',
  };

  let result;
  try {
    result = await callProvider(cfg.provider, config, payload);
  } catch (e) {
    return fail(`视频任务分发失败: ${e.message}`, 502, 'UPSTREAM_ERROR');
  }

  // 落 gen_tasks 并记 GPU 字段；Webhook 回调后回写 result_url 与 storyboards.video_url
  const t = now();
  const genTask = await db.insertOne('gen_tasks', {
    task_type: 'storyboard_video',
    provider: cfg.provider,
    status: 'processing',
    prompt: videoPrompt || imagePrompt || '',
    upstream_id: result.taskId || null,
    drama_id: Number(dramaId) || null,
    episode_id: Number(episodeId) || null,
    storyboard_id: Number(storyboardId),
    gpu_provider: cfg.provider,
    gpu_task_id: result.taskId || null,
    created_at: t,
    completed_at: null,
  });

  return done({
    taskId: result.taskId,
    instanceId: result.instanceId,
    genTaskId: genTask.id,
    gpuProvider: cfg.provider,
  });
}
