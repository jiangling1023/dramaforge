# 部署说明
# 将 DramaForge 部署到云端（免费）

## 方案一：Railway（推荐，一键部署）

Railway 提供免费额度（$5/月），足够个人项目使用。

### 步骤

1. 注册 Railway
   - 打开 https://railway.app
   - 用 GitHub 账号授权登录

2. 推送代码到 GitHub
   ```bash
   cd /path/to/dramaforge
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin git@github.com:你的用户名/dramaforge.git
   git push -u origin main
   ```

3. Railway 部署
   - Railway Dashboard → New Project → Connect GitHub repo
   - 选择 dramaforge 仓库
   - Railway 会自动读取 `railway.toml` 配置
   - 点击 Deploy

4. 持久化数据库
   - 在 Railway 项目设置里找到 Persistent Volumes
   - 新建 Volume，挂载路径设为 `/data`
   - 这会自动保留 SQLite 数据文件

5. 访问
   - Railway 会分配一个 `https://xxx.up.railway.app` 域名
   - 也可以绑定自己的域名

---

## 方案二：Cloudflare Pages + Fly.io（完全免费，需两步部署）

### 前端 → Cloudflare Pages（永久免费）
1. 在 Cloudflare Dashboard → Pages → Create a project
2. 连接 GitHub 仓库，构建命令：`npm run build`，输出目录：`web/dist`
3. 发布后获得 `https://xxx.pages.dev`

### 后端 → Fly.io（免费配额）
1. 注册 https://fly.io
2. 安装 flyctl：`curl -L https://fly.io/install.sh | sh`
3. 初始化：`fly launch --no-deploy`
4. 编辑 `fly.toml`，设置：
   ```toml
   [build]
   builder = "paketobuildpacks/builder-jammy-base"
   
   [env]
   PORT = "8801"
   DATA_DIR = "/data"
   
   [mounts]
   source = "dramaforge_data"
   destination = "/data"
   ```
5. 部署：`fly deploy`

---

## 方案三：Oracle Cloud Free Tier（永久免费 VPS）

Oracle 提供永久免费 ARM VPS（4 OCPU + 24GB RAM），性能最强。

1. 注册 https://cloud.oracle.com（需要海外信用卡）
2. 创建 VM 实例，选择 Ubuntu 22.04 ARM
3. SSH 登录，安装 Node 22 + SQLite：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   # SQLite 是 Node 内置，无需安装
   ```
4. 推送代码并运行：
   ```bash
   git clone xxx
   cd dramaforge
   npm run build
   node server/src/index.mjs
   ```
5. 用 nginx 反代即可

---

## 推荐顺序

新手：方案一（Railway）→ 最简单
进阶：方案二（CF Pages + Fly）→ 完全免费
有技术能力：方案三（Oracle）→ 性能最强且永久免费
