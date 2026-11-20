# DramaForge 部署发布流程（换机交接版）

> 面向换机后一无所知的使用者。所有命令与结论均在本机实测；「实测」= 本次实际执行观察到的输出。
> 线上 `v0.2.0` ｜ 代码 HEAD `3c0706c` ｜ 站点 <https://dramaforge-app.pages.dev>
> 部署形态：Cloudflare Pages（静态资源 + Pages Functions）+ D1（SQLite），无自有服务器、无域名备案。

## 0. 三十秒速览

| 项 | 值 |
|---|---|
| 线上地址 | `https://dramaforge-app.pages.dev` |
| Cloudflare 账户 | `195728e627f02c9a0c5b12633ae74c5b`（`Jl5436@163.com's Account`） |
| Pages 项目名 | `dramaforge-app`（**不是** `dramaforge`，那是另一个项目） |
| D1 数据库 | `dramaforge-db` / UUID `f34ceddd-a341-46a2-a00f-73f82747a270` |
| 部署命令 CWD | **必须在 `web/` 内执行**（§6.3） |
| Node 路径 | `/home/jiangl1023/.workbuddy/binaries/node/versions/22.22.2/bin/node`（v22.22.2） |
| 必加参数 | `--disable-wasm-trap-handler`（否则构建崩溃） |
| 换机取代码 | **用归档 `dramaforge-web-v0.2.0.tar.gz`**，不可只靠 `git clone`（§3） |

**一键自检**：完整命令见 §2（环境）→ §3.2（取码）→ §6.1（部署四步）→ §6.4（验证），末尾 §11 为上线检查清单。

## 1. 架构速览

```
浏览器 ─①GET /─▶ Cloudflare Edge (CDN)
   ├─②命中静态资源 → 返回 dist/ 的 index.html / assets/*
   └─③/api/* 未命中 → Pages 项目 dramaforge-app
        ├─ 静态层: web/dist/                          ← vite build 产物
        └─ 函数层: web/functions/api/[[path]].js     ← catch-all 承接所有 /api/*
             └─ Hono app (web/functions/api/_lib/index.js)
                ├─ routes/api.js       CRUD: dramas/episodes/storyboards/canvas/ai-configs
                ├─ routes/generate.js  /generate/script|extract|storyboard|image|video|task/:id
                ├─ routes/chat.js      /chat、/chat/history/:dramaId
                ├─ services/  prompts、assistant   ├─ adapters/ai.js  provider 适配 (openai/agnes/fal)
                └─ db.js     数据层 (env.DB → D1)
       ─④SQL(prepare/bind/run)─▶ D1 dramaforge-db (SQLite) 18 表 + _cf_KV
```
18 张表：`ai_configs, app_settings, canvas_layout, characters, chat_messages, chat_sessions, dramas, episode_characters, episode_props, episodes, episode_scenes, gen_tasks, merges, props, scenes, storyboard_characters, storyboard_props, storyboards`

| 关键事实 | 说明 |
|---|---|
| 前后端同域 | 前端 `BASE='/api'`（`web/src/api/index.js`），函数挂同域 `/api/*`，**无跨域、无需 CORS 预检** |
| 线上跑的是 `_lib` | `web/functions/api/_lib/` 是 `server-worker/src/` 的**副本**。改 `src/` 不自动生效，**必须手动 cp**（铁律 §6.1） |
| D1 绑定 | `web/wrangler.toml` 中 `binding="DB"`，代码用 `env.DB` 取用 |
| AI 密钥存放 | **不入代码库**，存 D1 `ai_configs.api_key`。接口返回时 `maskKey` 脱敏（实测 `sk-d****Iq7C`） |
| SPA 兜底 | 顶层无 `404.html`，Pages 默认按 SPA 处理：未命中静态资源的路径返回根 `index.html`（实测 `/some/deep/path` → 200 HTML） |

| 路径 | 处置 |
|---|---|
| `dramaforge-web/web/` | ✅ 保留：前端 + Pages Functions + `wrangler.toml` + `dist/` |
| `dramaforge-web/server-worker/` | ✅ 保留：后端「源」，`src/` 是 `_lib` 真身，`node_modules` 内含 wrangler CLI |
| `dramaforge-web/server/` | ⚠️ 废弃的旧 Node+SQLite+Supabase 版，**仅留作 schema 参考**（`server/src/db/schema.sql` 是 D1 建表脚本来源，18 张表，**建表仍要用**） |
| `dramaforge-web/package.json` | ✅ 保留：workspace 根（workspaces: web, server） |
| `dramaforge/` | ❌ 废弃旧服务端版本（Node+SQLite），换机**不要带走** |
| `dramaforge-web-v0.2.0.tar.gz` | ✅ 新机器用这个（已排除密钥与 node_modules） |
| `dramaforge-web-history.bundle` | ✅ 备选：保留完整 git 历史 |
| `dramaforge-web.tar.gz` | ⚠️ **已过期**（server-worker 条目数=0，D1 迁移前版本） |

## 2. 新机器环境准备清单

| 项 | 要求 | 实测值 |
|---|---|---|
| Node | v22.22.2（≥22.5.0） | `/home/jiangl1023/.workbuddy/binaries/node/versions/22.22.2/bin/node` → v22.22.2 |
| npm | 随 Node | registry `https://registry.npmjs.org/`，`npm ping` → PONG 995ms |
| wrangler | **用 `server-worker` 依赖提供的，勿全局装** | `server-worker/node_modules/wrangler` → 4.163.0 |
| vite | 用 `web` 依赖提供的 | `web/node_modules/vite` → 6.4.6 |
| git | 任意近期版本 | `init.defaultbranch=main` |

