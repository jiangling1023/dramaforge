/**
 * 小说转短剧提示词生成接口
 * 
 * 将长篇小说内容转换为短剧创作提示词，包括：
 * - 故事大纲提取
 * - 角色设定生成
 * - 分集脚本框架
 * - 视觉提示词模板
 */
import { Hono } from 'hono';
import { now, plain, plainAll } from '../db.js';

const ok = (c, data) => c.json({ success: true, data });
const bad = (c, message, status = 400) => c.json({ success: false, error: { message } }, status);

export const novelRoutes = (ai) => {
  const r = new Hono();

  /**
   * POST /api/novel-to-drama/generate
   * 将小说内容转换为短剧提示词
   */
  r.post('/generate', async (c) => {
    const b = await c.req.json().catch(() => ({}));

    // 参数校验
    if (!b.novel_content) return bad(c, '缺少小说内容');
    if (!b.novel_title) return bad(c, '缺少小说标题');

    // 获取默认模型配置
    const aiConfig = await ai.getActiveConfig('text');
    if (!aiConfig) return bad(c, '未配置文本生成模型');

    // 构建系统提示词（基于技能包模板）
    const systemPrompt = buildSystemPrompt(b);
    const userPrompt = buildUserPrompt(b);

    try {
      // 调用 AI 生成（禁用流式，获取完整 JSON）
      const result = await ai.chat({
        model: aiConfig.default_model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 4000,
        stream: false,
      });

      // 解析返回的 JSON 结构
      let generatedData;
      try {
        generatedData = JSON.parse(result.content);
      } catch {
        // 如果不是 JSON，包装成标准格式
        generatedData = { raw_output: result.content };
      }

      return ok(c, {
        ...generatedData,
        novel_title: b.novel_title,
        episode_count: b.episode_count || 60,
        generated_at: now(),
      });
    } catch (e) {
      console.error('小说转短剧失败:', e.message);
      return bad(c, `生成失败: ${e.message}`, 500);
    }
  });

  /**
   * GET /api/novel-to-drama/templates
   * 获取提示词模板
   */
  r.get('/templates', (c) => {
    return ok(c, {
      outline_template: {
        description: '故事大纲提取模板',
        fields: ['背景设定', '核心冲突', '人物关系', '剧情主线', '结局走向'],
      },
      character_template: {
        description: '角色设定模板',
        fields: ['姓名', '年龄', '性格', '外貌特征', '背景故事', '人物弧光'],
      },
      episode_template: {
        description: '分集脚本模板',
        fields: ['集数', '标题', '场景', '情节概要', '关键对话', '情绪曲线'],
      },
      visual_template: {
        description: '视觉提示词模板',
        fields: ['镜头类型', '场景描述', '人物姿态', '光影效果', '色彩基调', '风格参考'],
      },
    });
  });

  return r;
};

/**
 * 构建系统提示词
 */
function buildSystemPrompt(req) {
  return `你是一位专业的短剧编剧和提示词设计师，擅长将长篇小说改编为适合短视频平台的短剧剧本。

你的任务是将用户提供的小说内容转换为以下结构化输出：

1. **故事大纲** - 提取核心冲突、人物关系和剧情主线
2. **角色设定** - 为每个主要角色创建详细的视觉和行为描述
3. **分集框架** - 将故事划分为指定集数的剧情节点
4. **视觉提示词** - 为每个关键场景生成 AI 绘画/视频生成提示词

输出格式必须为有效的 JSON，包含以下字段：
{
  "title": "短剧标题",
  "genre": "类型",
  "logline": "一句话简介",
  "characters": [{ "name": "角色名", "description": "角色描述", "visual_prompt": "视觉提示词" }],
  "outline": { "background": "背景", "conflict": "核心冲突", "resolution": "结局" },
  "episodes": [{ "episode": 集数, "title": "标题", "summary": "情节概要", "visual_prompts": ["提示词1", "提示词2"] }],
  "key_scenes": [{ "scene": "场景名", "prompt": "详细视觉提示词" }]
}`;
}

/**
 * 构建用户提示词
 */
function buildUserPrompt(req) {
  const { novel_title, novel_content, episode_count = 60 } = req;
  return `请将以下小说改编为短剧：

小说标题：${novel_title}
目标集数：${episode_count} 集

小说内容（摘要）：
${novel_content.substring(0, 3000)}...

请按照以下要求生成：
1. 保留原作的核心冲突和人物弧光
2. 每集设置明确的戏剧钩子
3. 生成适合 AI 生成的视觉提示词
4. 输出完整的 JSON 结构`;
}
