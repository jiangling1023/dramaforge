#!/bin/bash
# DramaForge 完整部署脚本
# 部署前端到 Cloudflare Pages + Server Worker 到 Cloudflare Workers

set -e

# 配置
CF_API_TOKEN="${CF_API_TOKEN}"
CF_ACCOUNT_ID="195728e627f02c9a0c5b12633ae74c5b"
PROJECT_NAME="dramaforge-app"
WORKER_NAME="dramaforge-api"
WEB_DIR="web"
DIST_DIR="${WEB_DIR}/dist"
WORKER_DIR="server-worker"

echo "=== DramaForge 完整部署脚本 ==="
echo ""

# ========================================
# 1. 部署 Server Worker
# ========================================
echo "🚀 步骤 1: 部署 Server Worker"
echo "----------------------------------------"

if [ ! -d "${WORKER_DIR}" ]; then
    echo "⚠️  未找到 server-worker 目录，跳过"
else
    cd "${WORKER_DIR}"

    # 检查 wrangler
    if ! command -v wrangler &> /dev/null; then
        echo "   安装 wrangler CLI..."
        npm install -g wrangler 2>&1 | tail -3
    fi

    # 登录（如果未登录）
    if ! wrangler whoami &> /dev/null; then
        echo "   ⚠️  请先运行: wrangler login"
        echo "   或使用环境变量: CLOUDFLARE_API_TOKEN"
    fi

    # 部署
    echo "   部署到 Cloudflare Workers..."
    if wrangler deploy --dry-run 2>&1 | grep -q "Would deploy"; then
        echo "   ✅ 配置正确，准备部署"
        # wrangler deploy 2>&1 | tail -10
        echo "   ⚠️  请手动运行: cd ${WORKER_DIR} && wrangler deploy"
    else
        echo "   ⚠️  Server Worker 部署失败，请检查配置"
    fi

    cd ..
fi

echo ""

# ========================================
# 2. 部署前端到 Cloudflare Pages
# ========================================
echo "🚀 步骤 2: 部署前端到 Cloudflare Pages"
echo "----------------------------------------"

if [ ! -d "${WEB_DIR}" ]; then
    echo "❌ 错误: 未找到 web 目录"
    exit 1
fi

cd "${WEB_DIR}"

# 检查 dist
if [ ! -f "${DIST_DIR}/index.html" ]; then
    echo "   ⚠️  dist 目录不存在，尝试构建..."
    if [ -x "./node_modules/.bin/vite" ]; then
        NODE_OPTIONS=--disable-wasm-trap-handler ./node_modules/.bin/vite build 2>&1 | tail -5
    else
        echo "   ❌ 无法构建，请手动构建后运行此脚本"
        exit 1
    fi
fi

# 恢复 _redirects
git checkout HEAD -- dist/_redirects 2>/dev/null || true

if [ ! -f "${DIST_DIR}/index.html" ]; then
    echo "❌ 错误: dist/index.html 不存在"
    exit 1
fi

# 创建 zip
echo "   创建部署包..."
cd ..
rm -f /tmp/pages-deploy.zip
zip -r /tmp/pages-deploy.zip "${DIST_DIR}" -x "*.DS_Store" 2>&1 | tail -3

ZIP_SIZE=$(stat -f%z /tmp/pages-deploy.zip 2>/dev/null || stat -c%s /tmp/pages-deploy.zip)
echo "   压缩包大小: ${ZIP_SIZE} bytes"

# 部署
echo "   部署到 Cloudflare Pages..."
python3 << PYEOF
import json
import urllib.request
import urllib.error

cf_token = "${CF_API_TOKEN}"
cf_account = "${CF_ACCOUNT_ID}"
project_name = "${PROJECT_NAME}"

with open("/tmp/pages-deploy.zip", "rb") as f:
    zip_content = f.read()

url = f"https://api.cloudflare.com/client/v4/accounts/{cf_account}/pages/projects/{project_name}/deployments"

boundary = '----DeployBoundary7MA4YWxkTrZu0gW'
body = b''
body += f'--{boundary}\r\n'.encode()
body += b'Content-Disposition: form-data; name="manifest"\r\n\r\n'
body += json.dumps({
    "production": True,
    "comment": "Deploy from local script",
    "branch": "main"
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
            print(f"   ✅ 前端部署成功!")
            print(f"      URL: {deployment.get('url')}")
        else:
            print(f"   ❌ 部署失败:")
            for error in result.get('errors', []):
                print(f"      - {error.get('message')}")
            exit(1)
except urllib.error.HTTPError as e:
    print(f"   ❌ HTTP 错误: {e.code}")
    print(e.read().decode())
    exit(1)
except Exception as e:
    print(f"   ❌ 错误: {e}")
    exit(1)
PYEOF

# 清理
rm -f /tmp/pages-deploy.zip

echo ""
echo "=== 部署完成 ==="
echo ""
echo "访问地址:"
echo "  前端: https://${PROJECT_NAME}.pages.dev"
echo "  API:  https://${WORKER_NAME}.workers.dev"
echo ""
echo "注意: Server Worker 需要手动部署:"
echo "  cd ${WORKER_DIR} && wrangler deploy"
