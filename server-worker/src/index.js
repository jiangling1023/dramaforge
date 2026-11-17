/**
 * Workers 入口
 *
 * 设计要点：
 *   1. db / ai 需要 env（SUPABASE_URL 等），但 env 只在请求时可取。
 *      这里用「首次请求初始化 + 惰性转发」的方式，让路由层可以直接用 db/ai。
 *   2. 同一个 Worker 实例的 env 是稳定的，所以模块级缓存是安全的。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createDb } from './db.js';
import { createAi } from './adapters/ai.js';
import { apiRoutes } from './routes/api.js';

let _db = null;
let _ai = null;

function bind(env) {
  if (_db) return;
  _db = createDb(env);
  _ai = createAi(_db);
}

// 惰性转发：方法调用时才落到真正的实例上
const dbLazy = {
  select: (...a) => _db.select(...a),
  first: (...a) => _db.first(...a),
  insert: (...a) => _db.insert(...a),
  insertOne: (...a) => _db.insertOne(...a),
  update: (...a) => _db.update(...a),
  upsert: (...a) => _db.upsert(...a),
  remove: (...a) => _db.remove(...a),
  count: (...a) => _db.count(...a),
};

const aiLazy = {
  chat: (...a) => _ai.chat(...a),
  image: (...a) => _ai.image(...a),
  video: (...a) => _ai.video(...a),
  videoStatus: (...a) => _ai.videoStatus(...a),
  audio: (...a) => _ai.audio(...a),
  probe: (...a) => _ai.probe(...a),
  getActiveConfig: (...a) => _ai.getActiveConfig(...a),
};

const app = new Hono();

app.use('*', async (c, next) => {
  bind(c.env);
  await next();
});

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.get('/', (c) => c.json({
  app: 'DramaForge API',
  runtime: 'cloudflare-workers',
  version: '0.2.0',
  endpoints: '/api/*',
}));

app.route('/api', apiRoutes(dbLazy, aiLazy));

app.notFound((c) => c.json({ success: false, error: { message: '接口不存在' } }, 404));

app.onError((err, c) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  return c.json({ success: false, error: { message: err.message || '服务内部错误' } }, status);
});

// 两种挂载方式都支持：
//   Worker：default.fetch
//   Pages Functions：具名导出 app，由 [[path]].js 转发
export { app };
export default {
  fetch: app.fetch,
};
