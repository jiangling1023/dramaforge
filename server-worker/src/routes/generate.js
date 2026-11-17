/**
 * 生成路由（Workers 版）
 * 所有入口都支持 scope：只处理用户选中的集 / 镜号，绝不默认全集扫射。
 *   scope = { episodeIds?: number[], storyboardNumbers?: number[], onlyMissing?: boolean }
 */
import { Hono } from 'hono';
import { now, plain, plainAll } from '../db.js';
import * as P from '../services/prompts.js';

const ok = (c, data) => c.json({ success: true, data });
const bad = (c, message, code = 400) => c.json({ success: false, error: { message } }, code);

/** 小写去空白，用于「同名视为同一实体」的比较（替代 SQL 里的 lower(trim())） */
const norm = (s) => String(s || '').trim().toLowerCase();

export function generateRoutes(db, ai) {
  const r = new Hono();

  /* ============ 解析目标集：支持选集，不传则只处理当前集 ============ */
  async function resolveEpisodes(dramaId, scope = {}, fallbackEpisodeId) {
    if (Array.isArray(scope.episodeIds) && scope.episodeIds.length) {
      return plainAll(await db.select(
        'episodes',
        { drama_id: dramaId, deleted_at__is: null, id__in: scope.episodeIds },
        { order: 'episode_number.asc' }
      ));
    }
    if (fallbackEpisodeId) {
      const row = await db.first('episodes', { id: fallbackEpisodeId, deleted_at__is: null });
      return row ? [plain(row)] : [];
    }
    return [];
  }

  /* ================= 1. 剧本影视化改写 ================= */
  r.post('/script', async (c) => {
    const { dramaId, episodeId, scope } = await c.req.json().catch(() => ({}));
    if (!dramaId) return bad(c, '缺少 dramaId');

    const drama = await db.first('dramas', { id: dramaId, deleted_at__is: null });
    if (!drama) return bad(c, '项目不存在', 404);

    const eps = await resolveEpisodes(dramaId, scope, episodeId);
    if (!eps.length) return bad(c, '没有要处理的剧集；请传 episodeId 或 scope.episodeIds 明确选集');

    const results = [];
    for (const ep of eps) {
      // 长文本一次一节，避免推理模型把上下文吃掉
      let content = '';
      try {
        const out = await ai.chat({
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
        content = out.content || '';
      } catch (e) {
        results.push({ episodeId: ep.id, episodeNumber: ep.episode_number, ok: false, error: e.message });
        continue;
      }

      if (!content || content.trim().length < 20) {
        results.push({ episodeId: ep.id, ok: false, error: '模型返回内容过短，可能被 max_tokens 截断' });
        continue;
      }
      await db.update('episodes', { id: ep.id }, {
        script_content: content.trim(), status: 'scripted', updated_at: now(),
      });
      results.push({ episodeId: ep.id, episodeNumber: ep.episode_number, ok: true, chars: content.length });
    }
    return ok(c, { results });
  });

  /* ================= 2. 资产提取（角色/场景/道具） ================= */
  r.post('/extract', async (c) => {
    const { dramaId, episodeId, scope } = await c.req.json().catch(() => ({}));
    if (!dramaId) return bad(c, '缺少 dramaId');

    const eps = await resolveEpisodes(dramaId, scope, episodeId);
    if (!eps.length) return bad(c, '没有要处理的剧集');

    const summary = { characters: 0, scenes: 0, props: 0, episodes: 0 };

    // 现存的资产先拉出来，在内存里做去重（PostgREST 不支持 lower(trim()) 比较）
    const existingChars = plainAll(await db.select('characters', { drama_id: dramaId, deleted_at__is: null }));
    const existingScenes = plainAll(await db.select('scenes', { drama_id: dramaId, deleted_at__is: null }));
    const existingProps = plainAll(await db.select('props', { drama_id: dramaId, deleted_at__is: null }));

    const charByKey = new Map(existingChars.map((x) => [norm(x.name), x]));
    const sceneByKey = new Map(existingScenes.map((x) => [`${norm(x.location)}|${x.time_of_day}`, x]));
    const propByKey = new Map(existingProps.map((x) => [norm(x.name), x]));

    for (const ep of eps) {
      const script = ep.script_content || ep.content;
      if (!script) continue;

      let data;
      try {
        const out = await ai.chat({
          messages: [
            { role: 'system', content: P.EXTRACT_SYSTEM },
            { role: 'user', content: P.extractUserPrompt(script) },
          ],
          temperature: 0.5,
          maxTokens: 8000,
          timeout: 300_000,   // 角色外观要写 300+ 字，输出较长
        });
        data = P.extractJson(out.content);
      } catch (e) {
        summary.errors = summary.errors || [];
        summary.errors.push(`第${ep.episode_number}集: ${e.message}`);
        continue;
      }

      const t = now();

      // --- 角色：按名字去重（同名视为同一人，跨集复用同一条记录） ---
      for (const c of data.characters || []) {
        if (!c.name) continue;
        const key = norm(c.name);
        let cur = charByKey.get(key);
        if (cur) {
          // 只在原值为空时补，避免覆盖人工填写的锚点
          const patch = { updated_at: t };
          if (!cur.role && c.role) patch.role = c.role;
          if (!cur.description && c.description) patch.description = c.description;
          if (!cur.appearance && c.appearance) patch.appearance = c.appearance;
          if (!cur.styling && c.styling) patch.styling = c.styling;
          if (Object.keys(patch).length > 1) {
            await db.update('characters', { id: cur.id }, patch);
            charByKey.set(key, { ...cur, ...patch });
          }
        } else {
          cur = await db.insertOne('characters', {
            drama_id: dramaId, name: c.name, role: c.role || null,
            description: c.description || null, appearance: c.appearance || null,
            styling: c.styling || null, sort_order: summary.characters,
            created_at: t, updated_at: t,
          });
          charByKey.set(key, cur);
          summary.characters++;
        }
        await db.upsert('episode_characters',
          { episode_id: ep.id, character_id: cur.id }, 'episode_id,character_id');
      }

      // --- 场景：地点 + 时间段 精确匹配 ---
      for (const s of data.scenes || []) {
        if (!s.location) continue;
        const tod = s.time_of_day || '日';
        const key = `${norm(s.location)}|${tod}`;
        let cur = sceneByKey.get(key);
        if (cur) {
          const patch = { updated_at: t };
          if (!cur.prompt && s.prompt) patch.prompt = s.prompt;
          if (!cur.lighting && s.lighting) patch.lighting = s.lighting;
          if (Object.keys(patch).length > 1) {
            await db.update('scenes', { id: cur.id }, patch);
            sceneByKey.set(key, { ...cur, ...patch });
          }
        } else {
          cur = await db.insertOne('scenes', {
            drama_id: dramaId, location: s.location, time_of_day: tod,
            prompt: s.prompt || null, lighting: s.lighting || null,
            status: 'pending', created_at: t, updated_at: t,
          });
          sceneByKey.set(key, cur);
          summary.scenes++;
        }
        await db.upsert('episode_scenes', { episode_id: ep.id, scene_id: cur.id }, 'episode_id,scene_id');
      }

      // --- 道具：上限 3 个 ---
      for (const p of (data.props || []).slice(0, 3)) {
        if (!p.name) continue;
        const key = norm(p.name);
        let cur = propByKey.get(key);
        if (!cur) {
          cur = await db.insertOne('props', {
            drama_id: dramaId, name: p.name, type: p.type || null,
            description: p.description || null, created_at: t, updated_at: t,
          });
          propByKey.set(key, cur);
          summary.props++;
        }
        await db.upsert('episode_props', { episode_id: ep.id, prop_id: cur.id }, 'episode_id,prop_id');
      }
      summary.episodes++;
    }
    return ok(c, summary);
  });

  /* ================= 3. 分镜拆解 ================= */
  r.post('/storyboard', async (c) => {
    const { dramaId, episodeId, scope } = await c.req.json().catch(() => ({}));
    if (!dramaId) return bad(c, '缺少 dramaId');

    const eps = await resolveEpisodes(dramaId, scope, episodeId);
    if (!eps.length) return bad(c, '没有要处理的剧集');

    const results = [];

    for (const ep of eps) {
      const script = ep.script_content || ep.content;
      if (!script) { results.push({ episodeId: ep.id, ok: false, error: '本集还没有剧本' }); continue; }

      // 本集关联的角色/场景/道具（桥表查询，替代原来的 JOIN）
      const [ecLinks, esLinks, epLinks] = await Promise.all([
        db.select('episode_characters', { episode_id: ep.id }, { columns: 'character_id' }),
        db.select('episode_scenes', { episode_id: ep.id }, { columns: 'scene_id' }),
        db.select('episode_props', { episode_id: ep.id }, { columns: 'prop_id' }),
      ]);

      const [characters, scenes, props] = await Promise.all([
        ecLinks.length
          ? db.select('characters', { id__in: ecLinks.map((x) => x.character_id), deleted_at__is: null })
          : [],
        esLinks.length
          ? db.select('scenes', { id__in: esLinks.map((x) => x.scene_id), deleted_at__is: null })
          : [],
        epLinks.length
          ? db.select('props', { id__in: epLinks.map((x) => x.prop_id), deleted_at__is: null })
          : [],
      ]);

      // 上游网关在约 60-75 秒会掐断长请求，整集一次出 JSON 必然 502。
      // 按场景切块、每块单独请求，既规避超时，又天然满足「分镜不跨场景」。
      const sceneBlocks = splitScenes(script);
      const arr = [];
      const failures = [];

      // 并发跑各块：串行总时长会超网关窗口，并发把整体压到 60 秒内。
      const tasks = sceneBlocks.map((block, bi) => (async () => {
        const out = await ai.chat({
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
        const parsed = P.extractJson(out.content);
        return Array.isArray(parsed) ? parsed : parsed.storyboards || [];
      })().then((part) => ({ ok: true, part }))
        .catch((e) => ({ ok: false, error: `块${bi + 1}: ${e.message}` })));

      const settled = await Promise.all(tasks);
      for (const s of settled) {
        if (s.ok) arr.push(...s.part);
        else failures.push(s.error);
      }

      if (!arr.length) {
        results.push({ episodeId: ep.id, ok: false, error: '全部分块失败：' + failures.join(' | ') });
        continue;
      }

      // 名字 → id 映射，用于写桥表
      const charMap = new Map(characters.map((x) => [x.name, x.id]));
      const propMap = new Map(props.map((x) => [x.name, x.id]));
      const sceneMap = new Map(scenes.map((s) => [`${s.location}|${s.time_of_day}`, s.id]));

      // 整集重拆：先清空旧分镜（含桥表），保证重跑幂等
      const olds = await db.select('storyboards', { episode_id: ep.id }, { columns: 'id' });
      if (olds.length) {
        const oldIds = olds.map((o) => o.id);
        await db.remove('storyboard_characters', { storyboard_id__in: oldIds });
        await db.remove('storyboard_props', { storyboard_id__in: oldIds });
        await db.remove('storyboards', { episode_id: ep.id });
      }

      const t = now();
      let total = 0;
      const rows = arr.map((s, i) => {
        // 并发分块各自从 1 开始编号，必须按最终顺序重排，否则撞唯一索引
        const num = i + 1;
        const dur = Number(s.duration_sec) || 10;
        total += dur;
        return {
          episode_id: ep.id,
          scene_id: sceneMap.get(`${s.scene_location || ''}|${s.scene_time_of_day || '日'}`)
            || sceneMap.get(`${s.scene_location || ''}|日`) || null,
          storyboard_number: num,
          title: s.title || `S${String(num).padStart(2, '0')}`,
          location: s.scene_location || null,
          time_of_day: s.scene_time_of_day || null,
          shot_type: s.shot_type || '中景',
          angle: s.angle || '平视',
          movement: s.movement || '固定',
          result: s.result || null,
          atmosphere: s.atmosphere || null,
          description: s.description || null,
          duration_sec: dur,
          status: 'pending',
          created_at: t,
          updated_at: t,
        };
      });

      const inserted = await db.insert('storyboards', rows);

      // 桥表：按插入顺序对应回去（用 storyboard_number 对齐，避免依赖返回顺序）
      const idByNum = new Map(inserted.map((x) => [x.storyboard_number, x.id]));
      const charLinks = [];
      const propLinks = [];
      rows.forEach((row, i) => {
        const sbid = idByNum.get(row.storyboard_number);
        if (!sbid) return;
        for (const n of arr[i].character_names || []) {
          const cid = charMap.get(n);
          if (cid) charLinks.push({ storyboard_id: sbid, character_id: cid });
        }
        for (const n of arr[i].prop_names || []) {
          const pid = propMap.get(n);
          if (pid) propLinks.push({ storyboard_id: sbid, prop_id: pid });
        }
      });
      if (charLinks.length) {
        await db.upsert('storyboard_characters', charLinks, 'storyboard_id,character_id');
      }
      if (propLinks.length) {
        await db.upsert('storyboard_props', propLinks, 'storyboard_id,prop_id');
      }

      // 回写本集时长
      await db.update('episodes', { id: ep.id }, {
        duration_sec: Math.round(total), status: 'storied', updated_at: now(),
      });

      results.push({
        episodeId: ep.id, episodeNumber: ep.episode_number, ok: true,
        count: arr.length, blocks: sceneBlocks.length,
        ...(failures.length ? { warnings: failures } : {}),
      });
    }
    return ok(c, { results });
  });

  /* ================= 4. 图片提示词 + 出图 ================= */
  r.post('/image', async (c) => {
    const { targetType, targetId, size, withPrompt = true } = await c.req.json().catch(() => ({}));
    const table = { character: 'characters', scene: 'scenes', prop: 'props' }[targetType];
    if (!table) return bad(c, 'targetType 只能是 character / scene / prop');

    const row = await db.first(table, { id: targetId });
    if (!row) return bad(c, '目标资产不存在', 404);

    // 1) 没提示词先生成
    let promptText = row.final_prompt;
    if (withPrompt && !promptText) {
      const sys = P.IMAGE_PROMPT_SYSTEM;
      const usr =
        targetType === 'character' ? P.characterImagePrompt(row)
          : targetType === 'scene' ? P.sceneImagePrompt(row)
            : P.propImagePrompt(row);
      const out = await ai.chat({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        temperature: 0.7, maxTokens: 1200,
      });
      promptText = out.content.trim().split('\n')[0].replace(/^["「]|["」]$/g, '');
      await db.update(table, { id: targetId }, { final_prompt: promptText, updated_at: now() });
    }
    if (!promptText) return bad(c, '缺少提示词且生成失败');

    // 2) 出图
    const defaultSize = targetType === 'prop' ? '1024x1024' : '1920x1080';
    const out = await ai.image({
      prompt: promptText,
      size: size || defaultSize,
      negativePrompt: targetType === 'scene' ? '人物, 人脸, 人影, 剪影' : undefined,
    });

    await db.update(table, { id: targetId }, { image_url: out.url, updated_at: now() });
    if (targetType === 'scene') {
      await db.update('scenes', { id: targetId }, { status: 'done' });
    }
    return ok(c, { prompt: promptText, imageUrl: out.url, model: out.model });
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
