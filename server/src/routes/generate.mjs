/**
 * 生成路由
 * 所有入口都支持 scope：只处理用户选中的集 / 镜号，绝不默认全集扫射。
 *   scope = { episodeIds?: number[], storyboardNumbers?: number[], onlyMissing?: boolean }
 */
import { Router } from 'express';
import { db, now, plain, plainAll, tx, parseJson } from '../db/index.mjs';
import * as ai from '../adapters/ai.mjs';
import * as P from '../services/prompts.mjs';

const r = Router();
const ok = (res, data) => res.json({ success: true, data });
const bad = (res, message, code = 400) => res.status(code).json({ success: false, error: { message } });
const guard = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { bad(res, e.message || '生成失败', 502); }
};

/* ============ 解析目标集：支持选集，不传则只处理当前集 ============ */
function resolveEpisodes(dramaId, scope = {}, fallbackEpisodeId) {
  if (Array.isArray(scope.episodeIds) && scope.episodeIds.length) {
    const rows = db.prepare(
      `SELECT * FROM episodes WHERE drama_id=? AND deleted_at IS NULL AND id IN (${scope.episodeIds.map(() => '?').join(',')})
       ORDER BY episode_number`
    ).all(dramaId, ...scope.episodeIds);
    return plainAll(rows);
  }
  if (fallbackEpisodeId) {
    const row = db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(fallbackEpisodeId);
    return row ? [plain(row)] : [];
  }
  return [];
}

/* ================= 1. 剧本影视化改写 ================= */
r.post('/script', guard(async (req, res) => {
  const { dramaId, episodeId, scope } = req.body || {};
  if (!dramaId) return bad(res, '缺少 dramaId');

  const drama = db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId);
  if (!drama) return bad(res, '项目不存在', 404);

  const eps = resolveEpisodes(dramaId, scope, episodeId);
  if (!eps.length) return bad(res, '没有要处理的剧集；请传 episodeId 或 scope.episodeIds 明确选集');

  const results = [];
  for (const ep of eps) {
    // 长文本一次一节，避免推理模型把上下文吃掉
    const { content } = await ai.chat({
      messages: [
        { role: 'system', content: P.SCRIPT_SYSTEM },
        {
          role: 'user',
          content: P.scriptUserPrompt({
            title: drama.title, genre: drama.genre, style: drama.style,
            audience: drama.audience, inspiration: drama.inspiration,
            content: ep.content, outline: ep.outline,
          }),
        },
      ],
      temperature: 0.85,
      maxTokens: 8000,
    });

    if (!content || content.trim().length < 20) {
      results.push({ episodeId: ep.id, ok: false, error: '模型返回内容过短，可能被 max_tokens 截断' });
      continue;
    }
    db.prepare('UPDATE episodes SET script_content=?, status=?, updated_at=? WHERE id=?')
      .run(content.trim(), 'scripted', now(), ep.id);
    results.push({ episodeId: ep.id, episodeNumber: ep.episode_number, ok: true, chars: content.length });
  }
  ok(res, { results });
}));

