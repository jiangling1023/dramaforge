/**
 * 数据层 —— Cloudflare D1（SQLite，Workers/Pages 内置）
 *
 * 为什么用 D1 而不是 Supabase：
 *   1. Supabase 项目的域名 concrete-bobcat-* 已不存在（1016），凭证无效
 *   2. D1 就在 Cloudflare 账号里，免费额度 5GB，和 Pages 前端零距离
 *   3. D1 就是 SQLite —— 原 schema.sql 直接复用，SQL 语义无需绕行
 *
 * 对外保持 select / first / insert / insertOne / update / upsert / remove / count
 * filters 用 col__op 语法：{ id: 5 } / { id__in: [1,2] } / { deleted_at__is: null }
 */

export function createDb(env) {
  const DB = env.DB;

  /** filters -> WHERE 子句 + 参数 */
  function buildWhere(filters) {
    const conds = [];
    const params = [];
    for (const [rawKey, value] of Object.entries(filters || {})) {
      if (value === undefined) continue;
      const [col, op = 'eq'] = rawKey.split('__');
      switch (op) {
        case 'eq': conds.push(`${col} = ?`); params.push(value); break;
        case 'neq': conds.push(`${col} != ?`); params.push(value); break;
        case 'gt': conds.push(`${col} > ?`); params.push(value); break;
        case 'gte': conds.push(`${col} >= ?`); params.push(value); break;
        case 'lt': conds.push(`${col} < ?`); params.push(value); break;
        case 'lte': conds.push(`${col} <= ?`); params.push(value); break;
        case 'in': {
          const arr = Array.isArray(value) ? value : [value];
          if (!arr.length) { conds.push('1 = 0'); break; }
          conds.push(`${col} IN (${arr.map(() => '?').join(',')})`);
          params.push(...arr);
          break;
        }
        case 'is':
          conds.push(`${col} IS ${value === null ? 'NULL' : 'NOT NULL'}`);
          break;
        case 'like': conds.push(`${col} LIKE ?`); params.push(value); break;
        case 'ilike': conds.push(`LOWER(${col}) LIKE LOWER(?)`); params.push(value); break;
        default: conds.push(`${col} = ?`); params.push(value); break;
      }
    }
    return { where: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params };
  }

  /** 'updated_at.desc,id.asc' -> ' ORDER BY updated_at DESC, id ASC' */
  function buildOrder(order) {
    if (!order) return '';
    const parts = String(order).split(',').map((p) => {
      const [col, dir] = p.trim().split('.');
      return `${col} ${(dir || 'asc').toUpperCase()}`;
    });
    return ' ORDER BY ' + parts.join(', ');
  }

  function buildColumns(columns) {
    return columns || '*';
  }

  return {
    /** 查多行 */
    async select(table, filters = {}, opt = {}) {
      const { where, params } = buildWhere(filters);
      let sql = `SELECT ${buildColumns(opt.columns)} FROM ${table}${where}${buildOrder(opt.order)}`;
      if (opt.limit) sql += ` LIMIT ${Number(opt.limit)}`;
      if (opt.offset) sql += ` OFFSET ${Number(opt.offset)}`;
      const res = await DB.prepare(sql).bind(...params).all();
      return res.results || [];
    },

    /** 查单行，无则 null */
    async first(table, filters = {}, opt = {}) {
      const rows = await this.select(table, filters, { ...opt, limit: 1 });
      return rows[0] || null;
    },

    /** 插入（单行或批量），返回插入行 */
    async insert(table, rows) {
      const arr = Array.isArray(rows) ? rows : [rows];
      const out = [];
      for (const row of arr) {
        const rec = await this.insertOne(table, row);
        if (rec) out.push(rec);
      }
      return out;
    },

    /** 插入单行并返回该行 */
    async insertOne(table, row) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(',');
      const values = cols.map((c) => row[c]);
      const res = await DB.prepare(
        `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`
      ).bind(...values).run();
      return this.first(table, { id: res.meta.last_row_id });
    },

    /** 更新，返回更新后的行（可能多行） */
    async update(table, filters, patch) {
      const cols = Object.keys(patch);
      if (!cols.length) return [];
      const setSql = cols.map((c) => `"${c}" = ?`).join(',');
      const { where, params } = buildWhere(filters);
      await DB.prepare(`UPDATE ${table} SET ${setSql}${where}`)
        .bind(...cols.map((c) => patch[c]), ...params).run();
      return this.select(table, filters);
    },

    /** upsert（按 onConflict 列合并），返回受影响行数 */
    async upsert(table, rows, onConflict) {
      const arr = Array.isArray(rows) ? rows : [rows];
      let affected = 0;
      for (const row of arr) {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(',');
        const conflictCols = onConflict
          ? onConflict.split(',').map((c) => c.trim()).filter(Boolean)
          : [];
        const excl = conflictCols.length
          ? cols.filter((c) => !conflictCols.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(',')
          : cols.map((c) => `"${c}" = excluded."${c}"`).join(',');
        const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`
          + (conflictCols.length ? ` ON CONFLICT (${conflictCols.map((c) => `"${c}"`).join(',')}) DO UPDATE SET ${excl}` : '');
        const res = await DB.prepare(sql).bind(...cols.map((c) => row[c])).run();
        affected += Number(res.meta.changes || 0);
      }
      return affected;
    },

    /** 删除，返回删除的行 */
    async remove(table, filters) {
      const before = await this.select(table, filters);
      const { where, params } = buildWhere(filters);
      await DB.prepare(`DELETE FROM ${table}${where}`).bind(...params).run();
      return before;
    },

    /** 计数 */
    async count(table, filters = {}) {
      const { where, params } = buildWhere(filters);
      const res = await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).bind(...params).first();
      return Number(res?.n || 0);
    },
  };
}

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