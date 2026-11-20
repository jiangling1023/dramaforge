/**
 * DramaForge 真实主进程逻辑
 * Electron v20 (Node 20) CommonJS 格式
 * 使用 process.resourcesPath 访问内置 electron 模块
 */
const path = require('path');

// 解析 electron 模块（从 resources 目录）
const electronModulePath = path.join(
  process.resourcesPath,
  'node_modules',
  'electron'
);

// 动态 require electron（避免静态 require 失败）
let electron;
try {
  electron = require(electronModulePath);
} catch (e) {
  console.error('无法加载 electron 模块:', e.message);
  process.exit(1);
}

const { app, BrowserWindow } = electron;
const fs = require('fs');

const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

// 检查 dist 目录是否存在
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  console.error('❌ web/dist 不存在，请先构建: cd web && npm run build');
  process.exit(1);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DramaForge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 使用 loadFile 而非 file:// URL，避免 v20 的 ESM 解析 bug
  mainWindow.loadFile(path.join(WEB_DIST, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