/* ================= 2. 资产提取（角色/场景/道具） ================= */
r.post('/extract', guard(async (req, res) => {
  const { dramaId, episodeId, scope } = req.body || {};
  if (!dramaId) return bad(res, '缺少 dramaId');

  const eps = resolveEpisodes(dramaId, scope, episodeId);
  if (!eps.length) return bad(res, '没有要处理的剧集');

  const summary = { characters: 0, scenes: 0, props: 0, episodes: 0 };

  for (const ep of eps) {
    const script = ep.script_content || ep.content;
    if (!script) continue;

    const { content } = await ai.chat({
      messages: [
        { role: 'system', content: P.EXTRACT_SYSTEM },
        { role: 'user', content: P.extractUserPrompt(script) },
      ],
      temperature: 0.5,
      maxTokens: 8000,
      timeout: 300_000,   // 角色外观要写 300+ 字，输出较长
    });
    const data = P.extractJson(content);

    tx(() => {
      // --- 角色：按名字去重（同名视为同一人，跨集复用同一条记录） ---
      for (const c of data.characters || []) {
        if (!c.name) continue;
        const exist = db.prepare(
          'SELECT id FROM characters WHERE drama_id=? AND lower(trim(name))=lower(trim(?)) AND deleted_at IS NULL'
        ).get(dramaId, c.name);
        let cid;
        if (exist) {
          cid = exist.id;
          // 只在原值为空时补，避免覆盖人工填写的锚点
          db.prepare(
            `UPDATE characters SET
               role=COALESCE(NULLIF(role,''), ?),
               description=COALESCE(NULLIF(description,''), ?),
               appearance=COALESCE(NULLIF(appearance,''), ?),
               styling=COALESCE(NULLIF(styling,''), ?),
               updated_at=?
             WHERE id=?`
          ).run(c.role || '', c.description || '', c.appearance || '', c.styling || '', now(), cid);
        } else {
          const info = db.prepare(
            `INSERT INTO characters (drama_id, name, role, description, appearance, styling, sort_order, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).run(dramaId, c.name, c.role || null, c.description || null,
            c.appearance || null, c.styling || null, summary.characters, now(), now());
          cid = info.lastInsertRowid;
          summary.characters++;
        }
        db.prepare('INSERT OR IGNORE INTO episode_characters(episode_id, character_id) VALUES (?,?)').run(ep.id, cid);
      }

      // --- 场景：地点 + 时间段 精确匹配 ---
      for (const s of data.scenes || []) {
        if (!s.location) continue;
        const tod = s.time_of_day || '日';
        const exist = db.prepare(
          `SELECT id FROM scenes WHERE drama_id=? AND lower(trim(location))=lower(trim(?))
           AND time_of_day=? AND deleted_at IS NULL`
        ).get(dramaId, s.location, tod);
        let sid;
        if (exist) {
          sid = exist.id;
          db.prepare(
            `UPDATE scenes SET prompt=COALESCE(NULLIF(prompt,''),?), lighting=COALESCE(NULLIF(lighting,''),?), updated_at=? WHERE id=?`
          ).run(s.prompt || '', s.lighting || '', now(), sid);
        } else {
          const info = db.prepare(
            `INSERT INTO scenes (drama_id, location, time_of_day, prompt, lighting, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`
          ).run(dramaId, s.location, tod, s.prompt || null, s.lighting || null, 'pending', now(), now());
          sid = info.lastInsertRowid;
          summary.scenes++;
        }
        db.prepare('INSERT OR IGNORE INTO episode_scenes(episode_id, scene_id) VALUES (?,?)').run(ep.id, sid);
      }

      // --- 道具：上限 3 个 ---
      for (const p of (data.props || []).slice(0, 3)) {
        if (!p.name) continue;
        const exist = db.prepare(
          'SELECT id FROM props WHERE drama_id=? AND lower(trim(name))=lower(trim(?)) AND deleted_at IS NULL'
        ).get(dramaId, p.name);
        let pid;
        if (exist) {
          pid = exist.id;
        } else {
          const info = db.prepare(
            `INSERT INTO props (drama_id, name, type, description, created_at, updated_at)
             VALUES (?,?,?,?,?,?)`
          ).run(dramaId, p.name, p.type || null, p.description || null, now(), now());
          pid = info.lastInsertRowid;
          summary.props++;
        }
        db.prepare('INSERT OR IGNORE INTO episode_props(episode_id, prop_id) VALUES (?,?)').run(ep.id, pid);
      }
    });
    summary.episodes++;
  }
  ok(res, summary);
}));

/* ================= 3. 分镜拆解 ================= */
r.post('/storyboard', guard(async (req, res) => {
  const { dramaId, episodeId, scope } = req.body || {};
  if (!dramaId) return bad(res, '缺少 dramaId');

  const eps = resolveEpisodes(dramaId, scope, episodeId);
  if (!eps.length) return bad(res, '没有要处理的剧集');

  const results = [];

  for (const ep of eps) {
    const script = ep.script_content || ep.content;
    if (!script) { results.push({ episodeId: ep.id, ok: false, error: '本集还没有剧本' }); continue; }

    const characters = plainAll(db.prepare(
      `SELECT c.* FROM characters c
       JOIN episode_characters ec ON ec.character_id=c.id
       WHERE ec.episode_id=? AND c.deleted_at IS NULL`
    ).all(ep.id));
    const scenes = plainAll(db.prepare(
      `SELECT s.* FROM scenes s JOIN episode_scenes es ON es.scene_id=s.id
       WHERE es.episode_id=? AND s.deleted_at IS NULL`
    ).all(ep.id));
    const props = plainAll(db.prepare(
      `SELECT p.* FROM props p JOIN episode_props ep2 ON ep2.prop_id=p.id
       WHERE ep2.episode_id=? AND p.deleted_at IS NULL`
    ).all(ep.id));

    // 上游网关在约 60-75 秒会掐断长请求，整集一次出 JSON 必然 502。
    // 按场景切块、每块单独请求，既规避超时，又天然满足「分镜不跨场景」。
    const sceneBlocks = splitScenes(script);
    const arr = [];
    const failures = [];

    // 并发跑各块：串行总时长会超网关窗口，并发把整体压到 60 秒内。
    const tasks = sceneBlocks.map((block, bi) => (async () => {
      const { content } = await ai.chat({
        messages: [
          { role: 'system', content: P.STORYBOARD_SYSTEM },
          {
            role: 'user',
            content: P.storyboardUserPrompt({
              script: block, characters, scenes, props,
              totalSeconds: ep.duration_sec || 0,
            }),
          },
        ],
        temperature: 0.6,
        maxTokens: 8000,
        timeout: 300_000,
      });
      const parsed = P.extractJson(content);
      return Array.isArray(parsed) ? parsed : parsed.storyboards || [];
    })().then((part) => ({ ok: true, part }))
       .catch((e) => ({ ok: false, error: `块${bi + 1}: ${e.message}` })));

    const settled = await Promise.all(tasks);
    for (const r of settled) {
      if (r.ok) arr.push(...r.part);
      else failures.push(r.error);
    }

    if (!arr.length) {
      results.push({ episodeId: ep.id, ok: false, error: '全部分块失败：' + failures.join(' | ') });
      continue;
    }

    // 名字 → id 映射，用于写桥表
    const charMap = new Map(characters.map((c) => [c.name, c.id]));
    const propMap = new Map(props.map((p) => [p.name, p.id]));
    const sceneMap = new Map(scenes.map((s) => [`${s.location}|${s.time_of_day}`, s.id]));

    tx(() => {
      // 整集重拆：先清空旧分镜（含桥表），保证重跑幂等
      const olds = db.prepare('SELECT id FROM storyboards WHERE episode_id=?').all(ep.id);
      for (const o of olds) {
        db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id=?').run(o.id);
        db.prepare('DELETE FROM storyboard_props WHERE storyboard_id=?').run(o.id);
      }
      db.prepare('DELETE FROM storyboards WHERE episode_id=?').run(ep.id);

      let total = 0;
      arr.forEach((s, i) => {
        // 并发分块各自从 1 开始编号，必须按最终顺序重排，否则撞唯一索引
        const num = i + 1;
        const dur = Number(s.duration_sec) || 10;
        total += dur;
        const sid = sceneMap.get(`${s.scene_location || ''}|${s.scene_time_of_day || '日'}`)
          || sceneMap.get(`${s.scene_location || ''}|日`) || null;
        const info = db.prepare(
          `INSERT INTO storyboards
           (episode_id, scene_id, storyboard_number, title, location, time_of_day, shot_type, angle,
            movement, result, atmosphere, description, duration_sec, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          ep.id, sid, num, s.title || `S${String(num).padStart(2, '0')}`,
          s.scene_location || null, s.scene_time_of_day || null,
          s.shot_type || '中景', s.angle || '平视', s.movement || '固定',
          s.result || null, s.atmosphere || null, s.description || null,
          dur, 'pending', now(), now()
        );
        const sbid = info.lastInsertRowid;
        for (const n of s.character_names || []) {
          const cid = charMap.get(n);
          if (cid) db.prepare('INSERT OR IGNORE INTO storyboard_characters(storyboard_id, character_id) VALUES (?,?)').run(sbid, cid);
        }
        for (const n of s.prop_names || []) {
          const pid = propMap.get(n);
          if (pid) db.prepare('INSERT OR IGNORE INTO storyboard_props(storyboard_id, prop_id) VALUES (?,?)').run(sbid, pid);
        }
      });

      // 回写本集时长（分钟向上取整前先存秒）
      db.prepare('UPDATE episodes SET duration_sec=?, status=?, updated_at=? WHERE id=?')
        .run(Math.round(total), 'storied', now(), ep.id);
    });

    results.push({
      episodeId: ep.id, episodeNumber: ep.episode_number, ok: true,
      count: arr.length, blocks: sceneBlocks.length,
      ...(failures.length ? { warnings: failures } : {}),
    });
  }
  ok(res, { results });
}));

/* ================= 4. 图片提示词 + 出图 ================= */
r.post('/image', guard(async (req, res) => {
  const { targetType, targetId, size, withPrompt = true } = req.body || {};
  const table = { character: 'characters', scene: 'scenes', prop: 'props' }[targetType];
  if (!table) return bad(res, 'targetType 只能是 character / scene / prop');

  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(targetId);
  if (!row) return bad(res, '目标资产不存在', 404);

  // 1) 没提示词先生成
  let promptText = row.final_prompt;
  if (withPrompt && !promptText) {
    const sys = P.IMAGE_PROMPT_SYSTEM;
    const usr =
      targetType === 'character' ? P.characterImagePrompt(row)
        : targetType === 'scene' ? P.sceneImagePrompt(row)
          : P.propImagePrompt(row);
    const { content } = await ai.chat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      temperature: 0.7, maxTokens: 1200,
    });
    promptText = content.trim().split('\n')[0].replace(/^["「]|["」]$/g, '');
    db.prepare(`UPDATE ${table} SET final_prompt=?, updated_at=? WHERE id=?`).run(promptText, now(), targetId);
  }
  if (!promptText) return bad(res, '缺少提示词且生成失败');

  // 2) 出图
  const defaultSize = targetType === 'prop' ? '1024x1024' : '1920x1080';
  const out = await ai.image({
    prompt: promptText,
    size: size || defaultSize,
    negativePrompt: targetType === 'scene' ? '人物, 人脸, 人影, 剪影' : undefined,
  });

  db.prepare(`UPDATE ${table} SET image_url=?, updated_at=? WHERE id=?`).run(out.url, now(), targetId);
  if (targetType === 'scene') {
    db.prepare('UPDATE scenes SET status=? WHERE id=?').run('done', targetId);
  }
  ok(res, { prompt: promptText, imageUrl: out.url, model: out.model });
}));

