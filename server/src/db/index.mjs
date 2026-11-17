/**
 * 数据库层 —— Supabase PostgreSQL（云端）
 * 环境变量：
 *   SUPABASE_URL=https://conc rete-bobcat-d1f8nunu00779b07.supabase.co
 *   SUPABASE_KEY=<JWT>
 */
import { config } from 'dotenv';
config({ path: '../.env' }); // 从 server/src/db/ 向上两级到 server/.env

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY are required');
  process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const now = () => new Date().toISOString();

/** 统一的行转换 */
export function plain(row) {
  return row ? { ...row } : row;
}
export function plainAll(rows) {
  return (rows || []).map((r) => ({ ...r }));
}

/** 安全解析 JSON 列 */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** 写设置 */
export async function setSetting(key, value) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: now() }, { onConflict: 'key' });
  if (error) throw error;
}

export async function getSetting(key, fallback = null) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return fallback;
  return data?.value ?? fallback;
}

/** 初始化表结构（需要在 Supabase Dashboard 中手动执行一次） */
export async function initSchema() {
  console.log('Supabase client initialized');
  console.log('URL:', SUPABASE_URL);
  // 注意：表结构需要在 Supabase Dashboard 中手动创建
  // 或执行 schema.sql 中的 SQL
}
