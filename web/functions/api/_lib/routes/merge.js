/**
 * 合成路由（API-M01~M04）：只做参数透传与响应映射，逻辑在 services/merge.js。
 * 注意 /episode/:episodeId 必须注册在 /:id 之前，否则会被动态段吞掉。
 */
import { Hono } from 'hono';
import { create, get, listByEpisode, advance, dispatch } from '../services/merge.js';

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

    // G-003 自动分发：尽力而为，不阻断创建。
    // 无自动分发配置时保持 pending，由前端「发送到 GPU」手动触发（G-004）；
    // 命中幂等已有任务时 dispatch 会返回 CONFLICT，同样忽略，真实状态交给轮询。
    const origin = new URL(c.req.url).origin;
    const dispatched = await dispatch(db, res.data.mergeId, origin);
    if (!dispatched.error) {
      const fresh = await get(db, res.data.mergeId);
      return ok(c, fresh.data ? { ...res.data, status: fresh.data.status } : res.data);
    }
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

  // G-004 手动分发：前端「发送到 GPU」入口，复用 dispatch
  r.post('/:id/dispatch', async (c) => {
    const origin = new URL(c.req.url).origin;
    const res = await dispatch(db, c.req.param('id'), origin);
    if (res.error) return bad(c, res.error.message, res.error.status, res.error.code);
    return ok(c, res.data);
  });

  return r;
}
