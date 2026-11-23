<script setup>
/**
 * GPUConfigView · 云 GPU 配置中心
 * - 三厂商差异化表单：切换厂商时重建表单对象（字段完全不同，复用同一 ref 会导致残留脏值）
 * - 自动分发互斥：前端也做一次即时反馈，避免等后端 409 再回滚体验更好
 * - 删除保护：auto_dispatch=1 的行前端直接置灰，减少无效请求
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api/index.js';

/* ===== 厂商元数据：表单字段、徽标、显示名 ===== */
const PROVIDERS = {
  autodl: {
    label: 'AutoDL 算力云',
    color: '#D98032',
    bg: '#FBEFE1',
    fields: [
      { key: 'base_url', label: '容器访问链接', type: 'url', required: true, placeholder: 'https://xxx.bjb1.seetacloud.com:8443' },
      { key: 'api_key', label: 'API Key (可选)', type: 'password', required: false, placeholder: '容器未设鉴权可留空' },
    ],
  },
  runpod: {
    label: 'RunPod',
    color: '#E25940',
    bg: '#FCEEEA',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-xxxxxxxx' },
      { key: 'endpoint_id', label: 'Endpoint ID', type: 'text', required: true, placeholder: 'abc123xyz' },
      { key: 'endpoint_url', label: 'Endpoint URL (可选)', type: 'url', required: false, placeholder: 'https://api.runpod.ai/v2/abc123' },
    ],
  },
  vastai: {
    label: 'Vast.ai',
    color: '#6C5CE7',
    bg: '#EDECFE',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'your-vastai-api-key' },
      { key: 'ssh_host', label: 'SSH Host', type: 'text', required: true, placeholder: 'ssh1.vast.ai' },
      { key: 'ssh_user', label: 'SSH User', type: 'text', required: true, placeholder: 'root' },
      { key: 'ssh_port', label: 'SSH Port', type: 'number', required: true, placeholder: '22' },
      { key: 'ssh_key_path', label: 'SSH Key Path', type: 'text', required: true, placeholder: '/home/user/.ssh/id_rsa' },
      { key: 'instance_tag', label: '实例标签过滤 (可选)', type: 'text', required: false, placeholder: 'my-gpu-tag' },
    ],
  },
  custom: {
    label: '自建',
    color: '#3E9B64',
    bg: '#E9F4EC',
    fields: [
      { key: 'base_url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://my-gpu.example.com' },
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-xxxxxxxx' },
    ],
  },
};

/* ===== 响应式状态 ===== */
const loading = ref(false);
const error = ref('');
const configs = ref([]);
const modalOpen = ref(false);
const editingId = ref(null);
const provider = ref('autodl');
const form = ref({ name: '', config_json: {}, webhook_secret: '', auto_dispatch: 0, capabilities: 'ffmpeg' });
const saving = ref(false);
const testingId = ref(null);
const testDetail = ref('');

/* ===== 计算属性 ===== */
const currentProvider = computed(() => PROVIDERS[provider.value]);
const isEditing = computed(() => editingId.value !== null);

