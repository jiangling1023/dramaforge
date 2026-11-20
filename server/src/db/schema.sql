-- ============================================================
-- DramaForge 数据契约 v1.0
-- 设计原则：
--   1. 剧本不是独立表 —— 原文 content 与改写稿 script_content 是 episodes 的两列，
--      「重写剧本」只是更新一列，不产生孤儿记录。
--   2. 一个分镜 = 一个视频生成任务 —— storyboards 一行对应一次视频生成。
--   3. 资产是项目级 + 集级关联 —— 同一角色在第 1 集和第 20 集必须是同一条记录，
--      否则形象一致性无从谈起。
--   4. 画布不新增业务表 —— 只有 canvas_layout 一张位置表，节点引用既有实体。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 项目 ----------
CREATE TABLE IF NOT EXISTS dramas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  description   TEXT,
  genre         TEXT,                          -- 都市 / 古装宫斗 / 玄幻 / 悬疑
  style         TEXT,                          -- 爽文打脸 / 复仇虐渣 / 甜宠闪婚 / 悬疑反转
  audience      TEXT,                          -- 通用 / 男频 / 女频
  inspiration   TEXT,                          -- 用户给的创作灵感（硬设定）
  aspect_ratio  TEXT    DEFAULT '9:16',
  resolution    TEXT    DEFAULT '1080p',
  total_episodes INTEGER DEFAULT 0,
  status        TEXT    DEFAULT 'draft'        -- draft / writing / producing / done
                CHECK (status IN ('draft','writing','producing','done')),
  thumbnail     TEXT,
  tags          TEXT,                          -- JSON 数组
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dramas_status ON dramas(status) WHERE deleted_at IS NULL;

