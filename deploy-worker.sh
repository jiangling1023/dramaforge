#!/bin/bash
# DramaForge Server Worker 部署脚本
# 使用方法: bash deploy-worker.sh

set -e

# 配置
CF_API_TOKEN="${CF_API_TOKEN:?请设置环境变量 CF_API_TOKEN}"
CF_ACCOUNT_ID="195728e627f02c9a0c5b12633ae74c5b"
WORKER_NAME="drama-api"
WORKER_DIR="server-worker"

echo "=== DramaForge Server Worker 部署脚本 ==="
echo ""

# 检查目录
if [ ! -d "${WORKER_DIR}" ]; then
    echo "❌ 错误: 未找到 ${WORKER_DIR} 目录"
    exit 1
fi

cd "${WORKER_DIR}"

# 检查 wrangler
if ! command -v wrangler &> /dev/null; then
    echo "📦 安装 wrangler CLI..."
    npm install -g wrangler 2>&1 | tail -3
fi

# 配置 API Token
export CLOUDFLARE_API_TOKEN="${CF_API_TOKEN}"
export CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID}"

# 尝试登录
echo "🔐 检查 wrangler 认证..."
if ! wrangler whoami &> /dev/null; then
    echo "   ⚠️  未登录，尝试使用 API Token..."
    # 使用环境变量方式登录
    echo "   已设置环境变量，继续部署..."
fi

# 部署
echo "🚀 部署 Server Worker..."
echo "   Worker 名称: ${WORKER_NAME}"
echo "   配置文件: wrangler.toml"
echo ""

# 执行部署
npx wrangler deploy 2>&1 | tee /tmp/wrangler-deploy.log

# 检查部署结果
if grep -q "Published" /tmp/wrangler-deploy.log 2>/dev/null || grep -q "Success" /tmp/wrangler-deploy.log 2>/dev/null; then
    echo ""
    echo "✅ Worker 部署成功!"
    echo "   URL: https://${WORKER_NAME}.workers.dev"
else
    echo ""
    echo "⚠️  部署可能失败，请查看上方日志"
    echo "   或者手动运行: cd ${WORKER_DIR} && npx wrangler deploy"
fi

echo ""
echo "=== 部署完成 ==="
