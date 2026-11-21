# Gitee 打包指南

## 🚀 一键打包流程

### 方式一：Gitee Actions 自动打包（推荐）

1. **创建 Gitee 仓库**
   - 访问 https://gitee.com 登录
   - 点击「新建仓库」
   - 仓库名：`dramaforge`
   - 勾选「初始化仓库」
   - 点击「创建」

2. **推送代码到 Gitee**
   ```bash
   # 在你的 Windows 电脑上执行
   git clone https://gitee.com/你的用户名/dramaforge.git
   cd dramaforge
   # 把项目文件复制进来（或从 Linux 下载 dramaforge-source-gitee.tar.gz 解压）
   git add .
   git commit -m "Initial commit"
   git push -u gitee main
   ```

3. **启用 Gitee Actions**
   - 进入仓库 →「流水线」→「新建流水线」
   - 选择「自定义流水线」
   - 或等待自动检测到 `.gitee/workflows/build-windows.yml`

4. **触发构建**
   - 进入仓库 →「流水线」
   - 点击最新运行 →「重试」或手动触发

5. **下载安装包**
   - 构建成功后，在「产物」中下载 `DramaForge-Windows`
   - 解压后获取 `.exe` 文件

### 方式二：本地 Windows 打包

1. **获取源码**
   - 从 Linux 服务器下载：`http://192.168.3.164:9999/dramaforge-source-gitee.tar.gz`
   - 或手动复制项目文件

2. **解压并打包**
   ```bash
   tar -xzf dramaforge-source-gitee.tar.gz
   cd dramaforge
   npm install
   npm run build
   ```

3. **获取安装包**
   ```
   electron\release\DramaForge Setup 0.2.0.exe
   ```

## 📋 系统要求

- Windows 10/11 (64-bit)
- Node.js v22+
- 8GB+ 内存（推荐）
- 500MB+ 磁盘空间

## ⏱️ 预计时间

| 步骤 | 时间 |
|------|------|
| npm install（首次） | 5-10 分钟 |
| npm run build | 2-5 分钟 |
| **总计** | **10-15 分钟** |

## 🔧 常见问题

### Q: Gitee Actions 构建失败
```bash
# 检查日志，常见原因：
# 1. npm install 超时 → 设置镜像
npm config set registry https://registry.npmmirror.com
npm config set electron_mirror https://npmmirror.com/mirrors/electron/

# 2. 内存不足 → 增加 Runner 规格（付费）
```

### Q: 本地打包失败
```bash
# 清除缓存重装
rm -rf node_modules
npm cache clean --force
npm install
```

### Q: 生成的 .exe 无法启动
- 右键 → 属性 → 解除锁定
- 或以管理员身份运行

## 📊 输出产物

```
electron/release/
├── DramaForge Setup 0.2.0.exe  ← 安装包（推荐）
├── DramaForge 0.2.0.exe        ← 便携版
└── ...
```
