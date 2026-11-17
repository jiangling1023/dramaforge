/**
 * 模型适配层（Workers 版）
 * 唯一职责：把「业务意图」翻译成「厂商 HTTP 请求」。
 * 上层只认五个函数：chat / image / video / videoStatus / audio / probe。
 *
 * 与 Node 版的差异：
 *   配置读取从同步 SQLite 变成异步 PostgREST，所以整体改成工厂 + async。
 */
import { plain } from '../db.js';

const DEFAULT_TIMEOUT = 120_000;

function joinUrl(base, endpoint) {
  const b = String(base || '').replace(/\/+$/, '');
  const e = String(endpoint || '');
  if (!e) return b;
  return b + (e.startsWith('/') ? e : '/' + e);
}

function settingsOf(cfg) {
  try { return cfg.settings ? JSON.parse(cfg.settings) : {}; } catch { return {}; }
}

function modelOf(cfg, override) {
  if (override) return override;
  if (cfg.default_model) return cfg.default_model;
  try {
    const arr = cfg.models ? JSON.parse(cfg.models) : [];
    return Array.isArray(arr) ? arr[0] || '' : '';
  } catch { return ''; }
}

async function httpJson(url, { method = 'POST', apiKey, body, timeout = DEFAULT_TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || data?.raw || `HTTP ${res.status}`;
      const err = new Error(String(msg).slice(0, 500));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** SSE 流式对话解析：累积 content，reasoning_content 单独丢弃 */
async function chatStream(url, apiKey, body, model, o) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeout ?? 600_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* 原样 */ }
      throw new Error(String(msg).slice(0, 400));
    }
    if (!res.body) throw new Error('流式响应没有 body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let raw = '';
    let content = '';
    let reasoning = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });

      const lines = raw.split('\n');
      raw = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const d = obj?.choices?.[0]?.delta || obj?.choices?.[0]?.message || {};
        if (typeof d.content === 'string') content += d.content;
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        if (obj?.usage) usage = obj.usage;
      }
    }

    if (!content.trim()) {
      throw new Error(
        reasoning.length
          ? `模型只返回了思维链（${reasoning.length} 字）没有正文，max_tokens 不足，请调大`
          : '模型未返回内容'
      );
    }
    return { content, usage: usage || {}, model, reasoningChars: reasoning.length };
  } finally {
    clearTimeout(timer);
  }
}

