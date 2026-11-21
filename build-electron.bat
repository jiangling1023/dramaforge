@echo off
chcp 65001 >nul
title DramaForge 打包工具
color 0A

echo.
echo ========================================
echo   DramaForge Windows 桌面版打包工具
echo ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 22+
    echo.
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [OK] Node.js 已安装：%NODE_VERSION%

:: 检查 Git
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 未检测到 Git，将使用本地代码打包
    set USE_LOCAL=1
) else (
    echo [OK] Git 已安装
    set USE_LOCAL=0
)

echo.
echo 请选择操作：
echo.
echo   [1] 克隆最新代码并打包
echo   [2] 仅打包（使用本地代码）
echo   [3] 退出
echo.

set /p choice="请输入选项 (1-3): "

if "%choice%"=="1" goto CLONE_AND_BUILD
if "%choice%"=="2" goto BUILD_LOCAL
if "%choice%"=="3" exit /b 0
goto END

:CLONE_AND_BUILD
echo.
echo [信息] 正在克隆仓库...
if exist dramaforge (
    echo [信息] 目录已存在，正在更新...
    cd dramaforge
    git pull origin main
) else (
    git clone https://github.com/jiangling1023/dramaforge.git
    cd dramaforge
)
goto INSTALL

:BUILD_LOCAL
echo.
echo [信息] 使用当前目录代码打包...
if not exist package.json (
    echo [错误] 当前目录不是 DramaForge 项目
    pause
    exit /b 1
)
goto INSTALL

:INSTALL
echo.
echo [信息] 正在安装依赖（首次可能需要 5-10 分钟）...
echo.

call npm install
if %errorlevel% neq 0 (
    echo.
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo [OK] 依赖安装完成

:BUILD
echo.
echo [信息] 开始构建 Web 应用 + 打包 Electron...
echo [提示] 预计耗时 2-5 分钟
echo.

call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [错误] 打包失败，请检查上方错误信息
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包成功！
echo ========================================
echo.

if exist electron\release (
    echo [输出目录] electron\release\
    echo.
    dir electron\release\*.exe
) else (
    echo [警告] 未找到 release 目录，请检查构建日志
)

echo.
echo 安装包位置：dramaforge\electron\release\
pause