**⚠️ 坑 1 — Wasm trap handler 与 4GB 虚拟内存冲突（构建必崩）**：Node 22/24 默认启用 Wasm trap handler，与本环境 4GB 虚拟内存限制冲突，导致 vite / wrangler 构建崩溃。**所有 node 调用必须加 `--disable-wasm-trap-handler`**。
**⚠️ 坑 2 — Node 路径不要写死到别的版本**：`ls -d /home/jiangl1023/.workbuddy/binaries/node/versions/*/bin/node`（选 22.22.2），然后 `export NODE=/home/jiangl1023/.workbuddy/binaries/node/versions/22.22.2/bin/node`。

**依赖安装（顺序有讲究）**：**不要在仓库根跑 `npm install`** —— 根 `package.json` 的 workspaces 是 `["web","server"]`，会把废弃的 `server/`（express + @supabase/supabase-js）一起装进来。
```bash
cd /path/to/dramaforge-web/web && npm install --no-audit --no-fund              # 61 包 / 31s（实测）
cd /path/to/dramaforge-web/server-worker && npm install --no-audit --no-fund   # 92 包 / 25s（实测）
```
> `server-worker/node_modules/wrangler/bin/wrangler.js` 是部署 CLI 实际路径，必须装好。
> **环境自检**：`cd web && $NODE --disable-wasm-trap-handler node_modules/vite/bin/vite.js build` → 预期 `✓ 17 modules transformed`、`dist/index.html 0.48 kB`、`dist/assets/index--KduZpIy.css 11.25 kB`、`dist/assets/index-C45AXbr6.js 94.18 kB`、`✓ built in 3.44s`（实测）。

## 3. 代码获取方式

### 3.1 为什么不能只靠 `git clone`（实测）
GitHub 远端 `main` 只到 `65256f1`，本地已到 `3c0706c`。**中间 4 个提交（`6f33095` D1 迁移、`f75abeb` 修 upsert、`e5c5306` fal、`3c0706c` agnes）从未推送成功**（历史上 GitHub push 多次因代理 502 / SIGTERM 失败）。`git clone https://github.com/jiangling1023/dramaforge.git` 拿到的最新是 `65256f1`，其 `web/functions/api/_lib/db.js` 还是 **PostgREST 客户端**（非 D1 层）、**没有** `web/wrangler.toml`（无 D1 绑定）、缺 `server-worker/`（无 wrangler CLI）。**照此部署 = 上线一个连不上 D1 的旧后端。**

### 3.2 首选：打包归档（推荐走这条）
工作区根目录已备好并验证：`dramaforge-web-v0.2.0.tar.gz`（216 KB，85 条目，含 `server-worker/` + `web/functions/` + `schema.sql`，已排除 `node_modules`、`.git`、`.env`、`*.db`）、`dramaforge-web-history.bundle`（229 KB，git bundle，含全部 8 个提交，`git bundle verify` 实测 complete history）。

```bash
# 1) 解压
mkdir -p ~/WorkBuddy/2026-11-16-07-39-42 && cd ~/WorkBuddy/2026-11-16-07-39-42
tar xzf /path/to/dramaforge-web-v0.2.0.tar.gz

# 2) 可选：恢复 git 历史（应输出 3c0706c Add agnes-ai adapter ...）
cd dramaforge-web
git clone /path/to/dramaforge-web-history.bundle _tmp && rm -rf .git && mv _tmp/.git .git && git log --oneline -1

# 3) 装依赖（见 §2）
cd web && npm install --no-audit --no-fund
cd ../server-worker && npm install --no-audit --no-fund

# 4) 完整性校验（全 OK 才继续）
for f in web/wrangler.toml "web/functions/api/[[path]].js" web/functions/api/_lib/index.js \
         web/functions/api/_lib/db.js server-worker/src/index.js \
         server-worker/package.json server/src/db/schema.sql; do
  [ -f "$f" ] && echo "OK  $f" || echo "MISSING  $f"; done
```

### 3.3 备选：直接 clone（仅当已能 push 远端）
`git clone git@github.com:<你的账号>/dramaforge-web.git`；用 `git log --oneline origin/main..HEAD` 确认远端是否落后；或 `git bundle create ../dramaforge-web-history.bundle --all` 做本地 bundle 交接。

### 3.4 ⚠️ 换机必做：清理 git remote 中的明文令牌
当前 `.git/config` 的 remote URL **内嵌了一个 GitHub PAT**：`url = https://<TOKEN>@github.com/jiangling1023/dramaforge.git`
```bash
git remote set-url origin git@github.com:jiangling1023/dramaforge.git   # ①换成无凭据地址
git remote -v | grep -c '@github.com'                                    # ②期望 0
# ③ 去 GitHub → Settings → Developer settings → Personal access tokens 吊销该 PAT 并换新
```
同理删除工作区根两个**废弃脚本**（内含已失效的旧 Cloudflare 令牌，实测确认）：`grep -l "cfat_" *.py dramaforge-web/scripts/*.py` → `deploy_cf_pages.py`、`upload_cf.py`。**注意 `deploy_cf_pages.py` 的 `PROJECT='dramaforge'` —— 项目名就是错的，用它会发到另一个项目。**

