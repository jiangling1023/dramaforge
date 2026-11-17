/**
 * 服务入口
 * - /api/*   业务接口
 * - 其余     静态资源（web/dist），单页应用兜底到 index.html
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from './routes/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8801);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '16mb' }));

// 开发期允许本地前端跨域
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', api);

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: '7d', index: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ success: false, error: { message: '接口不存在' } });
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.type('html').send(
      '<pre style="font:14px/1.6 monospace;padding:24px">DramaForge 后端已启动\n\n' +
      '前端尚未构建：cd web && npm i && npm run build\n' +
      '或开发模式：cd web && npm run dev\n\n' +
      `接口自检：http://${HOST}:${PORT}/api/health</pre>`
    )
  );
}

app.listen(PORT, HOST, () => {
  console.log(`[DramaForge] http://${HOST}:${PORT}`);
  console.log(`[DramaForge] 静态目录: ${fs.existsSync(webDist) ? webDist : '(未构建)'}`);
});
