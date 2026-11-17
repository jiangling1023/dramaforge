/**
 * Pages Functions 入口 —— 承接 /api/* 的所有请求
 *
 * 为什么挂在 Pages 而不是独立 Worker：
 *   Pages Functions 与静态站点同域，前端 BASE='/api' 不需要任何改动，
 *   也不存在跨域预检；部署跟前端走同一条 wrangler pages deploy 流程。
 *
 * 路由：functions/api/[[path]].js 是 catch-all，/api 和 /api/xxx 都会进来。
 */
import { app } from './_lib/index.js';

export const onRequest = (ctx) => app.fetch(ctx.request, ctx.env, ctx);
