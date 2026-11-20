/**
 * 合成路由（API-M01~M04）：只做参数透传与响应映射，逻辑在 services/merge.js。
 * 注意 /episode/:episodeId 必须注册在 /:id 之前，否则会被动态段吞掉。
 */
import { Hono } from 'hono';
import { create, get, listByEpisode, advance } from '../services/merge.js';

const ok = (c, data) => c.json({ success: true, data });
const CODES = { 400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT' };
const bad = (c, message, status = 400, code) => c.json(
  { success: false, error: { message, code: code || CODES[status] || 'INTERNAL_ERROR' } },
  status
);

export function mergeRoutes(db, ai) {
  const r = new Hono();

  // API-M01 提交合成
  r.post('/create', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await create(db, body);
    if (res.error) return bad(c, res.error.message, res.error.status, res.error.code);
    return ok(c, res.data);
  });

  // API-M03 按集取最新任务（静态段优先）
  r.get('/episode/:episodeId', async (c) => {
    const res = await listByEpisode(db, c.req.param('episodeId'));
    if (res.error) return bad(c, res.error.message, res.error.status, res.error.code);
    return ok(c, res.data);
  });

  // API-M02 按 id 查（轮询）
  r.get('/:id', async (c) => {
    const res = await get(db, c.req.param('id'));
    if (res.error) return bad(c, res.error.message, res.error.status, res.error.code);
    return ok(c, res.data);
  });

  // API-M04 GPU 回调占位
  r.post('/:id/advance', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await advance(db, c.req.param('id'), body);
    if (res.error) return bad(c, res.error.message, res.error.status, res.error.code);
    return ok(c, res.data);
  });

  return r;
}