-- ---------- 剧集 ----------
CREATE TABLE IF NOT EXISTS episodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id       INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL,
  title          TEXT,
  content        TEXT,                         -- 原文
  script_content TEXT,                         -- 影视化改写稿
  outline        TEXT,                         -- 本集集纲（40-60 字）
  hook_type      TEXT,                         -- 结尾卡点类型
  duration_sec   INTEGER DEFAULT 0,
  status         TEXT    DEFAULT 'draft'       -- draft / scripted / storied / done
                 CHECK (status IN ('draft','scripted','storied','done')),
  video_url      TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_episodes_num
  ON episodes(drama_id, episode_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_episodes_drama ON episodes(drama_id);

-- ---------- 角色（项目级，跨集共享） ----------
CREATE TABLE IF NOT EXISTS characters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id        INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  role            TEXT,                        -- 主角 / 反派 / 配角
  description     TEXT,                        -- 身份与性格简述
  appearance      TEXT,                        -- 外形锚点 300-500 字（跨镜头复用的硬设定）
  styling         TEXT,                        -- 造型与服装
  personality     TEXT,
  final_prompt    TEXT,                        -- 最终出图提示词（含风格词前缀）
  image_url       TEXT,
  reference_images TEXT,                       -- JSON 数组
  seed_value      INTEGER,
  sort_order      INTEGER DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  deleted_at      TEXT
);
-- 去重键：项目内同名角色视为同一人（去括号、去空白、转小写后比较）
CREATE UNIQUE INDEX IF NOT EXISTS uq_characters_name
  ON characters(drama_id, lower(trim(name))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_characters_drama ON characters(drama_id);

-- ---------- 场景（项目级，可直挂集） ----------
CREATE TABLE IF NOT EXISTS scenes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id     INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  location     TEXT    NOT NULL,
  time_of_day  TEXT    NOT NULL DEFAULT '日',  -- 日 / 夜 / 黄昏 / 清晨
  prompt       TEXT,
  lighting     TEXT,
  final_prompt TEXT,
  image_url    TEXT,
  status       TEXT    DEFAULT 'pending'       -- pending / processing / done / failed
               CHECK (status IN ('pending','processing','done','failed')),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT
);
-- 去重键：地点 + 时间段 精确匹配
CREATE UNIQUE INDEX IF NOT EXISTS uq_scenes_loc
  ON scenes(drama_id, lower(trim(location)), time_of_day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scenes_drama ON scenes(drama_id);

-- ---------- 道具（项目级） ----------
CREATE TABLE IF NOT EXISTS props (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id     INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  type         TEXT,                           -- 关键信物 / 凶器 / 身份凭证
  description  TEXT,
  prompt       TEXT,
  final_prompt TEXT,
  image_url    TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  deleted_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_props_name
  ON props(drama_id, lower(trim(name))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_props_drama ON props(drama_id);

-- ---------- 分镜（一个分镜 = 一个视频生成任务） ----------
CREATE TABLE IF NOT EXISTS storyboards (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id        INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  scene_id          INTEGER REFERENCES scenes(id) ON DELETE SET NULL,
  storyboard_number INTEGER NOT NULL,          -- S01 / S02 ...
  title             TEXT,
  location          TEXT,
  time_of_day       TEXT,
  shot_type         TEXT,                      -- 全景 / 中景 / 近景 / 特写 / 空镜
  angle             TEXT,                      -- 平视 / 俯拍 / 仰拍
  movement          TEXT,                      -- 固定 / 缓推 / 拉 / 横摇 / 手持
  result            TEXT,                      -- 画面内容（动作/表情/调度）
  atmosphere        TEXT,                      -- 氛围与情绪
  image_prompt      TEXT,                      -- 首帧图提示词
  video_prompt      TEXT,                      -- 视频提示词（按 3 秒分段）
  bgm_prompt        TEXT,
  sound_effect      TEXT,
  description       TEXT,
  duration_sec      REAL DEFAULT 10,           -- 8-15 秒
  first_frame_image TEXT,
  last_frame_image  TEXT,
  composed_image    TEXT,
  reference_images  TEXT,                      -- JSON 数组
  video_url         TEXT,
  subtitle_url      TEXT,
  status            TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','prompted','imaging','imaged','videoing','done','failed')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_storyboards_num ON storyboards(episode_id, storyboard_number);
CREATE INDEX IF NOT EXISTS idx_storyboards_episode ON storyboards(episode_id);

-- ---------- 桥表 ----------
CREATE TABLE IF NOT EXISTS episode_characters (
  episode_id   INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (episode_id, character_id)
);
CREATE TABLE IF NOT EXISTS episode_scenes (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  PRIMARY KEY (episode_id, scene_id)
);
CREATE TABLE IF NOT EXISTS episode_props (
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  prop_id    INTEGER NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  PRIMARY KEY (episode_id, prop_id)
);
CREATE TABLE IF NOT EXISTS storyboard_characters (
  storyboard_id INTEGER NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  character_id  INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (storyboard_id, character_id)
);
CREATE TABLE IF NOT EXISTS storyboard_props (
  storyboard_id INTEGER NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  prop_id       INTEGER NOT NULL REFERENCES props(id) ON DELETE CASCADE,
  PRIMARY KEY (storyboard_id, prop_id)
);

-- ---------- 画布布局（唯一新增表，只存坐标） ----------
CREATE TABLE IF NOT EXISTS canvas_layout (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id   INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  node_type  TEXT    NOT NULL
             CHECK (node_type IN ('drama','episode','character','scene','prop','storyboard','video')),
  node_id    INTEGER NOT NULL,
  x          REAL    NOT NULL DEFAULT 0,
  y          REAL    NOT NULL DEFAULT 0,
  w          REAL    DEFAULT 280,
  h          REAL    DEFAULT 180,
  z_index    INTEGER DEFAULT 0,
  collapsed  INTEGER DEFAULT 0,
  updated_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canvas_node ON canvas_layout(drama_id, node_type, node_id);
CREATE INDEX IF NOT EXISTS idx_canvas_drama ON canvas_layout(drama_id);

-- ---------- 生成任务 ----------
CREATE TABLE IF NOT EXISTS gen_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type     TEXT NOT NULL CHECK (task_type IN ('image','video','audio')),
  provider      TEXT,
  model         TEXT,
  prompt        TEXT,
  params        TEXT,                          -- JSON
  upstream_id   TEXT,                          -- 上游任务 ID
  result_url    TEXT,
  local_path    TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                CHECK (status IN ('processing','completed','failed')),
  error_msg     TEXT,
  drama_id      INTEGER,
  episode_id    INTEGER,
  storyboard_id INTEGER,
  target_type   TEXT,                          -- character / scene / prop / storyboard
  target_id     INTEGER,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON gen_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_episode ON gen_tasks(episode_id);

-- ---------- 拼接记录 ----------
CREATE TABLE IF NOT EXISTS merges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id    INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  provider    TEXT,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','completed','failed')),
  segments    TEXT,                            -- JSON 数组：分镜 id 顺序
  merged_url  TEXT,
  duration    REAL,
  error_msg   TEXT,
  created_at  TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merges_episode ON merges(episode_id);

-- ---------- AI 配置 ----------
CREATE TABLE IF NOT EXISTS ai_configs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  service_type   TEXT NOT NULL,                -- text / image / video / audio
  provider       TEXT NOT NULL,
  name           TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  models         TEXT,                         -- JSON 数组
  default_model  TEXT,
  endpoint       TEXT,
  query_endpoint TEXT,
  priority       INTEGER DEFAULT 0,
  is_default     INTEGER DEFAULT 0,
  is_active      INTEGER DEFAULT 1,
  settings       TEXT,                         -- JSON
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_type ON ai_configs(service_type, is_active);

-- ---------- 助手会话 ----------
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id   INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL DEFAULT 'assistant'
             CHECK (mode IN ('assistant','team')),
  title      TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content    TEXT,
  meta       TEXT,                             -- JSON：工具调用、阶段、gate 等
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_session ON chat_messages(session_id);

-- ---------- 设置 ----------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- ===================== v2 迁移（在既有 schema.sql 末尾追加） =====================

-- 1) canvas_layout 按集归组：存量行 episode_id 为 NULL，视为项目级
ALTER TABLE canvas_layout ADD COLUMN episode_id INTEGER;

-- 2) 集容器坐标表
CREATE TABLE IF NOT EXISTS canvas_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id    INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  episode_id  INTEGER NOT NULL,
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  w           REAL NOT NULL DEFAULT 900,
  h           REAL NOT NULL DEFAULT 620,
  collapsed   INTEGER DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_canvas_group ON canvas_groups(drama_id, episode_id);

-- 3) 流水线任务主表
CREATE TABLE IF NOT EXISTS pipeline_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id            INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  script_hash         TEXT NOT NULL,
  script_chars        INTEGER DEFAULT 0,
  total_episodes      INTEGER DEFAULT 0,
  completed_episodes  INTEGER DEFAULT 0,
  failed_episodes     INTEGER DEFAULT 0,
  current_episode     INTEGER,
  current_step        TEXT,
  percent             INTEGER DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','failed')),
  aspect              TEXT DEFAULT '9:16',
  auto_image          INTEGER DEFAULT 0,
  error_summary       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_drama  ON pipeline_tasks(drama_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_status ON pipeline_tasks(status, updated_at);
-- 幂等：同项目 + 同剧本指纹，仅允许一条进行中任务（E-03 的数据库兜底）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_active
  ON pipeline_tasks(drama_id, script_hash) WHERE status IN ('queued','running');

-- 4) 流水线步骤明细
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES pipeline_tasks(id) ON DELETE CASCADE,
  episode_id     INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  step           TEXT NOT NULL CHECK (step IN ('script','extract','storyboard','image')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','skipped')),
  result_json    TEXT,
  error_msg      TEXT,
  attempts       INTEGER DEFAULT 0,
  started_at     TEXT,
  finished_at    TEXT,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_step ON pipeline_steps(task_id, episode_id, step);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_task ON pipeline_steps(task_id, status, id);

-- 5) merges 可选索引（便于按项目取最新合成任务）
CREATE INDEX IF NOT EXISTS idx_merges_created ON merges(drama_id, created_at DESC);