## 4. 令牌申请与验证

**申请入口**：<https://dash.cloudflare.com> → 头像 → **My Profile** → **API Tokens** → **Create Token** → 选 **Create Custom Token**（不要用 Read-only 模板）→ 按下表勾选 → **Account Resources** 选 **Include → `Jl5436@163.com's Account`** → 设过期时间 → Create Token → **立即复制保存**（只显示一次）。**令牌不写进任何文件**，仅通过环境变量传入。

| 权限组（Account 作用域） | 级别 | 用途 |
|---|---|---|
| Cloudflare Pages | **Edit** | 部署 Pages 静态资源与 Functions、回滚 |
| D1 | **Edit** | 执行 SQL（读 `ai_configs`、建表、查数据） |
| Workers Scripts | **Edit** | Pages Functions 运行时部署 |
| Account Settings | **Read** | 账户级信息读取 |

> 依据 Cloudflare 官方权限表：Pages 写权限对应 API 的 `Pages Write`；D1 直接查询需 `D1:Edit`（本项目需读 `ai_configs`，故必须 Edit）；绑定资源仅部署时无需单独资源权限。**D1 与 Pages 同账户，账户范围选错 → "Actor does not have permission"。**

**验证**：
```bash
ACC=195728e627f02c9a0c5b12633ae74c5b
TOKEN='<粘贴你的新令牌>'

# ① 校验令牌（账户级作用域用这个端点，不是 /user/tokens/verify）
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/tokens/verify" -H "Authorization: Bearer $TOKEN"
# 期望 {"result":{"id":"...","status":"active",...},"success":true}

# ② 能列 Pages 项目
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects" -H "Authorization: Bearer $TOKEN" | head -c 400

# ③ D1 可查（只读 SELECT）→ 期望列出 18 张业务表 + _cf_KV
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database/f34ceddd-a341-46a2-a00f-73f82747a270/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT name FROM sqlite_master WHERE type='"'"'table'"'"' ORDER BY name"}'
```
> ⚠️ **D1 只能用 `/query` 单条端点**：`/batch` 实测返回 **HTTP 400 / code 9106**（非 404）；本机 `wrangler d1 execute` 走代理亦失败。**直接用 `/query` + curl。**

**令牌失效的已知原因**：

| 原因 | 表现 | 处理 |
|---|---|---|
| GitHub Push Protection / Secret Scanning 自动撤销 | 曾把令牌推到仓库 → GitHub 检测到 GitHub PAT 模式，**自动吊销该 token 并邮件通知**；绕过 push protection 后 GitHub token 仍会被吊销 | 换新令牌；把令牌从代码/remote 移除 |
| 过期 / 手动删除 / 轮换 / 头部格式错 | `tokens/verify` 的 `status` 非 `active`；或返回 `code:1000`、`code:6111` | 重新签发；头部必须是 `Authorization: Bearer <token>`，注意前后空格与换行 |

**错误码对照（实测）**：`Bearer BOGUS` → `6111 Invalid format for Authorization header`；`cfat_AAAA…`（格式合法值无效）→ `tokens/verify` 给 `1000 Invalid API Token`、资源类端点给 `10000 Authentication error`；wrangler 侧给 `9109 Invalid access token`；完全未设变量则 wrangler 报「In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable」。

## 5. 本地开发启动

### 5.1 后端：wrangler pages dev（推荐，唯一真正连得上 D1 的方式）
`server/` 那套 Node+Express 已被 D1 方案取代，**不要用它跑后端**（依赖已失效的 Supabase 项目，代码注释写明「项目域名 concrete-bobcat-* 已不存在（1016），凭证无效」）。
```bash
cd /path/to/dramaforge-web/web
$NODE --disable-wasm-trap-handler \
  ../server-worker/node_modules/wrangler/bin/wrangler.js \
  pages dev dist --port 8788 --ip 127.0.0.1
```
实测输出：`✨ Compiled Worker successfully` → 绑定表含 `env.DB (dramaforge-db) D1 Database local`、`env.CF_PAGES_BRANCH ("main")` → `[wrangler:info] Ready on http://127.0.0.1:8788`。`wrangler.toml` 已写死 `database_id`，`pages dev` **自动绑定 D1**，无需手动加 `--d1`；`curl -s http://127.0.0.1:8788/api/health` → `{"success":true,"data":{"status":"ok","app":"DramaForge","version":"0.2.0","time":"..."}}`。

**⚠️ 本地 D1 是独立的空库**（状态在 `web/.wrangler/state/`）。实测 `curl :8788/api/dramas` → HTTP 500 `D1_ERROR: no such table: dramas: SQLITE_ERROR`。**这不是 bug**，是本地未建表。要本地有数据，导出生产数据用 `/query` 灌入；或直接用线上只读 GET 验证。

