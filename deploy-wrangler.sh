#!/bin/bash
# DramaForge 可靠部署脚本（唯一推荐方式）
# 用法: bash deploy-wrangler.sh
# 背景：manual multipart 上传 (deploy-pages.sh) 会导致全站 404，已弃用；
#       vite build 会清空 dist/functions，必须在部署前从源码恢复。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB="$ROOT/web"
DIST="$WEB/dist"
NODE24="/home/jiangl1023/.workbuddy/binaries/node/versions/24.9.0/bin/node"
WRANGLER="/home/jiangl1023/.workbuddy/binaries/node/workspace/node_modules/wrangler/bin/wrangler.js"
TOKEN="${CF_API_TOKEN:?请设置环境变量 CF_API_TOKEN}"

echo "=== DramaForge 部署（wrangler）==="

# 1) 源码一致性：server-worker/src 必须与 Pages Functions 副本一致
echo "[1/5] 校验源码/副本一致..."
diff -rq "$ROOT/server-worker/src" "$WEB/functions/api/_lib" || {
  echo "ERROR: server-worker/src 与 _lib 不一致，请先同步"; exit 1;
}

# 2) 构建前端
echo "[2/5] 构建前端..."
cd "$WEB"
NODE_OPTIONS=--disable-wasm-trap-handler ./node_modules/.bin/vite build 2>&1 | tail -4

# 3) 恢复 functions（vite build 会清空 dist）
echo "[3/5] 恢复 Pages Functions..."
mkdir -p "$DIST/functions/api"
cp -f "$WEB/functions/api/[[path]].js" "$DIST/functions/api/"
cp -r "$WEB/functions/api/_lib" "$DIST/functions/api/"

# 4) 写入正确的重定向
echo "[4/5] 写入 _redirects..."
printf '/*    /index.html   200\n/api/*  /api/[[path]]  200\n' > "$DIST/_redirects"

# 5) wrangler 部署（Node24；偶发 SIGTERM 时重试）
echo "[5/5] 部署..."
for i in 1 2; do
  if CLOUDFLARE_API_TOKEN="$TOKEN" "$NODE24" "$WRANGLER" pages deploy dist \
      --project-name=dramaforge-app --branch=main --commit-dirty=true 2>&1 | tail -10; then
    echo "=== 部署完成: https://dramaforge-app.pages.dev ==="
    exit 0
  fi
  echo "第 $i 次部署失败，重试..."
done
echo "ERROR: 部署失败"; exit 1
