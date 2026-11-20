/**
 * 整部剧本 → 集切分 + 字数统计 + 幂等建 episodes（API-P01 create 用）。
 * 无集标记时整部作 1 集；已有 script_content 的集不覆盖改写稿。
 */
import { now } from '../db.js';

// 切集标记：`第N集` / `## 第N集` / `EP N`（大小写不敏感）
const EPISODE_RE = /^#{0,3}[ \t]*(?:第[ \t]*(\d+)[ \t]*集|EP[ \t]*(\d+))/gim;

/** 去空白后字数（与 /script 的 E-01 校验口径一致） */
export const countChars = (s) => String(s || '').replace(/\s+/g, '').length;

/** 剧本指纹：SHA-256 前 16 位（幂等键 E-03） */
export async function scriptHash(script) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(script || '')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export function parseScriptToEpisodes(script) {
  const text = String(script || '');
  const marks = [...text.matchAll(EPISODE_RE)]
    .map((m) => ({ index: m.index, number: Number(m[1] || m[2]) || 0 }));

  if (!marks.length) {
    const body = text.trim();
    return body ? [{ episodeNumber: 1, content: body, chars: countChars(body) }] : [];
  }

  // 同集号重复出现时合并正文，避免 pipeline_steps 唯一键冲突
  const byNumber = new Map();
  marks.forEach((m, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const content = text.slice(m.index, to).trim();
    const num = m.number || i + 1;
    const prev = byNumber.get(num);
    if (prev) prev.content += '\n' + content;
    else byNumber.set(num, { episodeNumber: num, content });
  });
  return [...byNumber.values()]
    .filter((e) => e.content.length)
    .map((e) => ({ ...e, chars: countChars(e.content) }));
}

export async function ensureEpisodes(db, dramaId, episodes) {
  const t = now();
  const out = [];
  for (const ep of episodes) {
    let row = await db.first('episodes', {
      drama_id: dramaId, episode_number: ep.episodeNumber, deleted_at__is: null,
    });
    if (row) {
      // 只补原文；改写稿是人工/上一轮成果，重复 create 不得覆盖（E-10 恢复）
      if (row.content !== ep.content) {
        await db.update('episodes', { id: row.id }, { content: ep.content, updated_at: t });
      }
    } else {
      row = await db.insertOne('episodes', {
        drama_id: dramaId, episode_number: ep.episodeNumber,
        title: `第 ${ep.episodeNumber} 集`, content: ep.content,
        status: 'draft', created_at: t, updated_at: t,
      });
    }
    out.push({ episodeId: row.id, episodeNumber: ep.episodeNumber });
  }
  return out;
}
