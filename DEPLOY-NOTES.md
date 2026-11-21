# DramaForge 部署说明

## 当前状态

### ✅ 已部署
- **Cloudflare Pages（前端静态资源）**: https://dramaforge-app.pages.dev
- **部署脚本**: `deploy-pages.sh`

### ⚠️ 待部署
- **Server Worker（API 后端）**: 需要单独部署到 Cloudflare Workers
- **D1 数据库**: 已在 Cloudflare 控制台创建

---

## GitHub Actions 问题

所有 GitHub Actions workflow 在 "Set up job" 阶段失败，billable 时间为 0ms。

**可能原因**:
1. GitHub 免费账户的 Actions 配额限制
2. Runner 无法分配（网络问题）
3. Workflow 触发条件不满足

**解决方案**: 使用本地部署脚本代替 GitHub Actions

---

## 本地部署步骤

### 1. 部署前端到 Cloudflare Pages
```bash
cd /path/to/dramaforge-web
bash deploy-pages.sh
```

### 2. 部署 Server Worker（需配置）
```bash
# 安装 wrangler CLI
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 部署 worker
cd server-worker
wrangler deploy
```

### 3. 配置 D1 数据库绑定
在 Cloudflare 控制台:
1. 进入 Pages 项目 dramaforge-app
2. Settings → Bindings → Add binding
3. 选择 D1 数据库 dramaforge-db
4. Variable name: `DB`

---

## 完整架构

```
用户 → Cloudflare Pages (前端) → Cloudflare Workers (API) → D1 数据库
                ↓
         dramaforge-app.pages.dev
```

---

## 文件结构

```
dramaforge-web/
├── deploy-pages.sh          # 前端部署脚本
├── server-worker/           # API 后端（需单独部署）
│   ├── wrangler.toml
│   ├── src/
│   │   └── index.js
│   └── package.json
├── web/                     # 前端应用
│   ├── dist/               # 构建产物
│   ├── src/
│   └── package.json
└── .github/workflows/       # GitHub Actions（暂时不可用）
    ├── deploy-pages.yml
    └── build-windows.yml
```

---

## 下一步

1. 部署 server-worker 到 Cloudflare Workers
2. 配置 D1 数据库绑定
3. 测试完整 API 链路
4. 考虑使用 Gitee Actions 替代 GitHub Actions
