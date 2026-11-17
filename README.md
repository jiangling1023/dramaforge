# DramaForge · 短剧创作平台

一个从零独立实现的短剧生产软件：**故事 → 剧本 → 资产 → 分镜 → 影像 → 成片**。
网页与 App 同源，网页端可安装为 PWA。

---

## 一、这套东西是什么

不是通用 AI 聊天框，而是一条**有数据契约的流水线**：

| 阶段 | 输入 | 输出 | 落库位置 |
|---|---|---|---|
| 1 剧本改写 | `episodes.content` | 标准剧本格式 | `episodes.script_content` |
| 2 资产提取 | 剧本 | 角色 / 场景 / 道具 | `characters` `scenes` `props` + 三张桥表 |
| 3 分镜拆解 | 剧本 + 资产 | 镜头段落（8–15 秒/段） | `storyboards` + 两张桥表 |
| 4 图片生成 | 资产提示词 | 定妆图 / 场景图 / 道具图 | `gen_tasks` → 资产 `image_url` |
| 5 视频生成 | 分镜提示词 | 镜头片段 | `gen_tasks` → `storyboards.video_url` |
| 6 拼接成片 | 按镜号排序的片段 | 整集成片 | `merges` + `episodes.video_url` |

**每一阶段都接受 `scope`**，只处理你选中的集与镜号，不会默认全集扫射。

---

## 二、快速开始

```bash
# 1. 后端（需要 Node ≥ 22.5，内置 node:sqlite，无原生依赖）
cd server
npm install
npm start                      # http://127.0.0.1:8801

# 2. 导入模型配置（key 只从环境变量读，不写进源码）
cd ..
TOKEN01_KEY=<你的key> python3 scripts/seed-models.py

# 3. 前端
cd web
npm install
npm run dev                    # http://127.0.0.1:5173

# 4. 生产构建（构建后由后端直接托管）
npm run build                  # 产物 web/dist，后端启动即生效
```

端到端自检：

```bash
python3 scripts/e2e-test.py    # 建项目→建剧集→写剧本→提资产→拆分镜，五步全真跑
```

---

## 三、目录结构

```
dramaforge/
├── server/
│   ├── src/
│   │   ├── index.mjs            服务入口（API + 静态托管）
│   │   ├── db/
│   │   │   ├── schema.sql       18 张表的完整契约
│   │   │   └── index.mjs        node:sqlite 连接、事务、JSON 工具
│   │   ├── adapters/ai.mjs      模型适配层（chat/image/video/audio/probe）
│   │   ├── services/prompts.mjs 提示词模板 + JSON 提取与截断修复
│   │   └── routes/
│   │       ├── api.mjs          配置/项目/剧集/分镜/画布 CRUD
│   │       └── generate.mjs     生成流水线
│   └── data/dramaforge.db       SQLite（自动创建）
├── web/
│   └── src/
│       ├── App.vue              工作台外壳（项目/剧集/操作栏/日志）
│       ├── views/Canvas.vue     无限画布
│       └── api/index.js         接口封装
└── scripts/
    ├── seed-models.py           模型配置导入
    └── e2e-test.py              端到端自检
```

---

## 四、数据契约要点

**三个刻意的设计决策**（详见 `server/src/db/schema.sql`）：

1. **剧本不是独立表** —— 原文与改写稿是 `episodes` 的两列，「重写剧本」只更新一列，不产生孤儿记录。
2. **一个分镜 = 一个视频生成任务** —— `storyboards` 一行对应一次视频生成，状态机 `pending → prompted → videoing → done`。
3. **资产是项目级 + 集级关联** —— 同一角色在第 1 集和第 20 集必须是同一条记录，否则形象一致性无从谈起。桥表 `episode_characters` / `storyboard_characters` 负责关联。

**去重键**：角色与道具按名字（去括号、去空白、转小写），场景按「地点 + 时间段」精确匹配。全部用 SQLite 唯一索引兜底，重复提取不会产生脏数据。

**画布不新增业务表** —— 只有 `canvas_layout` 一张位置表，节点引用既有实体。

---

## 五、接口清单

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/ai-configs` | 模型配置列表 / 新建 |
| PUT/DELETE | `/api/ai-configs/:id` | 更新 / 删除 |
| POST | `/api/ai-configs/:id/test` | 连通性探针 |
| GET/POST | `/api/dramas` | 项目列表 / 新建 |
| GET/PUT/DELETE | `/api/dramas/:id` | 详情（含集与资产）/ 更新 / 软删 |
| GET | `/api/dramas/:id/episodes` | 剧集列表（含分镜数、已出片数） |
| POST | `/api/episodes` | 新建（集号不传则自动取下一个） |
| PUT | `/api/episodes/:id` | 更新剧本 / 集纲 / 状态 |
| GET | `/api/episodes/:id/storyboards` | 分镜列表（带 character_ids / prop_ids） |
| PUT | `/api/storyboards/:id` | 更新分镜 + 同步桥表 |
| GET/PUT | `/api/dramas/:id/canvas` | 画布布局读取 / 批量保存 |
| POST | `/api/generate/script` | 剧本改写 |
| POST | `/api/generate/extract` | 资产提取 |
| POST | `/api/generate/storyboard` | 分镜拆解 |
| POST | `/api/generate/image` | 出图（先保证有提示词） |
| POST | `/api/generate/video` | 出视频（异步任务） |
| GET | `/api/generate/task/:id` | 任务轮询并回写 |

生成类接口统一入参：

```jsonc
{
  "dramaId": 1,
  "episodeId": 1,                 // 只处理这一集
  "scope": {                      // 可选：批量时明确选集
    "episodeIds": [1, 2, 3],
    "storyboardNumbers": [1, 2]   // 只重做指定镜号
  }
}
```

---

## 六、踩过的坑（都已在代码里修掉）

1. **上游网关约 60–75 秒掐断长请求**。整集一次输出分镜 JSON 必然 502，必须按场景分批（`splitScenes`）。
2. **`settings` 列必须是 JSON 字符串**，传对象直接崩且不报字段原因。
3. **推理模型思维链吃 token**：`deepseek-v4-flash-0731` 一次 374 个输出 token 里 359 个是思考，正文只占 15 个。`max_tokens` 必须留足 8000。
4. **`max_tokens` 不够会截断 JSON**。除了提高上限，`extractJson` 还做了截断修复：回退到最后一个完整对象、补齐括号。
5. **`node:sqlite` 返回 null 原型对象**，直接 `JSON.stringify` 会有意外，统一走 `plain()` 转换。

---

## 七、进度

- [x] 18 表数据契约
- [x] 模型适配层（文本 / 图像 / 视频 / 音频 + 探针）
- [x] 项目 / 剧集 / 资产 / 分镜 CRUD
- [x] 剧本改写（实测 1291 字，格式合规）
- [x] 资产提取（实测 3 角色 / 1 场景 / 3 道具，appearance 333–364 字）
- [x] 分镜拆解（实测 9 镜 / 104 秒，分批抗超时）
- [x] 无限画布（缩放、拖拽、连线、位置持久化）
- [ ] 图片 / 视频生成端到端（接口已备，待真实跑通）
- [ ] 智能助手 + 专家团工具调用
- [ ] AI 合成（拼接 / 字幕 / 转场）
- [ ] PWA + APK 打包 + Cloudflare 部署与 OTA
