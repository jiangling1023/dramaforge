# DramaForge Windows 桌面版打包指南

## 📋 前置条件

1. **Windows 10/11 64-bit** 系统
2. **Node.js 22+**（推荐 v22 LTS）
3. **Git** 已安装
4. **网络通畅**（能访问 GitHub 和 npm）

## 🚀 一键打包流程

### 第一步：克隆/拉取代码

```bash
# 克隆仓库
git clone https://github.com/jiangling1023/dramaforge.git
cd dramaforge

# 或更新已有仓库
git pull origin main
```

### 第二步：安装依赖并打包

```bash
# 安装所有依赖（包括 Electron 二进制）
npm install

# 构建 Web 应用 + 打包 Windows 安装包
npm run build
```

**预计耗时**：5-15 分钟（首次下载 Electron ~150MB）

### 第三步：获取安装包

打包完成后，安装包位于：
```
dramaforge/electron/release/DramaForge Setup 0.2.0.exe
```

## 📦 输出产物说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `DramaForge Setup 0.2.0.exe` | ~200MB | NSIS 安装包，可自定义安装路径 |
| `DramaForge 0.2.0.exe` | ~200MB | 便携版，无需安装直接运行 |

## 🔧 常见问题

### Q1: npm install 卡在 Electron 下载
```bash
# 设置国内镜像
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install
```

### Q2: 打包失败 "Cannot find module 'electron'"
```bash
# 清除缓存重装
rm -rf node_modules
rm package-lock.json
npm install
```

### Q3: 生成的 .exe 无法启动
- 确保 Windows Defender 没有拦截
- 右键 → 属性 → 解除锁定（如果是从浏览器下载的）
- 或以管理员身份运行

### Q4: 想修改应用图标
1. 准备 `build/icon.ico`（256x256 像素，支持多尺寸）
2. 放在 `dramaforge/build/` 目录
3. 重新运行 `npm run build`

## 🧪 本地测试（打包前）

```bash
# 开发模式运行（加载 vite dev server）
npm run dev:electron

# 或直接运行生产构建
npm start
```

## 📝 配置说明

### 修改窗口大小
编辑 `electron/main.js`：
```javascript
mainWindow = new BrowserWindow({
  width: 1440,  // 修改宽度
  height: 900,  // 修改高度
  ...
});
```

### 修改应用名称
编辑 `package.json`：
```json
{
  "name": "dramaforge-desktop",
  "productName": "DramaForge"  // 修改这里
}
```

### 修改版本号
编辑 `package.json` 的 `version` 字段，重新打包会自动更新安装文件名。

## 🔐 代码签名（可选）

未签名的安装包会触发 Windows SmartScreen 警告。

如需签名：
1. 购买代码签名证书（如 Sectigo、DigiCert）
2. 在 `electron-builder.json5` 添加：
```json
{
  "win": {
    "sign": "./sign.ps1"
  }
}
```

## 📊 构建时间对比

| 环境 | 首次构建 | 增量构建 |
|------|---------|---------|
| Windows（本地） | 5-15 分钟 | 2-3 分钟 |
| Linux（服务器） | ❌ 失败 | ❌ 失败 |
| GitHub Actions | 10-20 分钟 | 5-8 分钟 |

## 💡 建议

1. **首次打包在 Windows 本机完成**（网络更快，依赖齐全）
2. **后续迭代可配置 CI/CD**（GitHub Actions 自动打包）
3. **保留构建日志**以便排查问题
