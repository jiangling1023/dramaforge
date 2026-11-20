/**
 * 生成路由（Workers 版）
 * 所有入口都支持 scope：只处理用户选中的集 / 镜号，绝不默认全集扫射。
 *   scope = { episodeIds?: number[], storyboardNumbers?: number[], onlyMissing?: boolean }
 * script/extract/storyboard/image 的核心逻辑已抽到 services/generation.js，这里只做参数透传与响应映射。
 */
import { Hono } from 'hono';
import { now, plain, plainAll } from '../db.js';
import * as P from '../services/prompts.js';
import { runScript, runExtract, runStoryboard, runImage } from '../services/generation.js';

const ok = (c, data) => c.json({ success: true, data });
// §4.1 统一错误响应体：error 对象须含 message + code；第 3 参为 HTTP status、第 4 参为业务码（默认按 status 映射）
const ERROR_CODES = { 400: 'VALIDATION_ERROR', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 504: 'TASK_TIMEOUT' };
const bad = (c, message, status = 400, code) => c.json({ success: false, error: { message, code: code || ERROR_CODES[status] || 'INTERNAL_ERROR' } }, status);

export function generateRoutes(db, ai) {
  const r = new Hono();

  /* ================= 1. 剧本影视化改写 ================= */
  r.post('/script', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await runScript(db, ai, body);
    if (res.error) return bad(c, res.error.message, res.error.status);
    return ok(c, res.data);
  });

  /* ================= 2. 资产提取（角色/场景/道具） ================= */
  r.post('/extract', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await runExtract(db, ai, body);
    if (res.error) return bad(c, res.error.message, res.error.status);
    return ok(c, res.data);
  });

  /* ================= 3. 分镜拆解 ================= */
  r.post('/storyboard', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await runStoryboard(db, ai, body);
    if (res.error) return bad(c, res.error.message, res.error.status);
    return ok(c, res.data);
  });

  /* ================= 4. 图片提示词 + 出图 ================= */
  r.post('/image', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const res = await runImage(db, ai, body);
    if (res.error) return bad(c, res.error.message, res.error.status);
    return ok(c, res.data);
  });

  /* ================= 5. 视频提示词 + 出视频 ================= */
  r.post('/video', async (c) => {
    const { storyboardId, withPrompt = true } = await c.req.json().catch(() => ({}));
    const sb = await db.first('storyboards', { id: storyboardId });
    if (!sb) return bad(c, '分镜不存在', 404);

    const episode = await db.first('episodes', { id: sb.episode_id });
    const scLinks = await db.select('storyboard_characters', { storyboard_id: storyboardId }, { columns: 'character_id' });
    const characters = scLinks.length
      ? plainAll(await db.select('characters', { id__in: scLinks.map((x) => x.character_id) }))
      : [];
    const scene = sb.scene_id ? plain(await db.first('scenes', { id: sb.scene_id })) : null;

    let promptText = sb.video_prompt;
    if (withPrompt && !promptText) {
      const out = await ai.chat({
        messages: [
          { role: 'system', content: P.VIDEO_PROMPT_SYSTEM },
          { role: 'user', content: P.videoPromptUser({ sb, characters, scene }) },
        ],
        temperature: 0.6, maxTokens: 3000,
      });
      promptText = out.content.trim();
      await db.update('storyboards', { id: storyboardId }, {
        video_prompt: promptText, status: 'prompted', updated_at: now(),
      });
    }
    if (!promptText) return bad(c, '缺少视频提示词');

    // 首帧图作为图生视频输入
    const firstFrame = sb.first_frame_image || sb.composed_image || null;

    const created = await ai.video({
      prompt: promptText,
      image: firstFrame || undefined,
      duration: Math.round(sb.duration_sec || 10),
    });

    const taskRow = await db.insertOne('gen_tasks', {
      task_type: 'video',
      model: created.model,
      prompt: promptText,
      upstream_id: created.taskId || null,
      result_url: created.url || null,
      status: created.status,
      drama_id: episode?.drama_id || null,
      episode_id: sb.episode_id,
      storyboard_id: storyboardId,
      target_type: 'storyboard',
      target_id: storyboardId,
      created_at: now(),
    });

    if (created.url) {
      await db.update('storyboards', { id: storyboardId }, {
        video_url: created.url, status: 'done', updated_at: now(),
      });
    } else {
      await db.update('storyboards', { id: storyboardId }, { status: 'videoing', updated_at: now() });
    }

    return ok(c, {
      taskId: taskRow.id,
      upstreamId: created.taskId,
      status: created.status,
      videoUrl: created.url,
      prompt: promptText,
    });
  });

  /* ================= 6. 任务轮询 ================= */
  r.get('/task/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const task = await db.first('gen_tasks', { id });
    if (!task) return bad(c, '任务不存在', 404);
    if (task.status === 'completed' || task.status === 'failed') return ok(c, plain(task));

    const out = await ai.videoStatus(task.upstream_id);
    if (out.status === 'completed' && out.url) {
      await db.update('gen_tasks', { id: task.id }, {
        status: 'completed', result_url: out.url, completed_at: now(),
      });
      if (task.storyboard_id) {
        await db.update('storyboards', { id: task.storyboard_id }, {
          video_url: out.url, status: 'done', updated_at: now(),
        });
      }
    } else if (out.status === 'failed') {
      await db.update('gen_tasks', { id: task.id }, {
        status: 'failed', error_msg: '上游返回失败：' + out.rawStatus, completed_at: now(),
      });
    }
    return ok(c, plain(await db.first('gen_tasks', { id: task.id })));
  });

  return r;
}