### 5.2 前端：vite dev 与构建产物关系
`cd web && $NODE --disable-wasm-trap-handler node_modules/vite/bin/vite.js`（或 `npm run dev`）→ 监听 `http://127.0.0.1:5173`（`vite.config.js`: `server.port:5173`, `host:'127.0.0.1'`），`/api` 代理到 `http://127.0.0.1:8801`。
> ⚠️ 该代理端口 `8801` 是给**废弃**的旧 Node 服务准备的。联调二选一：**方式 A（推荐）** 只起 `pages dev dist`（8788），直接访问 `http://127.0.0.1:8788`，静态资源与 API 同源无需代理；**方式 B** 起 `pages dev` 于 8788，把 `vite.config.js` 的 proxy target 改成 `http://127.0.0.1:8788`，再起 vite（5173）。

**构建产物关系**：`vite build` 只产出 `web/dist/index.html` + `web/dist/assets/*`（→ Pages 静态资源）；`web/functions/**` 是手写代码、**不经构建**（→ 部署时由 wrangler 打包上传为 Pages Functions）；`web/dist/_redirects` **手工维护**、vite 不生成（内容 `/*    /index.html   200`，SPA 兜底规则）。
> ⚠️ **`_redirects` 会被 vite build 清掉**（`vite.config.js` 设 `emptyOutDir: true`）。该文件被 git 跟踪，构建后若 `git status` 出现 ` D web/dist/_redirects`，需 `git checkout -- web/dist/_redirects` 恢复。但它**不是线上路由必需项**：Pages 在顶层无 `404.html` 时默认按 SPA 处理（官方文档明确），实测 `/some/deep/path` → 200 HTML、`/nonexistent-page` → 200 HTML。保留它只为兼容本地 `pages dev`（本地会报 "Infinite loop detected…has been ignored" 警告，可忽略）。

## 6. 生产部署完整步骤

### 6.1 同步铁律 + 部署四步
线上跑 `web/functions/api/_lib/`，它是 `server-worker/src/` 的副本。**改完 src 不 cp，部署上去的还是旧代码。**

```bash
export NODE=/home/jiangl1023/.workbuddy/binaries/node/versions/22.22.2/bin/node
export TOKEN='<粘贴你的新令牌>'
cd /path/to/dramaforge-web/web

# ① 同步后端副本（若本次有后端改动）
cd .. && cp -r server-worker/src/. web/functions/api/_lib/ && cd web
diff -rq server-worker/src web/functions/api/_lib    # 期望无输出（本次交接实测：无输出）

# ② 构建前端
$NODE --disable-wasm-trap-handler node_modules/vite/bin/vite.js build     # 期望 ✓ built in 3~5s

# ③ 恢复 _redirects（若构建清掉了）
cd .. && git checkout -- web/dist/_redirects 2>/dev/null; cd web

# ④ 部署（工作目录必须是 web/）
CLOUDFLARE_API_TOKEN=$TOKEN $NODE --disable-wasm-trap-handler \
  ../server-worker/node_modules/wrangler/bin/wrangler.js \
  pages deploy dist --project-name=dramaforge-app --branch=main --commit-dirty=true
```
**④ 期望输出**（取自 wrangler 源码成功文案）：`Success! Uploaded N files` → `Deployment complete! Take a peek over at https://<hash>.dramaforge-app.pages.dev`

### 6.3 ⚠️ 部署工作目录的坑（实测确认）
`wrangler pages deploy` 从**当前工作目录**寻找 `functions/` 与 `wrangler.toml`：

| 执行目录 | `dist` | `functions/` | `wrangler.toml` | 结果 |
|---|---|---|---|---|
| **`web/`** ✅ | `web/dist` ✅ | `web/functions` ✅ | `web/wrangler.toml` ✅ | 正常部署，静态资源 + Functions + D1 绑定齐全 |
| 仓库根 ❌ | `dist`（不存在） | 无 | 无 | 实测 `pages functions build` 报 **"Could not find anything to build"**；部署产物缺 Functions 与 D1 绑定 |

> 官方说明一致：*"if a `functions` folder exists where the command is run, that `functions` folder will be uploaded with the project"*。命令中 wrangler 路径写 `../server-worker/...` 正因 CWD 在 `web/`。

### 6.4 部署后立即验证 + 关于「灰度」
```bash
curl -s https://dramaforge-app.pages.dev/api/health
# 期望 HTTP 200 + {"success":true,"data":{"status":"ok","app":"DramaForge","version":"0.2.0",...}}
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://dramaforge-app.pages.dev/     # 期望 200
curl -s https://dramaforge-app.pages.dev/ | grep -o '/assets/[a-zA-Z0-9.-]*'          # 期望 index-C45AXbr6.js / index--KduZpIy.css
```

**关于「灰度」**：本项目是**单实例全量直发**，无灰度机制，原因：① 内部/小众工具，无对外流量峰值；② Pages Functions + D1 单次部署全局生效，Cloudflare Pages 无按比例分流能力（`--branch` 只产生 preview 域名，非流量灰度）；③ 首发即当前形态，无灰度基建。**等价风险控制（即本项目的灰度替代手段）**：

| 手段 | 操作 |
|---|---|
| **先 preview 后生产** | 部署时 `--branch=preview-test` → 得 `https://preview-test.dramaforge-app.pages.dev`，验证通过再 `--branch=main` 上生产 |
| **先只读验证再开写** | §8.1 的 GET 项全绿后再放开写接口 |
| **保留上一稳定部署** | Pages 保留全部部署历史，可随时回滚（§7） |
| **版本可追溯** | 部署带 `--commit-dirty` + git commit hash，Pages 部署记录存 `commit_hash` |

