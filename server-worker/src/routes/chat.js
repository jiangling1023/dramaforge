/**
 * 智能助手对话路由（Workers 版）— 带工具调用闭环
 *
 * 流程：用户消息 → LLM → 可能返回 <tool_use> → 执行工具 → 追加结果 → 再请求LLM → 最终文本回复
 * 最多 MAX_TOOL_CALLS=8 次工具调用循环，防止死循环。
 */
import { Hono } from 'hono';
import { now, plain, plainAll } from '../db.js';
import { buildTools, execToolCall, buildSystemPrompt, expertForTool, EXPERTS } from '../services/assistant.js';

const ok = (c, data) => c.json({ success: true, data });
// §4.1 统一错误响应体：error 对象须含 message + code；第 3 参为 HTTP status、第 4 参为业务码（默认按 status 映射）
const ERROR_CODES = { 400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 504: 'TASK_TIMEOUT' };
const bad = (c, message, status = 400, code) => c.json({ success: false, error: { message, code: code || ERROR_CODES[status] || 'INTERNAL_ERROR' } }, status);

const MAX_TOOL_CALLS = 8;

/** 解析 AI 回复中的工具调用和结果块 */
function parseToolCalls(text) {
  const results = [];

  // 格式1：标准 tool_use name="xxx">... 块
  const re1 = /<tool_use\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_use>/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    const name = m[1];
    let params = {};
    try { params = JSON.parse(m[2].trim()); } catch { /* 非JSON则当空对象 */ }
    results.push({ name, params, raw: m[0] });
  }

  // 格式2：openai-like tool_calls_begin ... tool_calls_end
  // 中间是 JSON：{"tool":"project.characters","args":{}}
  const re2 = /<tool_calls_begin>([\s\S]*?)<tool_calls_end>/g;
  while ((m = re2.exec(text)) !== null) {
    const block = m[1].trim();
    const lines = block.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim());
        if (obj.tool && obj.args !== undefined) {
          results.push({ name: obj.tool, params: obj.args, raw: line });
        }
      } catch { /* 忽略无法解析的行 */ }
    }
  }

  // 移除结果块，避免污染最终文本
  const cleanText = text
    .replace(/<tool_calls_begin>[\s\S]*?<tool_calls_end>/g, '')
    .replace(/<tool_results_begin>[\s\S]*?<tool_results_end>/g, '')
    .replace(/<tool_use[\s\S]*?<\/tool_use>/g, '')
    .trim();

  return { toolCalls: results, text: cleanText };
}

