# DramaForge 桌面客户端（Electron）

基于 Electron + Vue3 的桌面客户端，提供原生文件对话框、系统托盘、后台轮询等能力。

## 架构

```
dramaforge-web/
├── electron/              # Electron 主进程
│   ├── main.js           # 主窗口 + 托盘 + IPC
│   ├── preload.js        # 安全 API 桥接
│   └── package.json      # Electron 依赖
├── web/                  # Vue3 前端（复用 Web 版）
│   ├── src/
│   └── dist/            # 生产构建产物
└── package.json          # 根脚本（dev/build）
```

**后端仍指向 Cloudflare Pages Functions**（`https://dramaforge-app.pages.dev/api`），Electron 只打包前端。

## 开发

```bash
# 1. 安装依赖（首次）
cd electron && npm install
cd ..

# 2. 开发模式（vite + electron 并行）
npm run dev:electron

# 或分开运行
npm run dev:web      # 启动 vite dev server
npm run start        # 启动 Electron（加载 localhost:5173）
```

## 构建 Windows 安装包

```bash
npm run build
# 输出：release/DramaForge Setup 0.2.0.exe
```

构建流程：
1. `web/package.json` build → `web/dist/`
2. `electron-builder` 打包 `electron/` + `web/dist/` → `release/`

## 使用

双击 `DramaForge Setup 0.2.0.exe` 安装，桌面快捷方式自动创建。

首次启动会自动加载 `https://dramaforge-app.pages.dev`（或本地后端如果配置了 proxy）。

## 原生 API

Electron 环境注入 `window.electron`：

```js
// 打开文件对话框
const result = await window.electron.openFileDialog({
  title: '选择剧本文件',
  filters: [{ name: 'Markdown', extensions: ['md'] }]
});

// 保存文件对话框
const result = await window.electron.saveFileDialog({
  title: '导出分镜',
  defaultPath: '分镜.md'
});
```

浏览器环境自动 fallback 到空实现，不报错。

## 已知限制

- 首次 `npm install` 需下载 ~150MB Electron 二进制
- 当前版本无边框窗口（未实现自定义标题栏拖拽）
- 自动更新未实现（后续可加 `electron-updater`）