**发布窗口建议**：工作日上午（避开节假日审核积压），发布后 30 分钟内完成 §8 验收清单。

## 7. 回滚方案

### 7.1 触发条件
`/api/health` 非 200 或版本异常、核心只读接口（dramas / episodes / storyboards / canvas）任一 5xx、写接口大面积 5xx（D1 写失败）、首页白屏 / 静态资源 404、错误率 > 1% 或核心流程不可用 > 5 分钟、新版本引入 P0 缺陷 → **立即回滚**（不现场热修，先回滚再修）。

### 7.2 方案 A：Dashboard 手动回滚（最快，**首选**）
**操作**：<https://dash.cloudflare.com> → 左侧 **Workers & Pages** → 点进 **`dramaforge-app`**（别点 `dramaforge`）→ 顶部 **Deployments** 标签页 → 找到目标部署（确认 `commit_hash` 是上一个稳定版本）→ 该行 **⋯** → **Rollback to this deployment** → 出现 "Deployment rolled back" 即生效（官方：几秒内恢复，无需重新构建）。**预计耗时 1~2 分钟。**

### 7.3 方案 B：REST API 回滚（可脚本化）
```bash
ACC=195728e627f02c9a0c5b12633ae74c5b
TOKEN='<令牌>'

# ① 列出部署历史，拿到要回滚到的 deployment_id (UUID)
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/dramaforge-app/deployments?per_page=20" \
  -H "Authorization: Bearer $TOKEN" \
| python3 -c "import sys,json; [print(d['id'], d.get('short_id'), d.get('environment'), d.get('latest_stage',{}).get('status'), d.get('deployment_trigger',{}).get('metadata',{}).get('commit_hash','?')[:8], d.get('created_on')) for d in json.load(sys.stdin)['result']]"

# ② 执行回滚
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/pages/projects/dramaforge-app/deployments/<DEPLOYMENT_UUID>/rollback" \
  -H "Authorization: Bearer $TOKEN"
# 期望 {"success":true,"result":{...Deployment...}}
```
- 端点 `POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback`；权限 **Pages Write**；语义：把生产回滚到指定的前次成功部署；**预计耗时 < 1 分钟**
- wrangler CLI **无** rollback 子命令（实测 `wrangler pages deployment --help` 仅 `list`/`create`/`tail`/`delete`）

### 7.4 方案 C：代码回滚后重新构建部署
当回滚目标**不在** Pages 部署历史，或需同时改代码时：
```bash
cd /path/to/dramaforge-web && git log --oneline -10
git checkout -b rollback/3c0706c 3c0706c      # 或 main 上 git revert <commit>
cp -r server-worker/src/. web/functions/api/_lib/     # ⚠️历史提交的 _lib 也可能是旧的
cd web && $NODE --disable-wasm-trap-handler node_modules/vite/bin/vite.js build
cd .. && git checkout -- web/dist/_redirects 2>/dev/null; cd web
CLOUDFLARE_API_TOKEN=$TOKEN $NODE --disable-wasm-trap-handler \
  ../server-worker/node_modules/wrangler/bin/wrangler.js \
  pages deploy dist --project-name=dramaforge-app --branch=main --commit-dirty=true
```
**预计耗时 3~5 分钟**（构建约 4s + 上传 + 边缘生效 30~60s）。

### 7.5 数据兼容性处理与回滚后必做
回滚的是**代码与静态资源**，数据库不回滚。

| 变更类型 | 规则 | 做法 |
|---|---|---|
| **加表 / 加列 / 加索引** | ✅ 向后兼容 | 直接加；回滚后新列闲置即可 |
| **删列 / 改列名 / 改类型** | ❌ 破坏性，**禁止直接上线** | 必须「先加新列 → 双写 → 切读 → 观察 1~2 周 → 再删旧列」 |
| **删表** | ❌ 破坏性 | 先停用再择期删；回滚期间旧代码访问已删表会直接 500 |

```bash
# 回滚后数据验证（改用 /query）
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database/f34ceddd-a341-46a2-a00f-73f82747a270/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT (SELECT COUNT(*) FROM dramas) d,(SELECT COUNT(*) FROM episodes) e,(SELECT COUNT(*) FROM storyboards) s,(SELECT COUNT(*) FROM ai_configs) a"}'
```
> **回滚后 AI 配置仍在**：`ai_configs` 是数据表，不随代码回滚消失，密钥不会丢失。
> **回滚后必做**：① 重跑 §8 全部验收项 ② 记录回滚原因、部署 id、恢复时间 ③ 24 小时内复盘：为什么这个版本能发出去（漏测？漏验收项？）

## 8. 验收清单（部署后逐条跑通）
以下命令**全部实测通过**（当前线上版本），每条都要看到期望值才算通过。`BASE=https://dramaforge-app.pages.dev`

### 8.1 接口检查（含只读 GET 与写接口错误分支）

