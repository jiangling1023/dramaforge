/**
 * DramaForge 预加载脚本
 * 暴露原生 API 到渲染进程的安全桥接（CommonJS）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,
  // 版本信息
  version: '0.2.0',
});
