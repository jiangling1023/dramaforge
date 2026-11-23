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

async function httpJson(url, { method = 'POST', apiKey, body, timeout = DEFAULT_TIMEOUT, authScheme = 'Bearer' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `${authScheme} ${apiKey}` } : {}),
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
      // 必须带 status：上层 chat() 的降级判定依赖它判断是否为限流/额度错误
      const err = new Error(String(msg).slice(0, 400));
      err.status = res.status;
      throw err;
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

  /** 列出全部启用的文本配置，按优先级倒序（供限流降级逐个尝试） */
  async function listActiveConfigs(serviceType) {
    const rows = await db.select(
      'ai_configs',
      { service_type: serviceType, is_active: 1 },
      { order: 'is_default.desc,priority.desc,id.asc' }
    );
    return (rows || []).map(plain);
  }

  /** 单个配置执行一次对话请求（不含降级逻辑） */
  async function chatOnce(cfg, o) {
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

  // 可降级错误：限流、配额、模型下线、服务不可用 —— 这些都可能是单一配置的问题，换下一个配置即可。
  // 不降级的错误：请求体本身非法（如消息格式错误）——重试其它配置无意义，立即抛出。
  const shouldFallback = (e) => {
    const status = e?.status;
    const msg = String(e?.message || '').toLowerCase();
    if (status === 429 || status === 1015 || status === 503 || status === 502 || status === 520 || status === 402) return true;
    // 兜底：部分流式/网关错误只体现在 message 里（如 "HTTP 429"），status 可能缺失
    if (/^http (429|402|500|502|503|504|520)\b/.test(msg)) return true;
    return /\b1015\b/.test(msg)
      || /rate.?limit|too many requests|quota|overloaded|限流|频率/.test(msg)
      || /model does not exist|invalid model|model not found|模型不存在|模型.*(不存在|无效)/.test(msg)
      || /no access to model|invalid token|invalid api.?key|authentication|unauthorized|令牌|密钥.*(无效|错误)/.test(msg)
      || /insufficient.*balance|balance.*insufficient|余额不足|欠费|支付 Required|payment required/.test(msg)
      || /service unavailable|暂时不可用/.test(msg);
  };

  async function chat(o) {
    // 降序尝试所有启用的文本配置：主配置限流/模型下线时自动切换下一个
    const configs = await listActiveConfigs('text');
    if (!configs.length) throw new Error('尚未配置文本模型，请先在设置里添加');

    let lastErr;
    for (const cfg of configs) {
      try {
        return await chatOnce(cfg, o);
      } catch (e) {
        lastErr = e;
        if (!shouldFallback(e)) throw e;
        // 可降级错误：换下一个配置；已是最后一个则跳出
      }
    }
    throw new Error(`全部文本模型均不可用: ${lastErr?.message || '未知错误'}`);
  }

  async function image(o) {
    const cfg = await getActiveConfig('image');
    if (!cfg) throw new Error('尚未配置图像模型，请先在设置里添加');

    // provider=agnes：OpenAI 兼容，但用 size:"2K" + ratio + extra_body.response_format
    if (cfg.provider === 'agnes') {
      const model = modelOf(cfg, o.model);
      const url = joinUrl(cfg.base_url, cfg.endpoint || '/images/generations');
      const st = settingsOf(cfg);
      const body = {
        model,
        prompt: o.negativePrompt ? `${o.prompt}\n\n负面约束：${o.negativePrompt}` : o.prompt,
        size: o.size || st.size || '2K',
        ratio: o.ratio || st.ratio || '16:9',
        extra_body: { response_format: 'url' },
      };
      if (o.referenceImage) body.image = o.referenceImage;
      const data = await httpJson(url, { apiKey: cfg.api_key, body, timeout: 180_000 });
      const first = data?.data?.[0] || {};
      const out = first.url || (first.b64_json ? `data:image/png;base64,${first.b64_json}` : '') || data?.url || '';
      if (!out) throw new Error('agnes 图像接口未返回图片地址：' + JSON.stringify(data).slice(0, 300));
      return { url: out, model, raw: data };
    }

    // provider=fal：fal 图像接口同步返回 JSON，含 images[].url
    if (cfg.provider === 'fal') {
      const model = modelOf(cfg, o.model);
      const base = String(cfg.base_url || '').replace(/\/+$/, '') || 'https://fal.run';
      const url = joinUrl(base, '/' + model.replace(/^\/+/, ''));
      const input = { prompt: o.negativePrompt ? `${o.prompt}\n\n负面约束：${o.negativePrompt}` : o.prompt };
      if (o.size) input.image_size = o.size;
      if (o.referenceImage) input.image_url = o.referenceImage;

      const data = await httpJson(url, { apiKey: cfg.api_key, body: input, timeout: 180_000, authScheme: 'Key' });
      const first = Array.isArray(data?.images) ? data.images[0] : null;
      const out = first?.url || data?.image?.url || data?.url || '';
      if (!out) throw new Error('fal 图像接口未返回图片地址：' + JSON.stringify(data).slice(0, 300));
      return { url: out, model, raw: data };
    }

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

    // provider=agnes：POST /v1/videos 返回 video_id；轮询 GET /agnesapi?video_id=&model_name=
    if (cfg.provider === 'agnes') {
      const model = modelOf(cfg, o.model);
      const st = settingsOf(cfg);
      const createUrl = joinUrl(cfg.base_url, cfg.endpoint || '/videos');
      const body = {
        model,
        prompt: o.prompt,
        mode: o.mode || st.mode || 'text',
        seconds: String(o.duration || st.seconds || 5),
        size: st.size || '720P',
        aspect_ratio: o.ratio || st.aspect_ratio || '16:9',
        n: 1,
      };
      if (o.image) {
        body.mode = 'keyframe';
        body.first_frame = o.image;
      }
      const data = await httpJson(createUrl, { apiKey: cfg.api_key, body, timeout: 120_000 });
      const taskId = data?.video_id || data?.id || data?.task_id || data?.data?.video_id || '';
      if (!taskId) {
        // agnes 队列满/额度不足时返回 {code, message, data:null}，把 message 透传出来
        const msg = data?.message || data?.error?.message || JSON.stringify(data).slice(0, 200);
        throw new Error('agnes 视频任务创建失败：' + msg);
      }
      return { taskId: String(taskId), status: 'processing', url: null, model, raw: data };
    }

    // provider=fal 走 fal.ai 队列 API（GPU 云）：POST /{model_id} 提交任务，返回 request_id
    if (cfg.provider === 'fal') {
      const model = modelOf(cfg, o.model);
      const base = String(cfg.base_url || '').replace(/\/+$/, '') || 'https://queue.fal.run';
      const createUrl = joinUrl(base, '/' + model.replace(/^\/+/, ''));
      const input = { prompt: o.prompt };
      if (o.image) input.image_url = o.image;
      if (o.duration) input.duration = o.duration;
      const data = await httpJson(createUrl, { apiKey: cfg.api_key, body: input, timeout: 60_000 });
      const requestId = data?.request_id || data?.id || '';
      if (!requestId) {
        throw new Error('fal 未返回 request_id：' + JSON.stringify(data).slice(0, 300));
      }
      // fal 的 status_fetch_url / status_url 指向轮询端点，记录在 raw 里，videoStatus 会再读配置
      return { taskId: String(requestId), status: 'processing', url: null, model, raw: data };
    }

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

  async function videoStatus(taskId, model) {
    const cfg = await getActiveConfig('video');
    if (!cfg) throw new Error('尚未配置视频模型');

    // provider=agnes：GET {origin}/agnesapi?video_id=&model_name= （在 /v1 之外）
    if (cfg.provider === 'agnes') {
      const m = model || cfg.default_model || 'agnes-video-2.5-flash';
      // base_url 形如 https://api.agnes-ai.cn/v1 → 取 origin
      let origin = String(cfg.base_url || '').replace(/\/+$/, '');
      origin = origin.replace(/\/v1\/?$/, '');
      const url = `${origin}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(m)}`;
      const data = await httpJson(url, { method: 'GET', apiKey: cfg.api_key, timeout: 60_000 });

      const status = String(data?.status || '').toLowerCase();
      const outUrl = data?.url || data?.video_url || data?.data?.url
        || (Array.isArray(data?.results?.videos) ? data.results.videos[0]?.url : '')
        || (Array.isArray(data?.videos) ? data.videos[0]?.url : '');

      const done = ['completed', 'succeeded', 'success', 'done', 'finished'].includes(status) || !!outUrl;
      const failed = ['failed', 'error', 'canceled', 'cancelled'].includes(status);

      return {
        status: done ? 'completed' : failed ? 'failed' : 'processing',
        url: outUrl || null,
        rawStatus: status || 'unknown',
        raw: data,
      };
    }

    // provider=fal：轮询 https://queue.fal.run/{model_id}/requests/{request_id}/status
    if (cfg.provider === 'fal') {
      const m = model || cfg.default_model || '';
      const base = String(cfg.base_url || '').replace(/\/+$/, '') || 'https://queue.fal.run';
      const url = `${base}/${m.replace(/^\/+/, '')}/requests/${encodeURIComponent(taskId)}/status`;
      const data = await httpJson(url, { method: 'GET', apiKey: cfg.api_key, authScheme: 'Key' });

      const status = String(data?.status || '').toLowerCase();
      const outUrl = data?.output?.video_url || data?.output?.url
        || (Array.isArray(data?.output?.videos) ? data.output.videos[0]?.url : '')
        || data?.result?.video_url || '';

      const done = ['completed', 'succeeded', 'done', 'finished'].includes(status) || !!outUrl;
      const failed = ['failed', 'error', 'canceled', 'cancelled'].includes(status);

      return {
        status: done ? 'completed' : failed ? 'failed' : 'processing',
        url: outUrl || null,
        rawStatus: status || 'unknown',
        raw: data,
      };
    }

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

  return { chat, image, video, videoStatus, audio, probe, getActiveConfig, listActiveConfigs };
}