| # | 命令 | 期望结果 |
|---|---|---|
| 1 | `curl -s $BASE/api/health` | 200 `{"success":true,"data":{"status":"ok","app":"DramaForge","version":"0.2.0"}}` |
| 2 | `curl -s $BASE/api/dramas` | 200 数组，含 `id`/`title`/`genre`/`total_episodes`/`status`（首条 `id:1,title:"电不骗人"`） |
| 3 | `curl -s $BASE/api/dramas/1` | 200 单个 drama 对象 |
| 4 | `curl -s $BASE/api/dramas/1/episodes` | 200 数组，含 `episode_number`/`title`/`content`，带 `storyboard_count`/`video_count` |
| 5 | `curl -s $BASE/api/episodes/1/storyboards` | 200 数组，含 `storyboard_number`/`location`/`time_of_day`/`shot_type`，带 `character_ids`/`prop_ids` |
| 6 | `curl -s $BASE/api/dramas/1/canvas` | 200 数组，含 `node_type`/`node_id`/`x`/`y`/`w`/`h`/`z_index` |
| 7 | `curl -s $BASE/api/ai-configs` | 200 数组（9 条），`api_key` 为**脱敏**形式（如 `sk-d****Iq7C`） |
| 8 | `curl -s $BASE/api/chat/history/1` | 200 数组，含 `role`/`content`/`at` |
| 9 | `curl -s -o /dev/null -w "%{http_code}\n" $BASE/api/nonexistent` | 404 + JSON `{"success":false,"error":{"message":"接口不存在"}}` |
| 10 | `curl -s -X POST $BASE/api/dramas -H "Content-Type: application/json" -d '{}'` | 400 `{"success":false,"error":{"message":"缺少项目标题"}}`（写接口只验错误分支，不落库） |
| 11 | `curl -s -X POST $BASE/api/episodes -H "Content-Type: application/json" -d '{}'` | 400 `{"success":false,"error":{"message":"缺少 drama_id"}}`（同上） |

> 上表 11 条**全部实测通过**（当前线上版本）。**不要**用写接口做破坏性测试；写入类功能请在 UI 上用「新建测试剧集」验证。

### 8.3 生成类接口（`/generate/*`，会真实调 AI 并消耗额度，确认后再跑）
`/api/generate/script`（POST，传 `dramaId`+`episodeId`，返回生成的中文剧本）、`/api/generate/extract`（POST，抽出角色/场景/道具）、`/api/generate/storyboard`（POST，生成分镜并写入 `storyboards`）、`/api/generate/image`（POST，返回图片 URL）、`/api/generate/video`（POST，返回任务后轮询 `/api/generate/task/:id`）、`/api/generate/task/:id`（GET，查询视频任务状态）。
> ⚠️ 依赖 D1 `ai_configs` 的**默认配置**。线上实测默认：`text`→agnes/Agnes 3.0 Flash(免费)、`image`→agnes/Agnes Image 2.5 Flash(免费)、`video`→agnes/Agnes Video 2.5 Flash(免费)、`audio`→openai/token01 TTS。`ai_configs` 被清空则返回「尚未配置文本模型，请先在设置里添加」。

### 8.4 页面与资源
① 浏览器打开 `https://dramaforge-app.pages.dev/` → 渲染成功，标题 `DramaForge · 短剧创作平台`；② 浏览器 Network 面板 → 无 404 的 js/css，`/api/health` 200；③ `curl -s $BASE/ | grep -o '/assets/[a-zA-Z0-9.-]*'` → 与本次构建产物一致；④ 访问 `https://dramaforge-app.pages.dev/some/deep/path` → 200 HTML（SPA 兜底生效）；⑤ 界面内新建剧集 → 选集 → 生成按钮 → 走通 `/api/generate/*`（消耗额度，确认后再点）。

### 8.5 数据库抽查
用 §4.2 的 ③ D1 查询命令（同一 `/query` 端点），期望列出 **18 张业务表 + `_cf_KV`**。

## 9. 故障排查表

