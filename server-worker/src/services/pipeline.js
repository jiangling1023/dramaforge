/**
 * 流水线状态机：create / advance / statusSnapshot / 卡死检测 / AI 错误映射。
 * 每次 advance 只做「一集的一步」原子单元；CAS 抢占走 db.raw 的 changes 判定。
 * core 成功为 { data }、校验失败为 { error }；单集 AI 失败内嵌在 data 里，必须单独判。
 */
import { now } from '../db.js';
import { scriptHash, parseScriptToEpisodes, countChars, ensureEpisodes } from './script-parser.js';
import { runScript, runExtract, runStoryboard, runImage } from './generation.js';
import { getAutoConfig, supportsVideoGen, dispatchStoryboardVideo } from './gpu-video.js';

const STEPS = ['script', 'extract', 'storyboard', 'image'];
const DEFAULT_STEPS = ['script', 'extract', 'storyboard'];
const FINAL = ['done', 'failed', 'skipped'];

const ok = (data) => ({ data });
const fail = (message, status = 400, code, data) => ({ error: { message, status, code, ...(data ? { data } : {}) } });

/** E-04/E-07：上游错误转人话，不静默吞错 */
function mapAiError(err) {
  const inner = err?.error && typeof err.error === 'object' ? err.error : null;
  const status = Number(err?.status || inner?.status || 0);
  const msg = String(inner?.message || err?.message || (typeof err === 'string' ? err : '') || '未知错误');
  if (status === 429 || /429|rate.?limit|too many requests|额度|余额|繁忙|队列满/i.test(msg)) {
    return `AI 服务繁忙或额度不足，请稍后重试：${msg.slice(0, 200)}`;
  }
  if (status >= 500 || /timeout|abort|超时|gateway|upstream|502|503|504|掐断/i.test(msg)) {
    return `AI 上游服务暂时不可用，请稍后重试：${msg.slice(0, 200)}`;
  }
  return msg.slice(0, 300);
}

/* ============ API-P01 create ============ */
export async function create(db, _ai, {
  dramaId, script, aspect = '9:16', autoImage = false, steps = DEFAULT_STEPS, useGpuVideo = false,
} = {}) {
  if (!dramaId) return fail('缺少 dramaId');
  if (typeof script !== 'string' || !script.trim()) return fail('缺少剧本内容');

  const scriptChars = countChars(script);
  if (scriptChars < 20) return fail('剧本内容过短，至少 20 字', 400, 'SCRIPT_TOO_SHORT');
  if (!Array.isArray(steps) || steps.some((s) => !STEPS.includes(s))) {
    return fail('steps 只能包含 script / extract / storyboard / image');
  }
  const chosen = steps.length ? steps : DEFAULT_STEPS;

  const hash = await scriptHash(script);
  const active = await db.select('pipeline_tasks', {
    drama_id: dramaId, script_hash: hash, status__in: ['queued', 'running'],
  }, { limit: 1 });
  if (active.length) return fail('已有进行中的生成任务', 409, 'DUPLICATE_TASK', { existingTaskId: active[0].id });

  const drama = await db.first('dramas', { id: dramaId, deleted_at__is: null });
  if (!drama) return fail('项目不存在', 404, 'NOT_FOUND');

  const parsed = parseScriptToEpisodes(script);
  if (!parsed.length) return fail('未识别到任何剧集', 400, 'NO_EPISODES_FOUND');
  const episodes = await ensureEpisodes(db, dramaId, parsed);

  const t = now();
  let task;
  try {
    task = await db.insertOne('pipeline_tasks', {
      drama_id: dramaId, script_hash: hash, script_chars: scriptChars,
      total_episodes: episodes.length, completed_episodes: 0, failed_episodes: 0,
      status: 'queued', aspect, auto_image: autoImage ? 1 : 0,
      // G-006：勾选分镜视频走 GPU。仅记录意图，实际是否走 GPU 在 image 步按 capabilities 判定
      use_gpu_video: useGpuVideo ? 1 : 0,
      created_at: t, updated_at: t,
    });
  } catch (e) {
    // 部分唯一索引 uq_pipeline_active 兜底并发双建：回读既有任务，不产生第二份
    const raced = await db.select('pipeline_tasks', {
      drama_id: dramaId, script_hash: hash, status__in: ['queued', 'running'],
    }, { limit: 1 });
    if (raced.length) return fail('已有进行中的生成任务', 409, 'DUPLICATE_TASK', { existingTaskId: raced[0].id });
    throw e;
  }

  const rows = [];
  for (const ep of episodes) {
    for (const step of chosen) {
      rows.push({
        task_id: task.id, episode_id: ep.episodeId, episode_number: ep.episodeNumber,
        step, status: step === 'image' && !autoImage ? 'skipped' : 'pending',
        attempts: 0, updated_at: t,
      });
    }
  }
  await db.insert('pipeline_steps', rows);

  return ok({
    taskId: task.id, status: 'queued', dramaId, scriptChars,
    totalEpisodes: episodes.length, totalSteps: rows.length, episodes,
  });
}

