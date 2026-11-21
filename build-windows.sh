#!/bin/bash
# DramaForge Windows 桌面版构建脚本
set -e

echo "=== DramaForge Windows 桌面版构建 ==="
echo ""

# 检查目录
if [ ! -d "electron" ]; then
    echo "❌ 错误: 未找到 electron 目录"
    exit 1
fi

cd electron

# 检查 node_modules
if [ ! -d "node_modules" ] || [ -z "$(ls node_modules/.bin/ 2>/dev/null)" ]; then
    echo "📦 安装依赖..."
    npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -5
fi

# 检查 web dist
if [ ! -f "../web/dist/index.html" ]; then
    echo "⚠️  web/dist 不存在，跳过前端构建"
fi

# 构建
echo "🔨 构建 Windows 安装包..."
export NODE_OPTIONS="--max-old-space-size=4096"
./node_modules/.bin/electron-builder --win --x64 --config ../electron-builder.json5 2>&1

# 检查结果
if [ -f "../release/*.exe" ]; then
    echo ""
    echo "✅ 构建成功!"
    ls -lh ../release/*.exe
else
    echo ""
    echo "⚠️  构建可能失败，请查看上方日志"
fi