| 症状 | 原因 | 处理 |
|---|---|---|
| **站点 530 / `Error 1033` / 打不开** | ① Pages 项目名写错（`dramaforge` ≠ `dramaforge-app`）；② 项目被删/改名；③ 自定义域名 CNAME 指向失效 | ① 核对 `--project-name`；② Dashboard 确认项目存在；③ 查域名 DNS。**530 是 Cloudflare 边缘码，正文里的 `Error 1xxx` 才是真因**（1016 = 源站 DNS 解析失败）。实测项目名错时 `curl` 返回 `HTTP 000`（连接不通） |
| **`D1_ERROR: incomplete input`** | **D1 upsert 生成空 `DO UPDATE SET`**：桥表（如 `storyboard_characters`）所有列都是冲突键，过滤后无可更新列 → SQL 成 `ON CONFLICT (a,b) DO UPDATE SET`（后面空）→ SQLite 报 `incomplete input` | **已在 `f75abeb` 修复**（无可更新列时改 `DO NOTHING`）。复现时：① 确认 `web/functions/api/_lib/db.js` 的 `upsert()` 含 `updPart \|\| ' DO NOTHING'`；② **检查是否只改了 `server-worker/src/` 忘记 cp 到 `_lib/`（最常见）**；③ 修完 `cp -r server-worker/src/. web/functions/api/_lib/` 再部署。本地复现：`INSERT INTO t (a,b) VALUES (?,?) ON CONFLICT (a,b) DO UPDATE SET ` → `OperationalError: incomplete input`；改 `DO NOTHING` → OK（实测） |
| **构建 OOM / 进程崩溃 / vite、wrangler 无输出退出** | Node 22/24 默认启用 Wasm trap handler，与 4GB 虚拟内存冲突 | 所有 node 调用加 `--disable-wasm-trap-handler`；确认 `$NODE --version` = v22.22.2 |
| **Pages 部署 500 / 部署后资源 404** | ① **在仓库根执行了 deploy** → 没找到 `functions/` 与 `wrangler.toml`，产物缺 Functions；② `dist` 为空或路径错；③ 上传的是旧 `dist` | ① **必须在 `web/` 内执行**（实测根目录执行 `pages functions build` 报 "Could not find anything to build"）；② `ls dist/` 确认有 `index.html`+`assets/`；③ 重新 `vite build` 再部署 |
| **部署成功但静态资源 404** | `dist/index.html` 引用的 hash 文件名与实际部署不一致（部署了旧 dist 或 assets 未上传） | `curl -s $BASE/ \| grep -o '/assets/[^"]*'` 与 `ls web/dist/assets/` 对比；不一致则重新构建部署；检查 `_redirects` 是否被构建清掉（`git checkout -- web/dist/_redirects`） |
| **函数返回 500** | ① D1 绑定丢失（`env.DB` undefined）；② 本地 `pages dev` 用空本地 D1（`no such table: dramas`）；③ 代码未捕获异常 | ① 确认在 `web/` 执行且 `web/wrangler.toml` 的 `[[d1_databases]]` 三行齐全（`binding="DB"`/`database_name="dramaforge-db"`/正确 UUID）；② 本地 500 属正常（本地库未建表），用线上验证或先导数据；③ 看 `wrangler pages deployment tail` 实时日志 |
| **令牌类报错**：`code:1000 Invalid API Token` / `code:10000 Authentication error` / `code:6111 Invalid format for Authorization header` / wrangler `9109 Invalid access token` / wrangler 报「需要设置 CLOUDFLARE_API_TOKEN」 | ① 令牌无效/被删/过期；② 资源端点鉴权失败；③ 头部格式错；④ wrangler 未收到有效令牌或未设该变量 | `1000`→重新签发，`curl /accounts/{ACC}/tokens/verify` 确认（**账户级令牌用 `/accounts/{id}/tokens/verify`，不是 `/user/tokens/verify`**）；`10000`→查权限组（Pages Edit / D1 Edit / Workers Scripts Edit / Account Settings Read）与账户范围；`6111`→必须是 `Authorization: Bearer <token>`，注意前后空格/换行、是否漏 `Bearer `；`9109`/未设变量→`export CLOUDFLARE_API_TOKEN=$TOKEN` 或命令前加 `CLOUDFLARE_API_TOKEN=$TOKEN` |
| **`/api` 返回 HTML 而非 JSON** | **部署到了错误的项目**（`dramaforge` 而非 `dramaforge-app`），该项目的 `/api/*` 无 Functions 拦截 → 落到 SPA 兜底返回 index.html | **实测证据**：`curl https://dramaforge.pages.dev/api/health` → 200 + `text/html`（错误项目）；`curl https://dramaforge-app.pages.dev/api/health` → 200 + `application/json`（正确）。检查 `--project-name` 与 Dashboard 部署记录 |
| **`/api` 返回 404 JSON「接口不存在」** | 路径拼错或路由不存在 | 该 JSON 来自 Hono `notFound`，说明**函数是活的**，只是路径不对；核对 §8.1 路由表 |
| **D1 查询报错 9106 / `/batch` 不通** | `/batch` 端点不可用 | **只用 `/query`**：`POST /accounts/{ACC}/d1/database/{DB}/query` body `{"sql":"..."}`；本机 `wrangler d1 execute` 亦失败 |
| **本地 `pages dev` 报 `no such table`** | 本地 D1 是独立空库 | 正常现象。导数据到本地或用线上只读接口验证 |
| **`git push` 报 GH013 / 代理 502 / SIGTERM** | GitHub Push Protection 拦截含密钥的提交；或代理不稳 | ① 移除提交里的密钥（改环境变量 / D1 存密钥）；② 代理不稳改用 §3.2 归档交接；③ 不要 `--no-verify` 硬闯 |
| **clone 出来是旧版（`_lib/db.js` 是 PostgREST、无 `wrangler.toml`）** | 远端 `main` 只到 `65256f1`，本地 4 个提交未推送成功 | **用归档** `dramaforge-web-v0.2.0.tar.gz`；或 `git bundle` 交接；先 `git log --oneline origin/main..HEAD` 确认差距 |

## 10. 凭据与安全规范

### 10.1 红线：绝不能进代码库 / 归档 / 远端

| 项 | 说明 |
|---|---|
| Cloudflare API Token | 只经环境变量传入；**绝不写进脚本、`.env`、README、聊天记录** |
| GitHub PAT | **当前 remote URL 里就有一个，必须清除并吊销**（§3.4） |
| 各 AI 平台密钥（token01 / 硅基流动 / Agnes / fal） | 存 D1 `ai_configs.api_key`；代码与配置**不出现明文**。仓库根两个废弃脚本里硬编码的旧 Cloudflare 令牌必须删除 |
| `server/.env`（含 `SUPABASE_URL`/`SUPABASE_KEY`）、`.dev.vars*` | 已被 `.gitignore` 覆盖（实测命中 `.gitignore:30:.env`），但**打包归档时必须显式排除**（本次已排除） |
| `server/data/*.db`（SQLite 数据文件） | 不进归档；换机不靠它恢复数据（数据在 D1） |