/* ============ 卡死检测（P02 惰性 / P03 每轮） ============ */
async function detectStale(db, t = now()) {
  const stepBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const taskBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await db.raw(
    `UPDATE pipeline_steps SET status='failed', error_msg='步骤执行超时（TASK_TIMEOUT）', finished_at=?, updated_at=? WHERE status='running' AND started_at < ?`,
    [t, t, stepBefore]
  );
  await db.raw(
    `UPDATE pipeline_tasks SET status='failed', error_summary='任务执行超时（TASK_TIMEOUT）', updated_at=?, completed_at=? WHERE status='running' AND updated_at < ?`,
    [t, t, taskBefore]
  );
}

/* ============ API-P02 statusSnapshot ============ */
export async function statusSnapshot(db, taskId) {
  await detectStale(db);
  const task = await db.first('pipeline_tasks', { id: Number(taskId) });
  if (!task) return fail('任务不存在', 404, 'NOT_FOUND');

  const steps = await db.select('pipeline_steps', { task_id: task.id }, { order: 'id.asc' });
  const grouped = new Map();
  for (const s of steps) {
    if (!grouped.has(s.episode_id)) {
      grouped.set(s.episode_id, { episodeId: s.episode_id, episodeNumber: s.episode_number, steps: [] });
    }
    grouped.get(s.episode_id).steps.push(s);
  }

  const episodeStates = [];
  for (const group of grouped.values()) {
    const statuses = group.steps.map((s) => s.status);
    let status = 'pending';
    if (statuses.includes('running')) status = 'running';
    else if (statuses.every((s) => s === 'done' || s === 'skipped')) status = 'done';
    else if (statuses.includes('failed')) status = 'failed';

    const [ep, storyboardCount] = await Promise.all([
      db.first('episodes', { id: group.episodeId }),
      db.count('storyboards', { episode_id: group.episodeId }),
    ]);
    episodeStates.push({
      episodeId: group.episodeId,
      episodeNumber: group.episodeNumber,
      status,
      storyboardCount,
      durationSec: ep?.duration_sec || 0,
      steps: group.steps.map((s) => ({ step: s.step, status: s.status, errorMsg: s.error_msg || null })),
    });
  }

  return ok({
    taskId: task.id, dramaId: task.drama_id, status: task.status,
    percent: task.percent, currentEpisode: task.current_episode ?? null,
    currentStep: task.current_step ?? null,
    completedEpisodes: task.completed_episodes, totalEpisodes: task.total_episodes,
    failedEpisodes: task.failed_episodes, aspect: task.aspect || '9:16',
    autoImage: !!task.auto_image, useGpuVideo: !!task.use_gpu_video,
    errorSummary: task.error_summary || null,
    episodeStates, updatedAt: task.updated_at,
  });
}

