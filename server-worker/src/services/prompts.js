/**
 * 提示词模板层
 * 规则来源：
 *   - 剧本格式、分镜节拍：短剧创作专家团 screenplay-workflow
 *   - 资产去重与字段边界：AI 短剧生产平台 ai-drama-platform 九阶段数据契约
 *   - 爽点与节奏：番茄小说 webnovel-pipeline-baseline
 *
 * 所有生成接口统一要求模型输出 JSON；解析层负责剥离 ```json 围栏与前后噪声。
 */

/* ================= 剧本影视化改写 ================= */

export const SCRIPT_SYSTEM = `你是短剧编剧，负责把故事素材改写成可拍摄的标准剧本格式。

输出格式（严格遵守，不许加解释）：
## S01 | 内景 · 客厅 | 夜
（动作描写：只写看得见、拍得出的动作与表情，不写心理活动，不用镜头语言）
老陈：（压着嗓子）喂？公安局？
小雅：（一把夺过手机）爸，挂掉！

硬性规则：
1. 场景头格式固定为 "## S编号 | 内景/外景 · 地点 | 时间段"，时间段只用 日/夜/黄昏/清晨。
2. 动作描写是自然段，不加任何镜头术语（不许出现"特写""推镜""拉镜"）。
3. 对白格式 "角色名：（状态或表情）台词内容"，状态词要能演出来。
4. 每场戏控制在 30-60 秒的实际时长（按 4.5 字/秒估算台词）。
5. 只输出剧本正文，不写大纲、不写创作说明、不写集号标题。`;

export function scriptUserPrompt({ title, genre, style, audience, inspiration, content, outline }) {
  return [
    `剧名：${title || '未命名'}`,
    genre ? `题材：${genre}` : '',
    style ? `风格：${style}` : '',
    audience ? `受众：${audience}` : '',
    inspiration ? `用户指定的创作灵感（硬设定，不得违反）：${inspiration}` : '',
    outline ? `本集集纲：${outline}` : '',
    '',
    '待改写素材：',
    content || '（无原始素材，请按上述设定直接原创一集）',
  ].filter(Boolean).join('\n');
}

/* ================= 资产提取 ================= */

export const EXTRACT_SYSTEM = `你是短剧制片，负责从剧本里提取可复用的视觉资产。

只输出 JSON，结构如下：
{
  "characters": [
    { "name": "角色名", "role": "主角|反派|配角", "description": "身份与性格一句话",
      "appearance": "外形锚点：年龄、体型、脸型、发型、五官特征、惯常表情，300-500字，写得越具体越能保证跨镜头一致",
      "styling": "造型与服装，含颜色与材质" }
  ],
  "scenes": [
    { "location": "地点名", "time_of_day": "日|夜|黄昏|清晨", "prompt": "场景视觉描述", "lighting": "光线来源与色温" }
  ],
  "props": [
    { "name": "道具名", "type": "关键信物|凶器|身份凭证|日常物品", "description": "外形与出现意义" }
  ]
}

硬性规则：
1. 角色与场景必须覆盖剧本里出现的全部对象，不要遗漏。
2. 同名角色只出现一次（去掉括号注释后比较）。
3. 道具最多 3 个，只收"能被镜头单独拍出来、且推动剧情"的关键道具，日常背景物不收。
4. appearance 必须写足 300 字以上，这是跨镜头形象一致的唯一依据。`;

export function extractUserPrompt(script) {
  return `剧本正文：\n\n${script}`;
}

/* ================= 分镜拆解 ================= */

export const STORYBOARD_SYSTEM = `你是分镜师，负责把剧本拆成可直接投喂视频模型的镜头段落。

只输出 JSON 数组：
[
  {
    "storyboard_number": 1,
    "title": "S01",
    "scene_location": "客厅",
    "scene_time_of_day": "夜",
    "shot_type": "全景|中景|近景|特写|空镜",
    "angle": "平视|俯拍|仰拍",
    "movement": "固定|缓推|拉|横摇|手持",
    "result": "画面内容：谁在做什么、表情、走位、道具状态",
    "atmosphere": "氛围与情绪",
    "description": "本段叙事作用一句话",
    "duration_sec": 12,
    "character_names": ["老陈"],
    "prop_names": ["手机"]
  }
]

硬性规则：
1. 一个分镜 = 一个视频生成任务，时长 8-15 秒，不许跨场景。
2. 段落数 ≈ 剧本总时长 ÷ 12 秒，允许 ±20% 浮动。
3. 台词下限：段落时长 ≥ 本段台词字数 ÷ 4.5 + 2 秒。台词多的段落必须给足时长。
4. 每个分镜只写 1 个主镜头，不要在一个分镜里写 3 个子镜头（子镜头由视频提示词阶段展开）。
5. character_names 必须来自给定的角色表，prop_names 必须来自给定的道具表，不许新造。
6. 第一个分镜必须是建立镜头，最后一个必须留钩子。
7. 即使给定素材很短（只有一两句台词或一个动作），也必须输出至少 1 个分镜，不许返回空数组。`;