**可以进代码库**：`wrangler.toml` 里的 D1 `database_id`（资源标识符非凭据，当前已入库）、Cloudflare 账户 ID / Pages 项目名 / D1 UUID、`ai_configs` 的表结构与列名、`schema.sql`、`web/functions/api/_lib/`（代码不含密钥）。

### 10.3 密钥轮换流程
**Cloudflare API Token**：① Dashboard → My Profile → API Tokens → Create Custom Token，按 §4 勾权限 ② 复制新令牌 → 立即 `export` 更新 ③ `curl /accounts/{ACC}/tokens/verify` 验证 ④ **删除旧令牌**（不是放着不用，是删掉）⑤ 检查代码库无残留：`grep -rn "cfat_\|ghp_\|sk-" --include='*.js' --include='*.py' --include='*.json' --include='*.md' .`
**AI 平台密钥**：① 平台控制台生成新 key ② **通过应用 UI 的「AI 配置」页面更新**（`/api/ai-configs` PUT 接口，密钥不落命令行历史；用 `/query` 直接 UPDATE 虽可行但 URL 会进 shell history）③ 验证对应 `/api/generate/*` ④ 旧 key 到平台控制台吊销。
**GitHub PAT**：① 先删旧 PAT（避免旧 token 继续有效）② 生成细粒度新 PAT（限定仓库）③ 用 credential helper 或 SSH key 认证，**不要写进 remote URL**。

### 10.4 换机后第一件事：凭据体检
```bash
cd /path/to/dramaforge-web
git remote -v | grep -q 'https://.*@' && echo "❌ remote 含明文令牌，需 set-url + 吊销" || echo "✅ remote OK"
grep -rn "cfat_[A-Za-z0-9]\{20,\}\|ghp_[A-Za-z0-9]\{20,\}" --include='*.js' --include='*.mjs' \
  --include='*.py' --include='*.json' --include='*.toml' --include='*.md' . | grep -v node_modules || echo "✅ 代码库无残留"
ls ../deploy_cf_pages.py ../upload_cf.py 2>/dev/null && echo "⚠️ 废弃脚本需删除（内含旧令牌，项目名有误）" || echo "✅ 无废弃脚本"
tar tzf ../dramaforge-web-v0.2.0.tar.gz | grep -E "\.env$|\.db$|node_modules" || echo "✅ 归档无密钥/数据"
```

## 11. 上线检查清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | **代码来源** | 用 `dramaforge-web-v0.2.0.tar.gz`（不是旧的 `dramaforge-web.tar.gz`、不是过期 clone）；`git log --oneline -1` = `3c0706c` 或更新目标提交 |
| 2 | **归档与依赖** | §3.2 的 7 个关键文件全部 `OK`；`web/node_modules` 与 `server-worker/node_modules` 均存在且 `wrangler/bin/wrangler.js` 可执行 |
| 3 | **Node 与 flag** | `$NODE --version` = v22.22.x；所有 node 调用带 `--disable-wasm-trap-handler` |
| 4 | **后端副本已同步** | `diff -rq server-worker/src web/functions/api/_lib` 无输出 |
| 5 | **构建成功** | `vite build` 输出 `✓ built in Xs`，`web/dist/` 含 `index.html` + `assets/`；`ls web/dist/_redirects` 存在（构建会清掉它） |
| 6 | **令牌有效** | `tokens/verify` 返回 `status: active`；权限含 Pages Edit / D1 Edit / Workers Scripts Edit / Account Settings Read |
| 7 | **项目名与目录正确** | `--project-name=dramaforge-app`（**不是** `dramaforge`）；deploy 在 `web/` 内执行（否则丢 Functions 与 D1 绑定） |
| 8 | **部署输出正确** | 出现 `Deployment complete!` |
| 9 | **验收清单全绿** | §8.1 十一条接口 + §8.4 五项页面检查 + §8.5 表清单全部通过 |
| 10 | **回滚就绪** | 已知上一个稳定部署的 `deployment_id`（先跑 §7.3 的 ① 拿列表并记下），或已确认 Dashboard 可回滚 |
| 11 | **凭据体检通过** | §10.4 四项全部 ✅ |
| 12 | **发布记录** | 记下「版本号 + git commit + deployment_id + 时间窗 + 回滚目标 id」 |

> 附：本次交接已实测 —— 线上只读 8 接口 + 404 行为全部符合预期；错误项目 `dramaforge.pages.dev/api/health` 返回 200 **text/html**（证明项目名选错的表现）；`vite build` 产物指纹 `index-C45AXbr6.js` / `index--KduZpIy.css`；`pages functions build` 在 `web/` 成功、在仓库根报 "Could not find anything to build"（证明 CWD 约束）；本地 `pages dev` 报 `env.DB (dramaforge-db)` 绑定但 `/api/dramas` 为 `no such table`（本地空库）；归档干净解压后装包 61/92 且构建成功；`git bundle verify` 为完整历史含 `3c0706c`；`diff -rq server-worker/src web/functions/api/_lib` 无输出；`incomplete input` 根因已用 sqlite 复现（`ON CONFLICT (a,b) DO UPDATE SET ` 报 `OperationalError`，改 `DO NOTHING` 正常）；令牌错误码 6111/1000/10000/9109；D1 `/batch` 实测 HTTP 400 code 9106（须用 `/query`）；wrangler 部署成功文案取自源码 `Deployment complete! Take a peek over at ...`。

[上线发布方案]