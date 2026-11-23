#!/bin/bash
# DramaForge Cloudflare Pages 本地部署脚本
# 使用方法: bash deploy-pages.sh

set -e

# 配置
CF_API_TOKEN="${CF_API_TOKEN}"
CF_ACCOUNT_ID="195728e627f02c9a0c5b12633ae74c5b"
PROJECT_NAME="dramaforge-app"
WEB_DIR="web"
DIST_DIR="${WEB_DIR}/dist"
NODE_BIN="./node_modules/.bin"

# 记录项目根目录
PROJECT_ROOT="$(pwd)"

echo "=== DramaForge Cloudflare Pages 部署脚本 ==="
echo ""

# 检查依赖
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js"
    exit 1
fi

# 检查目录
if [ ! -d "${WEB_DIR}" ]; then
    echo "❌ 错误: 未找到 web 目录"
    exit 1
fi

# 使用系统 npm 安装依赖（避免 conflict）
echo "📦 检查依赖..."
cd "${WEB_DIR}"
if [ ! -d "node_modules" ]; then
    echo "   安装依赖..."
    npm install --prefer-offline 2>&1 | tail -3
fi

# 同步后端路由到 functions（在构建前）
echo "🔄 同步后端路由..."
mkdir -p dist/functions/api/_lib/routes
cp -f ../server-worker/src/routes/*.js dist/functions/api/_lib/routes/
# 确保 api.js 包含 novel 导入
if ! grep -q "novelRoutes" dist/functions/api/_lib/routes/api.js; then
  sed -i "10a import { novelRoutes } from './novel.js';" dist/functions/api/_lib/routes/api.js
  sed -i "s|r.route('/merge', mergeRoutes(db, ai));|r.route('/merge', mergeRoutes(db, ai));\n  r.route('/novel', novelRoutes(ai));|" dist/functions/api/_lib/routes/api.js
fi

# 构建（如果 vite 可用）
echo "🔨 构建前端..."
if [ -x "${NODE_BIN}/vite" ]; then
    NODE_OPTIONS=--disable-wasm-trap-handler "${NODE_BIN}/vite" build 2>&1 | tail -5
else
    echo "   ⚠️  vite 未找到，使用现有 dist"
fi

# 恢复 _redirects（防止竞态清空），但保留我们添加的 API 路由
echo "📝 恢复 _redirects 文件..."
git checkout HEAD -- dist/_redirects 2>/dev/null || true
# 追加 API 路由（如果不存在）
if ! grep -qF "/api/[[path]]" dist/_redirects 2>/dev/null; then
  # 清掉可能残留的旧 Worker 转发行，再写入 Pages Functions 路由
  sed -i '/dramaforge-api/d' dist/_redirects
  echo "/api/*  /api/[[path]]  200" >> dist/_redirects
fi

# 检查 dist
if [ ! -f "${PROJECT_ROOT}/${DIST_DIR}/index.html" ]; then
    echo "❌ 错误: ${DIST_DIR}/index.html 不存在"
    exit 1
fi

# 创建 zip（包含 functions）
echo "📦 创建部署包..."
rm -f /tmp/pages-deploy.zip
# 先复制 functions 到 dist（Pages 需要）
mkdir -p "${PROJECT_ROOT}/${DIST_DIR}/functions/api"
cp -r "${PROJECT_ROOT}/web/functions/api/[[path]].js" "${PROJECT_ROOT}/${DIST_DIR}/functions/api/"
cp -r "${PROJECT_ROOT}/web/functions/api/_lib" "${PROJECT_ROOT}/${DIST_DIR}/functions/api/"
# 必须在 dist 内以相对路径打包：绝对路径会让 Pages 把 functions 放到错误层级，API 全部 404/405
# direct upload：zip 根目录即站点根，直接打包 dist 内容（不要带 dist/ 前缀）
(cd "${PROJECT_ROOT}/${DIST_DIR}" && zip -r /tmp/pages-deploy.zip . -x "*.DS_Store") 2>&1 | tail -3

ZIP_SIZE=$(stat -f%z /tmp/pages-deploy.zip 2>/dev/null || stat -c%s /tmp/pages-deploy.zip)
echo "   压缩包大小: ${ZIP_SIZE} bytes"

# 部署
echo "🚀 部署到 Cloudflare Pages..."
python3 << PYEOF
import json
import urllib.request
import urllib.error

cf_token = "${CF_API_TOKEN}"
cf_account = "${CF_ACCOUNT_ID}"
project_name = "${PROJECT_NAME}"

# Read zip
with open("/tmp/pages-deploy.zip", "rb") as f:
    zip_content = f.read()

url = f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/pages/projects/{project_name}/deployments"

boundary = '----DeployBoundary7MA4YWxkTrZu0gW'
body = b''
body += f'--{boundary}\r\n'.encode()
body += b'Content-Disposition: form-data; name="manifest"\r\n'
body += b'Content-Type: application/json\r\n\r\n'
# 不要传 branch：该项目 source=null（非 Git 连接），带 branch 会触发 clone_repo 走 Git 构建，忽略上传的 zip
body += json.dumps({
    "production": True,
    "comment": "Deploy from local script"
}).encode() + b'\r\n'
body += f'--{boundary}\r\n'.encode()
body += b'Content-Disposition: form-data; name="zip"; filename="deploy.zip"\r\n'
body += b'Content-Type: application/zip\r\n\r\n'
body += zip_content + b'\r\n'
body += f'--{boundary}--\r\n'.encode()

req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Authorization": f"Bearer {cf_token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}"
    },
    method='POST'
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
        if result.get('success'):
            deployment = result.get('result', {})
            print(f"✅ 部署成功!")
            print(f"   URL: {deployment.get('url')}")
            exit(0)
        else:
            print(f"❌ 部署失败:")
            for error in result.get('errors', []):
                print(f"   - {error.get('message')}")
            exit(1)
except urllib.error.HTTPError as e:
    print(f"❌ HTTP 错误: {e.code}")
    print(e.read().decode())
    exit(1)
except Exception as e:
    print(f"❌ 错误: {e}")
    exit(1)
PYEOF

# 清理
rm -f /tmp/pages-deploy.zip

echo ""
echo "=== 部署完成 ==="
echo "访问地址: https://${PROJECT_NAME}.pages.dev"
