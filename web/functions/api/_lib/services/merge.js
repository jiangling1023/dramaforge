/**
 * 合成任务服务（API-M01~M04 共用逻辑）
 * 只认 (db, params)，不碰 Hono ctx；返回 { data } 或 { error:{ message, status, code } }。
 * merges 表零结构变更，DDL 列名保持 snake_case，仅在 toApi 出口转 camelCase。
 */
import { now, parseJson } from '../db.js';

const done = (data) => ({ data });
const fail = (message, status = 400, code) => ({ error: { message, status, code } });

// 终态不再接受任何推进；pending 不能直接跳到 completed（§4.3 状态机）
const NEXT = {
  pending: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

/** DDL 列名 → API 字段，唯一出口，避免各处重复转换 */
function toApi(row) {
  return {
    id: row.id,
    dramaId: row.drama_id,
    episodeId: row.episode_id,
    segments: parseJson(row.segments, []),
    status: row.status,
    mergedUrl: row.merged_url,
    duration: row.duration,
    provider: row.provider,
    model: row.model,
    errorMsg: row.error_msg,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** M01 响应只有三个字段 */
function toCreate(row) {
  return { mergeId: row.id, status: row.status, segments: parseJson(row.segments, []) };
}

/**
 * 提交整集合成任务。
 * 幂等只复用 pending/processing 记录：failed/completed 保留原记录并新建（E-05）。
 */
export async function create(db, { dramaId, episodeId, segments: raw } = {}) {
  if (!dramaId || !episodeId) return fail('缺少 dramaId 或 episodeId');

  const episode = await db.first('episodes', { id: Number(episodeId) });
  if (!episode) return fail('剧集不存在', 404);

  const segments = (Array.isArray(raw) ? raw : []).map(Number);
  if (!segments.length || segments.some((n) => !Number.isInteger(n) || n <= 0)) {
    return fail('该集没有可合成的分镜', 400, 'NO_STORYBOARDS');
  }

  // 逐段核对归属：不存在的 id 与跨集 id 一并按 E-12 拒绝
  const owned = await db.select('storyboards', { id__in: segments }, { columns: 'id,episode_id' });
  const owner = new Map(owned.map((s) => [Number(s.id), Number(s.episode_id)]));
  if (segments.some((sid) => owner.get(sid) !== Number(episodeId))) {
    return fail('分镜不属于该集', 400, 'NO_STORYBOARDS');
  }

  // segments 有序即身份：同集 + 同序同集合才命中幂等，避免重复提交堆积
  const key = JSON.stringify(segments);
  const active = await db.select('merges', {
    episode_id: Number(episodeId),
    status__in: ['pending', 'processing'],
  }, { order: 'created_at.desc,id.desc' });
  const hit = active.find((row) => JSON.stringify(parseJson(row.segments, [])) === key);
  if (hit) return done(toCreate(hit));

  const row = await db.insertOne('merges', {
    drama_id: Number(dramaId),
    episode_id: Number(episodeId),
    status: 'pending',
    segments: key,
    created_at: now(),
  });
  return done(toCreate(row));
}

export async function get(db, id) {
  const row = await db.first('merges', { id: Number(id) });
  if (!row) return fail('合成任务不存在', 404);
  return done(toApi(row));
}

/** 按集取最新一条供前端状态卡初始化，无任务返回 null */
export async function listByEpisode(db, episodeId) {
  const row = await db.first('merges', { episode_id: Number(episodeId) }, { order: 'created_at.desc,id.desc' });
  return done({ merge: row ? toApi(row) : null });
}

/** GPU 回调占位：仅推进状态，不做任何真实合成 */
export async function advance(db, id, body = {}) {
  const row = await db.first('merges', { id: Number(id) });
  if (!row) return fail('合成任务不存在', 404);

  const to = body.status;
  if (!NEXT[to]) return fail('status 只能是 processing / completed / failed');
  if (!NEXT[row.status].includes(to)) return fail(`不允许 ${row.status} → ${to}`, 409, 'CONFLICT');

  const patch = { status: to };
  if (to === 'completed' || to === 'failed') patch.completed_at = now();
  const fields = { mergedUrl: 'merged_url', duration: 'duration', errorMsg: 'error_msg', provider: 'provider', model: 'model' };
  for (const [api, col] of Object.entries(fields)) {
    if (body[api] !== undefined) patch[col] = body[api];
  }

  // CAS：带出态条件更新，changes=0 说明被并发回调抢占，按非法跃迁处理
  const cols = Object.keys(patch);
  const sql = `UPDATE merges SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`;
  const changes = await db.raw(sql, [...cols.map((c) => patch[c]), Number(id), row.status]);
  if (!changes) return fail('状态已被其他回调推进', 409, 'CONFLICT');

  return done(toApi(await db.first('merges', { id: Number(id) })));
}
