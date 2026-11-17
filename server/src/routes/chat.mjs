/**
 * 智能助手对话路由 — 带工具调用闭环
 *
 * 流程：用户消息 → LLM → 可能返回 <tool_use> → 执行工具 → 追加结果 → 再请求LLM → 最终文本回复
 * 支持最多 MAX_TOOL_CALLS=8 次工具调用循环，防止死循环。
 */
import { Router } from 'express';
import { db, plain, plainAll, now, parseJson } from '../db/index.mjs';
import * as ai from '../adapters/ai.mjs';
import { buildTools, ASSISTANT_SYSTEM } from '../services/assistant.mjs';
import { execToolCall } from '../services/assistant.mjs';

const r = Router();
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, message, code = 400) => res.status(code).json({ success: false, error: { message } });

const MAX_TOOL_CALLS = 8;

/** 解析 AI 回复中的工具调用和结果块 */
function parseToolCalls(text) {
  const results = [];

  // 格式1：标准 tool_use name="xxx">...  块
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
    // 可能有多行，每行一个 JSON 对象，或整个是一段 JSON
    const lines = block.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line.trim());
        if (obj.tool && obj.args !== undefined) {
          results.push({ name: obj.tool, params: obj.args, raw: line });
        }
      } catch { /* 忽略无法解析的行 */ }
    }
  }

  // 格式3：tool_results_begin ... tool_results_end（结果块，不解析为调用）
  // 直接移除结果块避免污染文本
  const cleanText = text
    .replace(/<tool_calls_begin>[\s\S]*?<tool_calls_end>/g, '')
    .replace(/<tool_results_begin>[\s\S]*?<tool_results_end>/g, '')
    .replace(/<tool_use[\s\S]*?<\/tool_use>/g, '')
    .trim();

  return { toolCalls: results, text: cleanText };
}

r.post('/', async (req, res) => {
  try {
    const { dramaId, episodeId, message, history = [] } = req.body || {};
    if (!dramaId || !message) return bad(res, '需要 dramaId 和 message');

    const drama = db.prepare('SELECT id, title, genre FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId);
    if (!drama) return bad(res, '项目不存在', 404);

    const dramaIdNum = Number(dramaId);
    const episodeIdNum = episodeId ? Number(episodeId) : null;

    const episodes = plainAll(db.prepare(
      'SELECT id, episode_number, title FROM episodes WHERE drama_id=? AND deleted_at IS NULL ORDER BY episode_number'
    ).all(dramaIdNum));

    const characters = plainAll(db.prepare(
      'SELECT id, name, role, SUBSTR(appearance, 1, 120) AS appearance FROM characters WHERE drama_id=? AND deleted_at IS NULL'
    ).all(dramaIdNum));

    const scenes = plainAll(db.prepare(
      'SELECT id, location, time_of_day FROM scenes WHERE drama_id=? AND deleted_at IS NULL'
    ).all(dramaIdNum));

    const props = plainAll(db.prepare(
      'SELECT id, name FROM props WHERE drama_id=? AND deleted_at IS NULL'
    ).all(dramaIdNum));

    const currentEp = episodeIdNum
      ? plain(db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeIdNum))
      : null;

    const lines = [];
    lines.push('项目：' + drama.title + '（' + (drama.genre || '未分类') + '）');
    if (episodes.length) lines.push('共 ' + episodes.length + ' 集：' + episodes.map(e => '第'+e.episode_number+'集').join('、'));
    if (currentEp) lines.push('当前集：第 ' + currentEp.episode_number + ' 集「' + currentEp.title + '」');
    if (characters.length) lines.push('角色（' + characters.length + '个）：' + characters.map(c => c.name+'('+((c.role)||'')+')').join('、'));
    if (scenes.length) lines.push('场景（' + scenes.length + '个）：' + scenes.map(s => s.location+(s.time_of_day||'')).join('、'));
    if (props.length) lines.push('道具（' + props.length + '个）：' + props.map(p => p.name).join('、'));
    const contextSummary = lines.join('\n');

    // 确保 chat session 存在
    let session = db.prepare('SELECT id FROM chat_sessions WHERE drama_id=? LIMIT 1').get(dramaIdNum);
    if (!session) {
      const info = db.prepare('INSERT INTO chat_sessions (drama_id, mode, created_at) VALUES (?, ?, ?)').run(dramaIdNum, 'assistant', now());
      session = { id: info.lastInsertRowid };
    }
    const sessionId = session.id;

    // 构建初始消息链
    const messages = [
      { role: 'system', content: ASSISTANT_SYSTEM },
      { role: 'system', content: '【项目上下文】\n' + contextSummary },
      ...history,
      { role: 'user', content: message },
    ];

    const tools = buildTools({ dramaId: dramaIdNum });

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
        // 有工具调用：执行每个工具，把结果追加为 tool 消息
        for (const tc of toolCalls) {
          try {
            const toolResult = await execToolCall(tc.name, tc.params, tools);
            toolCallHistory.push({ name: tc.name, params: tc.params, result: toolResult });
            // 把工具结果以 system 消息形式追加，供下一轮LLM消费
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
        continue; // 再次请求LLM处理工具结果
      }

      // 无工具调用 → 这就是最终回复
      finalReply = text || replyText;
      break;
    }

    // 持久化对话记录
    db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, 'user', message, now());
    db.prepare('INSERT INTO chat_messages (session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, 'assistant', finalReply, JSON.stringify(toolCallHistory), now());

    ok(res, {
      reply: finalReply,
      toolCalls: toolCallHistory,
      contextSummary: contextSummary.slice(0, 300),
    });
  } catch (e) {
    bad(res, e.message || '对话失败', 502);
  }
});

r.get('/history/:dramaId', (req, res) => {
  const rows = plainAll(db.prepare(
    'SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at ASC LIMIT 100'
  ).all(Number(req.params.dramaId)));
  ok(res, rows.map((r) => ({ role: r.role, content: r.content, at: r.created_time })));
});

export default r;