export function chatRoutes(db, ai) {
  const r = new Hono();

  r.post('/', async (c) => {
    const { dramaId, episodeId, message, history = [], expertId } = await c.req.json().catch(() => ({}));
    if (!dramaId || !message) return bad(c, '需要 dramaId 和 message');
    if (expertId && !EXPERTS[expertId]) return bad(c, 'expertId 只能是 writer / producer / storyboard');

    const drama = await db.first('dramas', { id: dramaId, deleted_at__is: null }, { columns: 'id,title,genre' });
    if (!drama) return bad(c, '项目不存在', 404);

    const dramaIdNum = Number(dramaId);
    const episodeIdNum = episodeId ? Number(episodeId) : null;

    const [episodes, characters, scenes, props, currentEp] = await Promise.all([
      db.select('episodes', { drama_id: dramaIdNum, deleted_at__is: null },
        { columns: 'id,episode_number,title', order: 'episode_number.asc' }),
      db.select('characters', { drama_id: dramaIdNum, deleted_at__is: null },
        { columns: 'id,name,role,appearance' }),
      db.select('scenes', { drama_id: dramaIdNum, deleted_at__is: null },
        { columns: 'id,location,time_of_day' }),
      db.select('props', { drama_id: dramaIdNum, deleted_at__is: null }, { columns: 'id,name' }),
      episodeIdNum ? db.first('episodes', { id: episodeIdNum }) : Promise.resolve(null),
    ]);

    // 原版用 SUBSTR(appearance,1,120) 截断，避免上下文过长；这里改在 JS 里截
    const charsShort = plainAll(characters).map((x) => ({
      id: x.id, name: x.name, role: x.role,
      appearance: String(x.appearance || '').slice(0, 120),
    }));

    const lines = [];
    lines.push('项目：' + drama.title + '（' + (drama.genre || '未分类') + '）');
    if (episodes.length) lines.push('共 ' + episodes.length + ' 集：' + episodes.map((e) => '第' + e.episode_number + '集').join('、'));
    if (currentEp) lines.push('当前集：第 ' + currentEp.episode_number + ' 集「' + currentEp.title + '」');
    if (charsShort.length) lines.push('角色（' + charsShort.length + '个）：' + charsShort.map((x) => x.name + '(' + (x.role || '') + ')').join('、'));
    if (scenes.length) lines.push('场景（' + scenes.length + '个）：' + scenes.map((s) => s.location + (s.time_of_day || '')).join('、'));
    if (props.length) lines.push('道具（' + props.length + '个）：' + props.map((p) => p.name).join('、'));
    const contextSummary = lines.join('\n');

    // 确保 chat session 存在
    let session = await db.first('chat_sessions', { drama_id: dramaIdNum }, { columns: 'id' });
    if (!session) {
      session = await db.insertOne('chat_sessions', {
        drama_id: dramaIdNum, mode: 'assistant', created_at: now(),
      });
    }
    const sessionId = session.id;

    // 构建初始消息链
    const messages = [
      { role: 'system', content: buildSystemPrompt(expertId) },
      { role: 'system', content: '【项目上下文】\n' + contextSummary },
      ...history,
      { role: 'user', content: message },
    ];

    const tools = buildTools(db)(dramaIdNum, episodeIdNum);

    // Agent 循环：最多调用 MAX_TOOL_CALLS 次工具
    const toolCallHistory = [];
    let finalReply = '';
    let callCount = 0;

    while (callCount <= MAX_TOOL_CALLS) {
      const result = await ai.chat({
        messages,
        temperature: 0.7,
        maxTokens: 3000,
        stream: false,
      });

      const replyText = result.content || '';
      const { toolCalls, text } = parseToolCalls(replyText);

      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          try {
            const toolResult = await execToolCall(tc.name, tc.params, tools);
            toolCallHistory.push({
              name: tc.name, params: tc.params, result: toolResult,
              expert: expertForTool(tc.name, tc.params),
            });
            const summary = typeof toolResult === 'string'
              ? toolResult
              : JSON.stringify(toolResult).slice(0, 600);
            messages.push({
              role: 'system',
              content: `【工具 ${tc.name} 执行结果】\n${summary}`,
            });
          } catch (e) {
            messages.push({
              role: 'system',
              content: `【工具 ${tc.name} 执行失败】${e.message}`,
            });
          }
        }
        callCount++;
        continue;
      }

      finalReply = text || replyText;
      break;
    }

    // [expert:xxx] 落 meta，前端据此渲染发言人标；文本标记保留，供前端直接解析
    const expertTag = finalReply.match(/\[expert:\s*(writer|producer|storyboard)\s*\]/i)?.[1]?.toLowerCase() || null;
    const meta = JSON.stringify({ toolCalls: toolCallHistory, expert: expertTag, requestedExpertId: expertId || null });

    // 持久化对话记录
    await db.insert('chat_messages', [
      { session_id: sessionId, role: 'user', content: message, created_at: now() },
      {
        session_id: sessionId, role: 'assistant', content: finalReply,
        meta, created_at: now(),
      },
    ]);

    return ok(c, {
      reply: finalReply,
      toolCalls: toolCallHistory,
      contextSummary: contextSummary.slice(0, 300),
    });
  });

  r.get('/history/:dramaId', async (c) => {
    const dramaId = Number(c.req.param('dramaId'));
    const session = await db.first('chat_sessions', { drama_id: dramaId }, { columns: 'id' });
    if (!session) return ok(c, []);
    const rows = await db.select('chat_messages',
      { session_id: session.id },
      { order: 'created_at.asc', limit: 100 });
    return ok(c, plainAll(rows).map((x) => ({ role: x.role, content: x.content, at: x.created_at })));
  });

  return r;
}