/* ================= 5. 视频提示词 + 出视频 ================= */
r.post('/video', guard(async (req, res) => {
  const { storyboardId, withPrompt = true } = req.body || {};
  const sb = db.prepare('SELECT * FROM storyboards WHERE id=?').get(storyboardId);
  if (!sb) return bad(res, '分镜不存在', 404);

  const episode = db.prepare('SELECT * FROM episodes WHERE id=?').get(sb.episode_id);
  const characters = plainAll(db.prepare(
    `SELECT c.* FROM characters c JOIN storyboard_characters sc ON sc.character_id=c.id
     WHERE sc.storyboard_id=?`
  ).all(storyboardId));
  const scene = sb.scene_id ? plain(db.prepare('SELECT * FROM scenes WHERE id=?').get(sb.scene_id)) : null;

  let promptText = sb.video_prompt;
  if (withPrompt && !promptText) {
    const { content } = await ai.chat({
      messages: [
        { role: 'system', content: P.VIDEO_PROMPT_SYSTEM },
        { role: 'user', content: P.videoPromptUser({ sb, characters, scene }) },
      ],
      temperature: 0.6, maxTokens: 3000,
    });
    promptText = content.trim();
    db.prepare('UPDATE storyboards SET video_prompt=?, status=?, updated_at=? WHERE id=?')
      .run(promptText, 'prompted', now(), storyboardId);
  }
  if (!promptText) return bad(res, '缺少视频提示词');

  // 首帧图作为图生视频输入
  const firstFrame = sb.first_frame_image || sb.composed_image || null;

  const created = await ai.video({
    prompt: promptText,
    image: firstFrame || undefined,
    duration: Math.round(sb.duration_sec || 10),
  });

  const info = db.prepare(
    `INSERT INTO gen_tasks (task_type, model, prompt, upstream_id, result_url, status,
                            drama_id, episode_id, storyboard_id, target_type, target_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'video', created.model, promptText, created.taskId || null, created.url || null,
    created.status, episode?.drama_id || null, sb.episode_id, storyboardId,
    'storyboard', storyboardId, now()
  );

  if (created.url) {
    db.prepare('UPDATE storyboards SET video_url=?, status=?, updated_at=? WHERE id=?')
      .run(created.url, 'done', now(), storyboardId);
  } else {
    db.prepare('UPDATE storyboards SET status=?, updated_at=? WHERE id=?').run('videoing', now(), storyboardId);
  }

  ok(res, {
    taskId: info.lastInsertRowid,
    upstreamId: created.taskId,
    status: created.status,
    videoUrl: created.url,
    prompt: promptText,
  });
}));

/* ================= 6. 任务轮询 ================= */
r.get('/task/:id', guard(async (req, res) => {
  const task = db.prepare('SELECT * FROM gen_tasks WHERE id=?').get(Number(req.params.id));
  if (!task) return bad(res, '任务不存在', 404);
  if (task.status === 'completed' || task.status === 'failed') return ok(res, plain(task));

  const out = await ai.videoStatus(task.upstream_id);
  if (out.status === 'completed' && out.url) {
    db.prepare('UPDATE gen_tasks SET status=?, result_url=?, completed_at=? WHERE id=?')
      .run('completed', out.url, now(), task.id);
    if (task.storyboard_id) {
      db.prepare('UPDATE storyboards SET video_url=?, status=?, updated_at=? WHERE id=?')
        .run(out.url, 'done', now(), task.storyboard_id);
    }
  } else if (out.status === 'failed') {
    db.prepare('UPDATE gen_tasks SET status=?, error_msg=?, completed_at=? WHERE id=?')
      .run('failed', '上游返回失败：' + out.rawStatus, now(), task.id);
  }
  ok(res, plain(db.prepare('SELECT * FROM gen_tasks WHERE id=?').get(task.id)));
}));

/** 按剧本的场景头切块：## S01 | ... 这种行是边界 */
/** 按剧本的场景头切块：## S01 | ... 这种行是边界 */
function splitScenes(script) {
  const text = String(script || '');
  const marks = [...text.matchAll(/^##\s*S\d+/gm)].map((m) => m.index);
  if (marks.length <= 1) return splitLong(text);
  const blocks = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i];
    const to = i + 1 < marks.length ? marks[i + 1] : text.length;
    const seg = text.slice(from, to).trim();
    if (seg.length > 40) blocks.push(...splitLong(seg));
  }
  return blocks.length ? blocks : splitLong(text);
}

/**
 * 单块过长时再切。
 * 原因：上游网关对单次 chat 请求约 60 秒硬掐断，块越大越容易 502。
 * 切分点优先落在对白行之间，保证语义完整。
 */
function splitLong(seg, limit = 650) {
  const s = String(seg || '').trim();
  if (s.length <= limit) return [s];

  const headMatch = s.match(/^##\s*S\d+[^\n]*/);
  const head = headMatch ? headMatch[0] : '';
  const body = head ? s.slice(head.length).trim() : s;

  const lines = body.split(/\n+/).filter((l) => l.trim());
  const out = [];
  let cur = [];
  let curLen = 0;

  for (const line of lines) {
    // 每段带上场景头，模型才知道自己在哪个场景里
    const prefixLen = head ? head.length + 1 : 0;
    if (curLen + line.length + prefixLen > limit && cur.length) {
      out.push((head ? head + '\n' : '') + cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length) out.push((head ? head + '\n' : '') + cur.join('\n'));
  return out.filter((x) => x.trim().length > 30);
}

export default r;
