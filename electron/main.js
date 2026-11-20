/**
 * DramaForge 主进程
 * 开发期加载 vite dev server，生产期加载 dist/index.html
 */
import pkg from 'electron';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    frame: false,  // 无边框窗口，自定义标题栏
    backgroundColor: '#F4F1EC',  // 暖纸白
    titleBarStyle: 'hidden',  // macOS 隐藏原生标题栏
    trafficLightPosition: { x: 16, y: 16 },  // macOS 红绿灯位置
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发期加载 vite dev server
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // 生产期加载 dist
    mainWindow.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  // 尝试加载图标，找不到则用默认
  let iconPath = null;
  try {
    iconPath = process.env.NODE_ENV === 'development'
      ? path.join(__dirname, 'assets', 'icon.png')
      : path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png');
  } catch {
    // 图标加载失败不阻塞启动
  }

  if (iconPath) {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    tray.setToolTip('DramaForge');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow?.show());
  }
}

// 原生文件对话框（供未来导出功能使用）
ipcMain.handle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('dialog:saveFile', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
