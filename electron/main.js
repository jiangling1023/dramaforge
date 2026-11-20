/**
 * DramaForge 主进程启动器
 * Electron v20 (Node 20) 运行环境
 * 直接 spawn Electron 二进制并传递 app.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Electron 二进制路径
const ELECTRON_BIN = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron');
// app.js 路径（真正的 Electron 主进程）
const APP_JS = path.join(__dirname, 'app.js');
// web dist 目录
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

// 检查 web dist
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  console.error('❌ web/dist 不存在，请先构建: cd web && npm run build');
  process.exit(1);
}

// 检查 Electron 二进制
if (!fs.existsSync(ELECTRON_BIN)) {
  console.error('❌ Electron 二进制不存在:', ELECTRON_BIN);
  process.exit(1);
}

console.log('🚀 启动 DramaForge...');
console.log('   Electron:', ELECTRON_BIN);
console.log('   页面:', path.join(WEB_DIST, 'index.html'));

// 用 spawn 启动 Electron，传递 app.js 作为入口
const electronProcess = spawn(ELECTRON_BIN, [APP_JS, '--no-sandbox'], {
  stdio: 'inherit'
});

electronProcess.on('close', (code) => {
  if (code !== null) {
    console.log(`Electron 进程退出，代码: ${code}`);
    process.exit(code || 0);
  }
});

electronProcess.on('error', (err) => {
  console.error('❌ 启动 Electron 失败:', err.message);
  process.exit(1);
});