/* ============ 调 generation core + 解析内嵌失败 ============ */
function coreOutcome(res, toData, toError) {
  if (res?.error) return { ok: false, message: mapAiError(res.error) };
  const data = res?.data || {};
  const err = toError ? toError(data) : null;
  if (err) return { ok: false, message: mapAiError(err) };
  return { ok: true, data: toData(data) };
}

function entryOf(data, episodeId) {
  return (data.results || []).find((r) => Number(r.episodeId) === Number(episodeId));
}

function stepSummary(step, data, episodeId) {
  if (step === 'script') return { chars: entryOf(data, episodeId)?.chars || 0 };
  if (step === 'storyboard') {
    const e = entryOf(data, episodeId) || {};
    return { count: e.count || 0, blocks: e.blocks || 0, ...(e.warnings ? { warnings: e.warnings } : {}) };
  }
  return {
    characters: data.characters || 0, scenes: data.scenes || 0,
    props: data.props || 0, episodes: data.episodes || 0,
  };
}

async function invokeCore(db, ai, task, step) {
  const params = { dramaId: task.drama_id, scope: { episodeIds: [step.episode_id] } };

  if (step.step === 'image') {
    // G-006：勾选「分镜视频走 GPU」时，优先对首张缺视频的分镜走 GPU 视频生成
    if (task.use_gpu_video) {
      const cfg = await getAutoConfig(db);
      // 能力检测：无配置或不支持 video_gen → 回退 AI 直出（E-G12），不阻断流水线
      if (cfg && supportsVideoGen(cfg)) {
        const videoTargets = await db.select('storyboards', { episode_id: step.episode_id }, { order: 'id.asc' });
        const vt = videoTargets.find((sb) => !sb.video_url);
        if (vt) {
          const dispatched = await dispatchStoryboardVideo(db, {
            storyboardId: vt.id,
            episodeId: step.episode_id,
            dramaId: task.drama_id,
            imagePrompt: vt.image_prompt || '',
            videoPrompt: vt.video_prompt || '',
            origin: '', // webhook 地址优先取 gpu_configs.webhook_url
          });
          if (dispatched.error) return { ok: false, message: mapAiError(dispatched.error) };
          // 任务已分发：本步标记 done，video_url 由 Webhook 回调异步回写
          return {
            ok: true,
            data: {
              gpuDispatched: true,
              storyboardId: vt.id,
              gpuTaskId: dispatched.data.taskId,
              genTaskId: dispatched.data.genTaskId,
              note: '已分发到 GPU，视频地址将在回调后写入',
            },
          };
        }
        // 本集分镜都有视频了：当作完成
        return { ok: true, data: { count: 0, gpuDispatched: true } };
      }
      // 配置不支持 video_gen：静默回退到下面的 AI 首帧图直出
    }

    // 默认：image core 面向单个资产，每次推进只处理本集首张缺首帧的分镜，保持原子步在 60s 窗口内
    const sbs = await db.select('storyboards', { episode_id: step.episode_id }, { order: 'id.asc' });
    const target = sbs.find((sb) => !sb.first_frame_image);
    if (!target) return { ok: true, data: { count: 0 } };
    const res = await runImage(db, ai, { targetType: 'storyboard', targetId: target.id });
    return coreOutcome(res, (d) => ({ imageUrl: d.imageUrl, storyboardId: target.id }));
  }

  const runner = { script: runScript, extract: runExtract, storyboard: runStoryboard }[step.step];
  if (!runner) return { ok: true, data: {} };
  const res = await runner(db, ai, params);

  return coreOutcome(
    res,
    (d) => stepSummary(step.step, d, step.episode_id),
    (d) => {
      // 关键：单集 AI 失败是 HTTP 200 内嵌的 ok:false / errors，不是 res.error
      if (step.step === 'extract') {
        const prefix = `第${step.episode_number}集:`;
        const e = (d.errors || []).find((x) => String(x).startsWith(prefix));
        return e ? e.slice(prefix.length).trim() : null;
      }
      const item = entryOf(d, step.episode_id);
      return item && item.ok === false ? item.error : null;
    }
  );
}

