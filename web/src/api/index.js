/** 统一请求封装：所有接口返回 { success, data } 或 { success:false, error } */
const BASE = '/api';

async function req(method, path, body, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({ success: false, error: { message: '响应不是合法 JSON' } }));
    if (!json.success) throw new Error(json?.error?.message || `请求失败 (${res.status})`);
    return json.data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，模型可能仍在生成，请稍后刷新查看');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => req('GET', '/health'),

  /* 配置 */
  listConfigs: (type) => req('GET', '/ai-configs' + (type ? `?service_type=${type}` : '')),
  createConfig: (b) => req('POST', '/ai-configs', b),
  updateConfig: (id, b) => req('PUT', `/ai-configs/${id}`, b),
  deleteConfig: (id) => req('DELETE', `/ai-configs/${id}`),
  testConfig: (id) => req('POST', `/ai-configs/${id}/test`),

  /* 项目 */
  listDramas: () => req('GET', '/dramas'),
  createDrama: (b) => req('POST', '/dramas', b),
  getDrama: (id) => req('GET', `/dramas/${id}`),
  updateDrama: (id, b) => req('PUT', `/dramas/${id}`, b),
  deleteDrama: (id) => req('DELETE', `/dramas/${id}`),

  /* 剧集 */
  listEpisodes: (dramaId) => req('GET', `/dramas/${dramaId}/episodes`),
  createEpisode: (b) => req('POST', '/episodes', b),
  updateEpisode: (id, b) => req('PUT', `/episodes/${id}`, b),

  /* 分镜 */
  listStoryboards: (episodeId) => req('GET', `/episodes/${episodeId}/storyboards`),
  updateStoryboard: (id, b) => req('PUT', `/storyboards/${id}`, b),

  /* 画布 */
  getCanvas: (dramaId) => req('GET', `/dramas/${dramaId}/canvas`),
  saveCanvas: (dramaId, payload) => req('PUT', `/dramas/${dramaId}/canvas`, payload),
  getCanvasData: (dramaId) => req('GET', `/dramas/${dramaId}/canvas-data`),

  /* 生成 */
  genScript: (b) => req('POST', '/generate/script', b),
  genExtract: (b) => req('POST', '/generate/extract', b),
  genStoryboard: (b) => req('POST', '/generate/storyboard', b),
  genImage: (b) => req('POST', '/generate/image', b),
  genVideo: (b) => req('POST', '/generate/video', b),
  getTask: (id) => req('GET', `/generate/task/${id}`),

  /* 智能助手 */
  // 第 5 参 expertId 为可选；后端 buildSystemPrompt(expertId) 按需注入 persona，不传则模型按内容自决
  chat: (dramaId, episodeId, message, history, expertId) =>
    req('POST', '/chat', { dramaId, episodeId, message, history, expertId }, 120000),

  /* 流水线 */
  pipelineCreate: (b) => req('POST', '/pipeline/create', b),
  pipelineGet: (id) => req('GET', `/pipeline/${id}`),
  pipelineAdvance: (id) => req('POST', `/pipeline/${id}/advance`),

  /* 合成 */
  mergeCreate: (b) => req('POST', '/merge/create', b),
  mergeGet: (id) => req('GET', `/merge/${id}`),
  mergeByEpisode: (episodeId) => req('GET', `/merge/episode/${episodeId}`),
  mergeAdvance: (id, b) => req('POST', `/merge/${id}/advance`, b),
  mergeDispatch: (id) => req('POST', `/merge/${id}/dispatch`),

  /* GPU 配置 */
  gpuConfigs: () => req('GET', '/gpu/configs'),
  gpuConfigCreate: (b) => req('POST', '/gpu/configs', b),
  gpuConfigUpdate: (id, b) => req('PUT', `/gpu/configs/${id}`, b),
  gpuConfigDelete: (id) => req('DELETE', `/gpu/configs/${id}`),
  gpuConfigTest: (id) => req('POST', `/gpu/configs/${id}/test`),
};
