/**
 * 轻量 PostgREST 客户端（零依赖，只用 fetch）
 *
 * 为什么不引 @supabase/supabase-js：
 *   Workers 免费版 CPU 预算只有 10ms/请求，SDK 的初始化与封装开销偏大，
 *   这里只做「把查询翻译成 PostgREST 的 URL」这一件事，够用且更轻。
 *
 * filter 语法（默认 eq，特殊比较用 __ 后缀）：
 *   { id: 5 }                    -> id=eq.5
 *   { id__in: [1,2] }            -> id=in.(1,2)
 *   { deleted_at__is: null }     -> deleted_at=is.null
 *   { name__ilike: '%老陈%' }     -> name=ilike.*老陈*
 *   { id__neq / __gte / __lte / __lt / __gt: x }
 */

export function createDb(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1';
  const key = env.SUPABASE_KEY;

  if (!env.SUPABASE_URL || !key) throw new Error('缺少 SUPABASE_URL / SUPABASE_KEY');

  async function request(path, { method = 'GET', qs = {}, body, prefer } = {}) {
    const u = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(qs)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;

    const res = await fetch(u.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      const err = new Error(String(msg).slice(0, 500));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return { data, headers: res.headers };
  }

  /** 把 filter 对象翻译成 PostgREST 查询参数 */
  function applyFilters(qs, filters) {
    for (const [rawKey, value] of Object.entries(filters || {})) {
      if (value === undefined) continue;
      const [col, op = 'eq'] = rawKey.split('__');

      if (op === 'is') {
        qs[col] = 'is.' + (value === null ? 'null' : value);
      } else if (op === 'in') {
        qs[col] = 'in.(' + (Array.isArray(value) ? value.join(',') : value) + ')';
      } else if (op === 'ilike') {
        // PostgREST 用 * 代表 %，这里统一把 % 转成 *
        qs[col] = 'ilike.' + String(value).replace(/%/g, '*');
      } else {
        qs[col] = `${op}.${value}`;
      }
    }
    return qs;
  }

  return {
    /** 查多行 */
    async select(table, filters = {}, opt = {}) {
      const qs = applyFilters({ select: opt.columns || '*' }, filters);
      if (opt.order) qs.order = opt.order;
      if (opt.limit) qs.limit = opt.limit;
      if (opt.offset) qs.offset = opt.offset;
      const out = await request(table, { qs });
      return out.data || [];
    },

    /** 查单行，无则 null */
    async first(table, filters = {}, opt = {}) {
      const rows = await this.select(table, filters, { ...opt, limit: 1 });
      return rows[0] || null;
    },

    /** 插入，返回插入的行数组 */
    async insert(table, rows) {
      const payload = Array.isArray(rows) ? rows : [rows];
      const out = await request(table, {
        method: 'POST',
        body: payload,
        prefer: 'return=representation',
      });
      return out.data || [];
    },

    /** 插入并返回单行 */
    async insertOne(table, row) {
      const rows = await this.insert(table, row);
      return rows[0] || null;
    },

    /** 更新，返回更新后的行 */
    async update(table, filters, patch) {
      const qs = applyFilters({}, filters);
      const out = await request(table, {
        method: 'PATCH',
        qs,
        body: patch,
        prefer: 'return=representation',
      });
      return out.data || [];
    },

    /** upsert（按唯一约束合并） */
    async upsert(table, rows, onConflict) {
      const payload = Array.isArray(rows) ? rows : [rows];
      const qs = onConflict ? { on_conflict: onConflict } : {};
      const out = await request(table, {
        method: 'POST',
        qs,
        body: payload,
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return out.data || [];
    },

    /** 直接删除 */
    async remove(table, filters) {
      const qs = applyFilters({}, filters);
      const out = await request(table, { method: 'DELETE', qs, prefer: 'return=representation' });
      return out.data || [];
    },

    /** 计数（只取头部，不拉数据） */
    async count(table, filters = {}) {
      const qs = applyFilters({ select: 'id' }, filters);
      qs.limit = 1;
      const out = await request(table, {
        qs,
        prefer: 'count=exact',
      });
      const cr = out.headers.get('content-range') || '';   // 形如 0-0/25
      const total = cr.split('/').pop();
      const n = Number(total);
      return Number.isFinite(n) ? n : 0;
    },
  };
}

/** 统一的行拷贝（保持与原接口的 plain 行为一致） */
export function plain(row) {
  return row ? { ...row } : row;
}
export function plainAll(rows) {
  return (rows || []).map((r) => ({ ...r }));
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function now() {
  return new Date().toISOString();
}