export function createAi(db) {
  async function getActiveConfig(serviceType) {
    const row = await db.first(
      'ai_configs',
      { service_type: serviceType, is_active: 1 },
      { order: 'is_default.desc,priority.desc,id.asc' }
    );
    return row ? plain(row) : null;
  }

  async function chat(o) {
    const cfg = await getActiveConfig('text');
    if (!cfg) throw new Error('尚未配置文本模型，请先在设置里添加');

    const st = settingsOf(cfg);
    const model = modelOf(cfg, o.model);
    const url = joinUrl(cfg.base_url, cfg.endpoint || '/chat/completions');

    const body = {
      model,
      messages: o.messages,
      temperature: o.temperature ?? st.temperature ?? 0.8,
      max_tokens: o.maxTokens ?? st.max_tokens ?? 8000,
      reasoning_effort: o.reasoningEffort ?? st.reasoning_effort ?? 'minimal',
    };

    // 默认走流式：推理模型思维链极长，非流式容易撞网关超时
    if (o.stream !== false) {
      return chatStream(url, cfg.api_key, body, model, o);
    }

    const data = await httpJson(url, { apiKey: cfg.api_key, body, timeout: o.timeout ?? DEFAULT_TIMEOUT });
    const choice = data?.choices?.[0] || {};
    const content = choice.message?.content ?? choice.text ?? '';
    return {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      usage: data?.usage || {},
      model,
    };
  }

  async function image(o) {
    const cfg = await getActiveConfig('image');
    if (!cfg) throw new Error('尚未配置图像模型，请先在设置里添加');

    const model = modelOf(cfg, o.model);
    const url = joinUrl(cfg.base_url, cfg.endpoint || '/images/generations');

    const body = {
      model,
      prompt: o.negativePrompt ? `${o.prompt}\n\n负面约束：${o.negativePrompt}` : o.prompt,
      n: 1,
      size: o.size || '1024x1024',
      response_format: 'url',
    };
    if (o.referenceImage) body.image = o.referenceImage;

    const data = await httpJson(url, { apiKey: cfg.api_key, body, timeout: 180_000 });
    const first = data?.data?.[0] || {};
    const out = first.url || (first.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
    if (!out) throw new Error('图像接口未返回图片地址：' + JSON.stringify(data).slice(0, 300));
    return { url: out, model, raw: data };
  }

  async function video(o) {
    const cfg = await getActiveConfig('video');
    if (!cfg) throw new Error('尚未配置视频模型，请先在设置里添加');

    const model = modelOf(cfg, o.model);
    const createUrl = joinUrl(cfg.base_url, cfg.endpoint || '/videos');

    const body = {
      model,
      prompt: o.prompt,
      ...(o.image ? { image: o.image } : {}),
      ...(o.duration ? { duration: o.duration } : {}),
      ...(o.params || {}),
    };

    const data = await httpJson(createUrl, { apiKey: cfg.api_key, body, timeout: 180_000 });
    const taskId =
      data?.task_id || data?.id || data?.data?.task_id || data?.data?.id || data?.output?.task_id || '';

    const directUrl =
      data?.video_url || data?.data?.video_url || data?.output?.video_url || data?.data?.[0]?.url || '';

    if (directUrl) {
      return { taskId: String(taskId || ''), status: 'completed', url: directUrl, model, raw: data };
    }
    if (!taskId) {
      throw new Error('视频接口未返回任务 ID：' + JSON.stringify(data).slice(0, 300));
    }
    return { taskId: String(taskId), status: 'processing', url: null, model, raw: data };
  }

  async function videoStatus(taskId) {
    const cfg = await getActiveConfig('video');
    if (!cfg) throw new Error('尚未配置视频模型');

    const tpl = cfg.query_endpoint || '/videos/{taskId}';
    const url = joinUrl(cfg.base_url, tpl.replace('{taskId}', encodeURIComponent(taskId)));
    const data = await httpJson(url, { method: 'GET', apiKey: cfg.api_key });

    const status = String(
      data?.status || data?.data?.status || data?.output?.task_status || ''
    ).toLowerCase();

    const outUrl =
      data?.video_url || data?.data?.video_url || data?.output?.video_url ||
      data?.data?.[0]?.url || data?.result?.video_url || '';

    const done = ['succeeded', 'success', 'completed', 'done', 'finished'].includes(status) || !!outUrl;
    const failed = ['failed', 'error', 'canceled', 'cancelled'].includes(status);

    return {
      status: done ? 'completed' : failed ? 'failed' : 'processing',
      url: outUrl || null,
      rawStatus: status || 'unknown',
      raw: data,
    };
  }

  async function audio(o) {
    const cfg = await getActiveConfig('audio');
    if (!cfg) throw new Error('尚未配置音频模型，请先在设置里添加');

    const model = modelOf(cfg, o.model);
    const url = joinUrl(cfg.base_url, cfg.endpoint || '/audio/speech');

    const body = {
      model,
      input: o.text || o.prompt || '',
      voice: o.voice || 'default',
      ...(o.params || {}),
    };

    const data = await httpJson(url, { apiKey: cfg.api_key, body, timeout: 180_000 });
    const outUrl = data?.url || data?.data?.url || data?.data?.[0]?.url || '';
    const b64 = data?.audio || data?.data?.audio || '';
    return {
      url: outUrl || (b64 ? `data:audio/mpeg;base64,${b64}` : ''),
      model,
      raw: data,
    };
  }

  async function probe({ serviceType, baseUrl, apiKey, model }) {
    const url = joinUrl(baseUrl, serviceType === 'text' ? '/chat/completions' : '/models');
    if (serviceType === 'text') {
      const data = await httpJson(url, {
        apiKey,
        body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 },
        timeout: 60_000,
      });
      return { ok: true, message: '连接测试成功', raw: data };
    }
    const data = await httpJson(url, { method: 'GET', apiKey, timeout: 30_000 });
    return { ok: true, message: '连接测试成功', raw: data };
  }

  return { chat, image, video, videoStatus, audio, probe, getActiveConfig };
}
