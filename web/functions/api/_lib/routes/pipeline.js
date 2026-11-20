/**
 * 流水线路由（API-P01/P02/P03）：只做参数透传与响应映射，状态机在 services/pipeline.js。
 */
import { Hono } from 'hono';
import { create, advance, statusSnapshot } from '../services/pipeline.js';

const ok = (c, data) => c.json({ success: true, data });
const ERROR_CODES = {
  400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 504: 'TASK_TIMEOUT',
};
// 与 api.js 的 bad 同签名：第 4 参传业务码，第 5 参承载 data.existingTaskId
const bad = (c, message, status = 400, code, data) => {
  const body = { success: false, error: { message, code: code || ERROR_CODES[status] || 'INTERNAL_ERROR' } };
  if (data) body.data = data;
  return c.json(body, status);
};
const send = (c, res) => (res.error
  ? bad(c, res.error.message, res.error.status, res.error.code, res.error.data)
  : ok(c, res.data));

export function pipelineRoutes(db, ai) {
  const r = new Hono();

  r.post('/create', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return send(c, await create(db, ai, body));
  });

  r.get('/:id', async (c) => send(c, await statusSnapshot(db, c.req.param('id'))));

  r.post('/:id/advance', async (c) => send(c, await advance(db, ai, c.req.param('id'))));

  return r;
}