/* ============ 重算任务统计 ============ */
async function recompute(db, taskId, justStep) {
  const [task, steps] = await Promise.all([
    db.first('pipeline_tasks', { id: taskId }),
    db.select('pipeline_steps', { task_id: taskId }, { order: 'id.asc' }),
  ]);
  if (!task) return;

  const grouped = new Map();
  for (const s of steps) {
    if (!grouped.has(s.episode_id)) grouped.set(s.episode_id, []);
    grouped.get(s.episode_id).push(s);
  }
  let completed = 0;
  let failed = 0;
  const failedParts = [];
  for (const list of grouped.values()) {
    if (list.every((s) => FINAL.includes(s.status))) completed++;
    const badSteps = list.filter((s) => s.status === 'failed');
    if (badSteps.length) {
      failed++;
      failedParts.push(`第${list[0].episode_number}集 ${badSteps.map((s) => s.step).join('、')}`);
    }
  }

  const next = steps.find((s) => s.status === 'pending');
  const t = now();
  const patch = {
    completed_episodes: completed, failed_episodes: failed,
    current_episode: next ? next.episode_number : (justStep?.episode_number ?? task.current_episode ?? null),
    current_step: next ? next.step : (justStep?.step ?? task.current_step ?? null),
    percent: task.total_episodes ? Math.round((completed / task.total_episodes) * 100) : 0,
    updated_at: t,
  };
  if (steps.every((s) => FINAL.includes(s.status))) {
    patch.status = 'completed';
    patch.completed_at = t;
    if (failedParts.length) patch.error_summary = `${failed} 集失败：${failedParts.join('；')}`;
  }
  await db.update('pipeline_tasks', { id: taskId }, patch);
}

/* ============ API-P03 advance ============ */
export async function advance(db, ai, taskId) {
  const id = Number(taskId);
  const t = now();
  await detectStale(db, t);

  let task = await db.first('pipeline_tasks', { id });
  if (!task) return fail('任务不存在', 404, 'NOT_FOUND');
  // 非运行中幂等返回当前状态，不推进
  if (task.status !== 'queued' && task.status !== 'running') return statusSnapshot(db, id);

  if (task.status === 'queued') {
    await db.raw('UPDATE pipeline_tasks SET status=\'running\', updated_at=? WHERE id=? AND status=\'queued\'', [t, id]);
    task = await db.first('pipeline_tasks', { id });
  }

  const step = await db.first('pipeline_steps', { task_id: id, status: 'pending' }, { order: 'id.asc' });
  if (!step) {
    await recompute(db, id, null);
    return statusSnapshot(db, id);
  }

  const claimed = await db.raw(
    'UPDATE pipeline_steps SET status=\'running\', started_at=?, attempts=attempts+1, updated_at=? WHERE id=? AND status=\'pending\'',
    [t, t, step.id]
  );
  if (!claimed) return fail('步骤被并发抢占，请重试', 409, 'CONFLICT');

  let result;
  try {
    result = await invokeCore(db, ai, task, step);
  } catch (e) {
    result = { ok: false, message: mapAiError(e) };
  }

  if (result.ok) {
    await db.raw(
      'UPDATE pipeline_steps SET status=\'done\', result_json=?, finished_at=?, updated_at=? WHERE id=? AND status=\'running\'',
      [JSON.stringify(result.data || {}), t, t, step.id]
    );
  } else {
    await db.raw(
      'UPDATE pipeline_steps SET status=\'failed\', error_msg=?, finished_at=?, updated_at=? WHERE id=? AND status=\'running\'',
      [String(result.message).slice(0, 500), t, t, step.id]
    );
    // E-02：本集后续未执行步置 skipped，下一集继续
    await db.raw(
      'UPDATE pipeline_steps SET status=\'skipped\', error_msg=\'前序步骤失败\', finished_at=?, updated_at=? WHERE task_id=? AND episode_id=? AND id>? AND status=\'pending\'',
      [t, t, id, step.episode_id, step.id]
    );
  }

  await recompute(db, id, step);
  return statusSnapshot(db, id);
}