export function storyboardUserPrompt({ script, characters, scenes, props, totalSeconds }) {
  return [
    script ? `剧本正文：\n${script}` : '',
    '',
    '可用角色表（名字必须原样使用）：',
    characters.map((c) => `- ${c.name}`).join('\n') || '（无）',
    '',
    '可用场景表：',
    scenes.map((s) => `- ${s.location} · ${s.time_of_day}`).join('\n') || '（无）',
    '',
    '可用道具表（名字必须原样使用）：',
    props.map((p) => `- ${p.name}`).join('\n') || '（无）',
    '',
    totalSeconds ? `目标总时长约 ${totalSeconds} 秒。` : '',
  ].filter(Boolean).join('\n');
}

/* ================= 图片提示词 ================= */

export const IMAGE_PROMPT_SYSTEM = `你为 AI 绘图模型写提示词。
只输出提示词正文一行，不要解释、不要引号、不要标题。

写法顺序：主体 → 外形细节 → 动作表情 → 服装 → 环境 → 光线 → 镜头与画幅 → 质感
禁止写：具体品牌、真实人名、平台名、任何负面评价词。`;

export function characterImagePrompt(c) {
  return `请为角色「${c.name}」写一张定妆照提示词。
外形锚点：${c.appearance || c.description || ''}
造型：${c.styling || '按角色身份匹配'}。
要求：三视图式正面半身，纯色背景便于抠像，均匀柔光，写实摄影质感。`;
}
export function sceneImagePrompt(s) {
  return `请为场景「${s.location} · ${s.time_of_day}」写一张概念图提示词。
场景描述：${s.prompt || ''}
光线：${s.lighting || '自然光'}。
要求：空镜，画面里不允许出现任何人物。`;
}
export function propImagePrompt(p) {
  return `请为道具「${p.name}」写一张白底单品图提示词。
描述：${p.description || ''}。
要求：产品摄影视角，白底，柔和阴影，细节清晰。`;
}

/* ================= 视频提示词 ================= */

export const VIDEO_PROMPT_SYSTEM = `你为 AI 视频模型写分镜视频提示词。

输出格式（严格遵守）：
第一行：信息头，格式 "【场景】地点 · 时间段 ｜ 【出场】角色A、角色B"
之后按 3 秒一段切分，每段以 "【0-3s】" "【3-6s】" 开头，段内写镜头运动、主体动作、表情变化、环境动态、声音提示。
段数 = 分镜时长 ÷ 3 向上取整，各段相加必须等于分镜总时长。

纪律：
1. 每个分镜对应一个视频任务，不要跨分镜续写。
2. 人物形象必须复用给定形象锚点里的原词，不许换同义词。
3. 不写台词字幕，声音只写环境音与音效。`;

export function videoPromptUser({ sb, characters, scene }) {
  return [
    `分镜 S${String(sb.storyboard_number).padStart(2, '0')}`,
    `时长：${sb.duration_sec} 秒`,
    `景别/角度/运镜：${sb.shot_type} / ${sb.angle} / ${sb.movement}`,
    `画面内容：${sb.result || ''}`,
    `氛围：${sb.atmosphere || ''}`,
    scene ? `场景：${scene.location} · ${scene.time_of_day}（${scene.prompt || ''}）` : '',
    '',
    '出场角色形象锚点（必须逐字复用）：',
    characters.map((c) => `- ${c.name}：${c.appearance || c.description || ''}`).join('\n') || '（无）',
  ].filter(Boolean).join('\n');
}

/* ================= 通用 JSON 提取 ================= */

/**
 * 从模型输出里提取 JSON。
 * 处理三种常见污染：```json 围栏、前后解释文字、尾随逗号。
 */
export function extractJson(text) {
  if (!text) throw new Error('模型未返回内容');
  let s = String(text).trim();

  // 1. 去掉 markdown 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // 2. 直接 parse
  try { return JSON.parse(s); } catch { /* 继续降级 */ }

  // 3. 截取第一个 { 或 [ 到最后一个 } 或 ]
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1, open = '', close = '';
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) { start = firstArr; open = '['; close = ']'; }
  else if (firstObj !== -1) { start = firstObj; open = '{'; close = '}'; }
  if (start !== -1) {
    const end = s.lastIndexOf(close);
    if (end > start) {
      let seg = s.slice(start, end + 1);
      try { return JSON.parse(seg); } catch { /* 尾逗号 */ }
      seg = seg.replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(seg); } catch { /* 放弃 */ }
    }
  }
  // 4. 截断修复：模型被 max_tokens 掐断时，回退到最后一个完整对象再补括号
  if (start !== -1) {
    const seg = s.slice(start);
    const lastObjEnd = seg.lastIndexOf('}');
    if (lastObjEnd > 0) {
      let repaired = seg.slice(0, lastObjEnd + 1);
      // 补齐未闭合的数组/对象括号
      const openArr = (repaired.match(/\[/g) || []).length;
      const closeArr = (repaired.match(/\]/g) || []).length;
      const openObj = (repaired.match(/\{/g) || []).length;
      const closeObj = (repaired.match(/\}/g) || []).length;
      repaired += ']'.repeat(Math.max(0, openArr - closeArr));
      repaired += '}'.repeat(Math.max(0, openObj - closeObj));
      try {
        const parsed = JSON.parse(repaired);
        if (Array.isArray(parsed) && parsed.length) return parsed;
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) return parsed;
      } catch { /* 放弃 */ }
    }
  }
  throw new Error('模型输出不是合法 JSON（可能被 max_tokens 截断）：' + s.slice(0, 200));
}
