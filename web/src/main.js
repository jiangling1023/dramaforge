/**
 * DramaForge 渲染进程入口
 * 检测 Electron 环境，注入原生 API shim
 */
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

// Electron 环境下注入原生 API shim
if (typeof window.electronAPI !== 'undefined') {
  window.electron = window.electronAPI;
  console.log('[DramaForge] Electron API 已注入:', window.electron.platform);
} else {
  // 浏览器环境：提供空 shim，避免引用报错
  window.electron = {
    openFileDialog: async () => ({ canceled: true }),
    saveFileDialog: async () => ({ canceled: true }),
    platform: 'browser',
    version: '0.2.0',
  };
}

const app = createApp(App);
app.mount('#app');
