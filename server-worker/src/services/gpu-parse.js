/**
 * GPU 自然语言解析服务
 * 从用户自然语言中提取云 GPU 连接信息，生成结构化配置草案
 */

/** 厂商名称规范化 */
function normalizeProvider(text) {
  const t = text.toLowerCase();
  if (t.includes('runpod') || t.includes('run pod') || t.includes('run-pod')) return 'runpod';
  if (t.includes('vast.ai') || t.includes('vastai') || t.includes('vast ai')) return 'vastai';
  // AutoDL 算力云：官网 autodl，容器域名 seetacloud.com（形如 xxx.bjb1.seetacloud.com:8443）
  if (t.includes('autodl') || t.includes('auto dl') || t.includes('seetacloud') || t.includes('算力云')) return 'autodl';
  if (t.includes('自建') || t.includes('custom') || t.includes('private') || t.includes('self')) return 'custom';
  return null;
}

/** 从文本中提取 API Key（支持多种命名） */
function extractApiKey(text) {
  const patterns = [
    /api[\s_-]*key[\s:="']+([a-zA-Z0-9_\-]{16,})/i,
    /key[\s:="']+([a-zA-Z0-9_\-]{16,})/i,
    /token[\s:="']+([a-zA-Z0-9_\-]{16,})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

/** 提取 URL（http/https 开头） */
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s,，。)）]+/i);
  return m ? m[0] : null;
}

/** 提取 Endpoint ID（非 URL 的标识串） */
function extractEndpointId(text) {
  const url = extractUrl(text);
  if (url) {
    // 从 URL 中提取最后一段路径作为 ID
    const parts = url.replace(/\/$/, '').split('/');
    const last = parts[parts.length - 1];
    if (last && last !== 'v2' && last !== 'v1' && last !== 'api') return last;
  }
  // 尝试匹配 endpoint_id=xxx 或 endpoint xxx
  const m = text.match(/endpoint[\s_]*id[\s:="']+([a-zA-Z0-9_\-]{6,})/i)
    || text.match(/endpoint[\s:="']+([a-zA-Z0-9_\-]{6,})/i);
  if (m) return m[1];
  return null;
}

/** 提取 SSH 连接信息（Vast.ai） */
function extractSshInfo(text) {
  // ssh://user@host:port
  const m1 = text.match(/ssh:\/\/(?:([^@]+)@)?([^:/\s]+)(?::(\d+))?/i);
  if (m1) return { ssh_user: m1[1] || 'root', ssh_host: m1[2], ssh_port: m1[3] || '22' };
  // user@host 格式
  const m2 = text.match(/(\w+)@([a-zA-Z0-9.\-]+)/);
  if (m2) return { ssh_user: m2[1], ssh_host: m2[2], ssh_port: '22' };
  return null;
}

/** 提取 SSH Key Path */
function extractSshKeyPath(text) {
  const m = text.match(/(?:ssh[\s_]*key[\s_]*path|key[\s_]*file|\.ssh\/[\w.\-]+)[\s:="']*([^\s,，。)）]+)/i);
  if (m) return m[1];
  // 直接匹配路径
  const m2 = text.match(/\.ssh\/[\w.\-]+/i);
  return m2 ? m2[0] : null;
}

/** 提取实例标签（Vast.ai 实例标签过滤） */
function extractInstanceTag(text) {
  const m = text.match(/(?:实例标签|instance[\s_]*tag|标签|tag)[\s:="']*([^\s,，。)）]+)/i);
  return m ? m[1] : null;
}

/** 提取 Base URL（自建 GPU 服务） */
function extractBaseUrl(text) {
  return extractUrl(text);
}

/**
 * 主函数：从自然语言解析 GPU 连接信息
 * @param {string} naturalText - 用户输入的自然语言文本
 * @returns {{ provider: string|null, name: string, config_json: object, missing_fields: string[], suggestions: string[] }}
 */
export function gpuParseConnection(naturalText) {
  const text = String(naturalText || '').trim();
  const provider = normalizeProvider(text);
  const name = extractName(text);
  const missing = [];
  const suggestions = [];

  const config_json = {};

  if (!provider) {
    missing.push('provider');
    suggestions.push('请指定厂商：AutoDL、RunPod、Vast.ai 或自建（也可直接粘贴 seetacloud 容器链接）');
  } else {
    // 厂商特定字段提取
    switch (provider) {
      case 'runpod': {
        const apiKey = extractApiKey(text);
        const endpointId = extractEndpointId(text);
        const endpointUrl = extractUrl(text);
        if (apiKey) config_json.api_key = apiKey; else missing.push('api_key');
        if (endpointId) config_json.endpoint_id = endpointId; else missing.push('endpoint_id');
        if (endpointUrl) config_json.endpoint_url = endpointUrl;
        break;
      }
      case 'vastai': {
        const apiKey = extractApiKey(text);
        const ssh = extractSshInfo(text);
        const keyPath = extractSshKeyPath(text);
        const tag = extractInstanceTag(text);
        if (apiKey) config_json.api_key = apiKey; else missing.push('api_key');
        if (ssh) {
          config_json.ssh_user = ssh.ssh_user;
          config_json.ssh_host = ssh.ssh_host;
          config_json.ssh_port = ssh.ssh_port;
        } else {
          missing.push('ssh_host', 'ssh_user');
        }
        if (keyPath) config_json.ssh_key_path = keyPath; else missing.push('ssh_key_path');
        if (tag) config_json.instance_tag = tag;
        break;
      }
      case 'autodl': {
        // AutoDL「链接转代码」：容器访问链接（*.seetacloud.com:8443）直接作为 base_url，
        // 容器内需自启 HTTP 服务暴露 /health 与 /api/v1/tasks；api_key 可选（容器无鉴权时可留空）。
        const baseUrl = extractBaseUrl(text);
        const apiKey = extractApiKey(text);
        if (baseUrl) config_json.base_url = baseUrl; else missing.push('base_url');
        if (apiKey) config_json.api_key = apiKey;
        suggestions.push('已识别为 AutoDL 容器链接；请在容器内启动接收合成任务的 HTTP 服务（/health 与 /api/v1/tasks）');
        break;
      }
      case 'custom': {
        const baseUrl = extractBaseUrl(text);
        const apiKey = extractApiKey(text);
        if (baseUrl) config_json.base_url = baseUrl; else missing.push('base_url');
        if (apiKey) config_json.api_key = apiKey; else missing.push('api_key');
        break;
      }
    }
  }

  return { provider, name, config_json, missing_fields: missing, suggestions };
}

/** 从文本提取配置名称 */
function extractName(text) {
  // 尝试匹配引号内的名称
  const m = text.match(/["「『]([^"」』]+)["」』]/);
  if (m) return m[1];
  // 否则用默认名称
  return `GPU 配置 ${new Date().toLocaleDateString('zh-CN')}`;
}

/**
 * 将解析结果保存到 gpu_configs 表
 * 内部调用 POST /api/gpu/configs 的逻辑（复用 gpu.js 路由）
 * @param {object} db - 数据库实例
 * @param {object} parsedConfig - 解析后的配置对象
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function gpuConfigSave(db, parsedConfig) {
  const { provider, name, config_json, webhook_secret, auto_dispatch, capabilities } = parsedConfig;

  if (!provider || !name || !config_json) {
    return { success: false, error: '缺少必填字段: provider, name, config_json' };
  }
  if (!['runpod', 'vastai', 'custom', 'autodl'].includes(provider)) {
    return { success: false, error: `不支持的厂商: ${provider}` };
  }

  const now = Date.now();
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
    created_at: now,
    updated_at: now,
  });

  return { success: true, data: row };
}

/**
 * 触发连通性测试（复用 gpu.js 的 testConnectivity 逻辑）
 * @param {object} db - 数据库实例
 * @param {string} configId - gpu_configs 表的 id
 * @returns {Promise<{ ok: boolean, detail: string, sample?: any }>}
 */
export async function gpuTestConnectivity(db, configId) {
  const cfg = await db.first('gpu_configs', { id: configId });
  if (!cfg) throw new Error('配置不存在');

  const config = typeof cfg.config_json === 'string' ? JSON.parse(cfg.config_json) : cfg.config_json;

  // 直接实现连通性测试，避免循环依赖
  const fetchWithTimeout = (url, options = {}, timeoutMs = 10000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  };

  let result;
  if (cfg.provider === 'runpod') {
    const endpointId = config.endpoint_id || config.endpointId;
    const apiKey = config.api_key || config.apiKey;
    if (!endpointId || !apiKey) throw new Error('缺少 endpoint_id 或 api_key');
    const url = `https://api.runpod.ai/v2/${endpointId}/health`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 404 || res.status === 401) throw new Error(`${res.status} ${res.statusText}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    result = { ok: true, detail: '连通正常' };
  } else if (cfg.provider === 'vastai') {
    const apiKey = config.api_key || config.apiKey;
    if (!apiKey) throw new Error('缺少 api_key');
    const url = 'https://console.vast.ai/api/v0/instances/';
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    result = { ok: true, detail: '连通正常' };
  } else if (cfg.provider === 'custom' || cfg.provider === 'autodl') {
    const baseUrl = config.base_url || config.baseUrl;
    const apiKey = config.api_key || config.apiKey;
    if (!baseUrl) throw new Error('缺少 base_url');
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== 'ok') throw new Error('health 返回 status 非 ok');
    result = { ok: true, detail: '连通正常' };
  } else {
    throw new Error(`未知厂商: ${cfg.provider}`);
  }

  const testAt = Date.now();
  await db.update('gpu_configs', { id: configId }, {
    status: result.ok ? 'connected' : 'error',
    last_test_at: testAt,
    last_test_error: result.ok ? null : result.detail,
    updated_at: testAt,
  });

  return result;
}