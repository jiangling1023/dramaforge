/**
 * DramaForge 预加载脚本
 * 暴露原生 API 到渲染进程的安全桥接
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件对话框
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  // 平台信息
  platform: process.platform,
  // 版本信息
  version: process.env.npm_package_version || '0.2.0',
});