/* ===== 方法 ===== */
async function loadConfigs() {
  loading.value = true;
  error.value = '';
  try {
    configs.value = await api.gpuConfigs();
  } catch (e) {
    error.value = e.message || '加载配置失败';
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  provider.value = 'autodl';
  resetForm();
  modalOpen.value = true;
}

function openEdit(cfg) {
  editingId.value = cfg.id;
  provider.value = cfg.provider;
  form.value = {
    name: cfg.name,
    config_json: { ...cfg.config_json },
    webhook_secret: cfg.webhook_secret || '',
    auto_dispatch: cfg.auto_dispatch,
    capabilities: Array.isArray(cfg.capabilities) ? cfg.capabilities.join(',') : (cfg.capabilities || 'ffmpeg'),
  };
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  editingId.value = null;
  resetForm();
}

/** 切换厂商时重建表单对象：三厂商字段完全不同，复用同一对象会残留脏值 */
function resetForm() {
  form.value = {
    name: '',
    config_json: {},
    webhook_secret: '',
    auto_dispatch: 0,
    capabilities: 'ffmpeg',
  };
}

/** 监听厂商切换，重置 config_json 避免旧字段残留 */
watch(provider, () => {
  form.value.config_json = {};
});

async function saveConfig() {
  if (!form.value.name.trim()) { error.value = '请填写配置名称'; return; }
  if (Object.keys(form.value.config_json).length === 0) { error.value = '请填写厂商连接信息'; return; }

  saving.value = true;
  error.value = '';
  try {
    // 构建 config_json：只保留当前厂商的字段，过滤空值
    const configJson = {};
    for (const f of currentProvider.value.fields) {
      const v = form.value.config_json[f.key];
      if (v !== undefined && v !== '' && v !== null) configJson[f.key] = String(v).trim();
    }

    const payload = {
      name: form.value.name.trim(),
      provider: provider.value,
      config_json: configJson,
      webhook_secret: form.value.webhook_secret || null,
      auto_dispatch: form.value.auto_dispatch ? 1 : 0,
      capabilities: form.value.capabilities ? form.value.capabilities.split(',').map(s => s.trim()).filter(Boolean) : ['ffmpeg'],
    };

    if (isEditing.value) {
      await api.gpuConfigUpdate(editingId.value, payload);
    } else {
      await api.gpuConfigCreate(payload);
    }
    closeModal();
    await loadConfigs();
  } catch (e) {
    error.value = e.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function testConfig(id) {
  testingId.value = id;
  testDetail.value = '';
  try {
    const res = await api.gpuConfigTest(id);
    testDetail.value = res.detail || (res.ok ? '连通正常' : '连通异常');
    await loadConfigs(); // 刷新状态列
  } catch (e) {
    testDetail.value = `测试失败：${e.message}`;
  } finally {
    testingId.value = null;
  }
}

async function deleteConfig(id, autoDispatch) {
  if (autoDispatch) return;
  if (!confirm('确定删除该配置？')) return;
  try {
    await api.gpuConfigDelete(id);
    await loadConfigs();
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

/** 互斥：开启一个 auto_dispatch 时，前端立即把其他置关，给即时反馈 */
function onAutoDispatchChange(changedId, newVal) {
  if (!newVal) return;
  for (const c of configs.value) {
    if (c.id !== changedId && c.auto_dispatch === 1) {
      c.auto_dispatch = 0;
    }
  }
  if (changedId !== null) alert('已将原配置自动分发关闭');
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getStatusDot(status) {
  const map = { connected: { cls: 'st-ok', label: '已连通' }, error: { cls: 'st-err', label: '异常' }, disconnected: { cls: 'st-dis', label: '未连通' } };
  return map[status] || map.disconnected;
}

onMounted(loadConfigs);
</script>

<template>
  <section class="gpu-config-view">
    <!-- 顶部栏 -->
    <header class="gcv-head">
      <h2>云 GPU 配置</h2>
      <button class="btn primary" @click="openCreate">
        <svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        新增配置
      </button>
    </header>

    <!-- 错误提示 -->
    <div v-if="error" class="gcv-err">{{ error }}</div>

    <!-- 列表区 -->
    <div v-if="loading" class="gcv-loading">加载中…</div>
    <div v-else-if="!configs.length" class="gcv-empty">
      还没有配置云 GPU，点击「新增配置」开始接入
    </div>
    <div v-else class="gcv-list">
      <div class="gcv-row head">
        <span>名称</span>
        <span>厂商</span>
        <span>Endpoint / Base URL</span>
        <span>状态</span>
        <span>自动分发</span>
        <span>最近测试</span>
        <span>操作</span>
      </div>
      <div v-for="c in configs" :key="c.id" class="gcv-row" :class="{ 'auto-on': c.auto_dispatch === 1 }">
        <span class="c-name">{{ c.name }}</span>
        <span class="c-badge">
          <span class="badge" :style="{ background: PROVIDERS[c.provider]?.bg || 'var(--paper2)', color: PROVIDERS[c.provider]?.color || 'var(--ink2)' }">
            {{ PROVIDERS[c.provider]?.label || c.provider }}
          </span>
        </span>
        <span class="c-endpoint mono" :title="c.config_json.endpoint_url || c.config_json.endpoint_id || c.config_json.base_url || c.config_json.ssh_host || '—'">
          {{ c.config_json.endpoint_url || c.config_json.endpoint_id || c.config_json.base_url || c.config_json.ssh_host || '—' }}
        </span>
        <span class="c-status">
          <span class="dot" :class="getStatusDot(c.status).cls" :title="getStatusDot(c.status).label" />
          {{ getStatusDot(c.status).label }}
        </span>
        <span class="c-auto">
          <label class="switch">
            <input type="checkbox" :checked="c.auto_dispatch === 1" :disabled="c.status === 'error'" @change="onAutoDispatchChange(c.id, $event.target.checked)" />
            <span class="slider" />
          </label>
          <span v-if="c.auto_dispatch === 1" class="auto-tag">当前生效</span>
        </span>
        <span class="c-time mono">{{ formatTime(c.last_test_at) }}</span>
        <span class="c-ops">
          <button class="btn out dim" :disabled="testingId === c.id" @click="testConfig(c.id)">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2"/></svg>
            {{ testingId === c.id ? '测试中…' : '测试' }}
          </button>
          <button class="btn out dim" @click="openEdit(c)">编辑</button>
          <button class="btn out dim" :disabled="c.auto_dispatch === 1" :title="c.auto_dispatch === 1 ? '请先关闭自动分发' : ''" @click="deleteConfig(c.id, c.auto_dispatch === 1)">删除</button>
        </span>
      </div>
    </div>

    <!-- 新增/编辑弹层 -->
    <div v-if="modalOpen" class="modal-backdrop" @click.self="closeModal">
      <div class="modal-card">
        <header class="modal-head">
          <h3>{{ isEditing ? '编辑配置' : '新增配置' }}</h3>
          <button class="icon-btn" @click="closeModal">
            <svg class="ic" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>

        <div class="modal-body">
          <!-- 厂商选择 -->
          <div class="field">
            <label>厂商</label>
            <select v-model="provider" class="provider-select">
              <option value="autodl">AutoDL 算力云</option>
              <option value="runpod">RunPod</option>
              <option value="vastai">Vast.ai</option>
              <option value="custom">自建</option>
            </select>
          </div>

          <!-- 配置名称 -->
          <div class="field">
            <label>配置名称 <span class="req">*</span></label>
            <input v-model="form.name" type="text" placeholder="如：我的 RunPod 主力" />
          </div>

          <!-- 差异化表单字段 -->
          <div class="field-group">
            <template v-for="f in currentProvider.fields" :key="f.key">
              <div class="field">
                <label>{{ f.label }} <span v-if="f.required" class="req">*</span></label>
                <input
                  :type="f.type"
                  v-model="form.config_json[f.key]"
                  :placeholder="f.placeholder"
                  :required="f.required"
                />
              </div>
            </template>
          </div>

          <!-- Webhook Secret（统一放表单底部，三厂商通用） -->
          <div class="field">
            <label>Webhook Secret (可选)</label>
            <input v-model="form.webhook_secret" type="text" placeholder="HMAC-SHA256 签名密钥，留空则不验签" />
          </div>

          <!-- 自动分发 + 能力 -->
          <div class="field-row">
            <div class="field half">
              <label>自动分发（全局互斥）</label>
              <label class="inline-switch">
                <input type="checkbox" v-model="form.auto_dispatch" @change="onAutoDispatchChange(null, form.auto_dispatch)" />
                <span class="slider" />
                <span>开启自动分发</span>
              </label>
            </div>
            <div class="field half">
              <label>能力标签</label>
              <input v-model="form.capabilities" type="text" placeholder="如：ffmpeg,video_gen" />
            </div>
          </div>

          <!-- 测试连通性按钮（需先保存，后端 test 接口需 id） -->
          <div v-if="isEditing" class="test-area">
            <button class="btn out" :disabled="testingId === editingId" @click="testConfig(editingId)">
              <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2"/></svg>
              {{ testingId === editingId ? '测试中…' : '测试连通性' }}
            </button>
            <span class="test-hint">提示：测试连通性需先保存配置</span>
          </div>
          <div v-else class="test-hint">保存后可测试连通性</div>
        </div>

        <footer class="modal-foot">
          <button class="btn out" @click="closeModal">取消</button>
          <button class="btn primary" :disabled="saving" @click="saveConfig">{{ saving ? '保存中…' : '保存' }}</button>
        </footer>
      </div>
    </div>

    <!-- 测试结果详情弹层 -->
    <div v-if="testDetail" class="modal-backdrop" @click.self="testDetail = ''">
      <div class="modal-card small">
        <header class="modal-head"><h3>测试结果</h3></header>
        <div class="modal-body test-detail">
          <pre>{{ testDetail }}</pre>
        </div>
        <footer class="modal-foot">
          <button class="btn primary" @click="testDetail = ''">知道了</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ===== 页面布局 ===== */
.gpu-config-view { padding: 18px 20px; background: var(--paper); color: var(--ink); }
.gcv-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.gcv-head h2 { margin: 0; font-size: var(--fs-title); font-weight: 700; color: var(--ink); }
.gcv-err { margin-bottom: 12px; padding: 10px 12px; border-radius: var(--r-tag); background: #FBE3E1; color: var(--err); font-size: var(--fs-body); }
.gcv-loading, .gcv-empty { display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--ink3); font-size: var(--fs-body); }

/* ===== 列表表格式 ===== */
.gcv-list { border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); overflow: hidden; }
.gcv-row { display: grid; grid-template-columns: 1.2fr 0.8fr 1.8fr 1fr 1.3fr 1.5fr 1.6fr; gap: 12px; padding: 10px 14px; align-items: center; border-bottom: 1px solid var(--line2); }
.gcv-row.head { background: var(--surface2); font-size: var(--fs-label); color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid var(--line); }
.gcv-row:last-child { border-bottom: none; }
.gcv-row:hover { background: var(--surface2); }
.gcv-row.auto-on { background: var(--coralS); }
.c-name { font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-badge { display: flex; align-items: center; }
.badge { font-size: var(--fs-label); padding: 2px 8px; border-radius: var(--r-pill); font-weight: 600; }
.c-endpoint { font-size: var(--fs-meta); color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-status { display: flex; align-items: center; gap: 6px; font-size: var(--fs-body); color: var(--ink2); }
.c-status .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.dot.st-ok { background: var(--green); box-shadow: 0 0 6px rgba(62, 155, 100, .5); }
.dot.st-err { background: var(--err); }
.dot.st-dis { background: var(--ink3); }
.c-auto { display: flex; align-items: center; gap: 8px; }
.auto-tag { font-size: var(--fs-label); color: var(--coralD); background: var(--coralS); padding: 1px 6px; border-radius: var(--r-pill); }
.c-time { font-size: var(--fs-meta); color: var(--ink3); white-space: nowrap; }
.c-ops { display: flex; gap: 6px; }

/* ===== 开关样式 ===== */
.switch { position: relative; width: 44px; height: 24px; flex: 0 0 44px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; background: var(--line); border-radius: var(--r-pill); transition: background var(--t); }
.slider::before { content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%; background: white; top: 3px; left: 3px; box-shadow: var(--s1); transition: transform var(--t); }
.switch input:checked + .slider { background: var(--coral); }
.switch input:checked + .slider::before { transform: translateX(20px); }
.switch input:disabled + .slider { opacity: .5; cursor: not-allowed; }
.inline-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.inline-switch input { opacity: 0; width: 0; height: 0; }
.inline-switch .slider { width: 44px; height: 24px; }

/* ===== 弹层 ===== */
.modal-backdrop { position: fixed; inset: 0; background: rgba(30,38,55,.4); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
.modal-card { width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--s3); overflow: hidden; }
.modal-card.small { max-width: 420px; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--surface2); }
.modal-head h3 { margin: 0; font-size: var(--fs-section); font-weight: 600; }
.icon-btn { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--rs); color: var(--ink2); }
.icon-btn:hover { background: var(--paper2); color: var(--ink); }
.modal-body { padding: 16px; max-height: 60vh; overflow-y: auto; }
.field { margin-bottom: 14px; }
.field label { display: block; margin-bottom: 6px; font-size: var(--fs-body); color: var(--ink2); }
.field label .req { color: var(--err); margin-left: 2px; }
.field input, .field select { width: 100%; }
.provider-select { background: var(--surface); border: 1px solid var(--line); border-radius: var(--rs); padding: 9px 12px; color: var(--ink); }
.field-group { border-top: 1px solid var(--line2); padding-top: 14px; margin-top: 4px; }
.field-row { display: flex; gap: 12px; }
.field.half { flex: 1; }
.test-area { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--line2); }
.test-hint { font-size: var(--fs-label); color: var(--ink3); }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface2); }
.test-detail pre { margin: 0; padding: 12px; background: var(--paper2); border-radius: var(--rs); font-size: var(--fs-meta); white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
</style>