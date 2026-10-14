// 後端→Firestore 讀取延遲自我監測（2026-10-14）。
// 背景：Railway 不同實例（宿主機）的單筆讀取延遲差 10 倍（快 ~55ms／慢 ~500ms），慢實例上新會員註冊、入場驗票、
// 待辦等會逾時（客人端 10 秒放棄）。這個問題用肉眼/客人回報才發現，所以由實例自己量：
//  - 啟動後 10 秒量一次、之後每 30 分鐘量一次（連續讀同一份小文件 6 次，丟掉第一次〔含連線建立〕，取後 5 次的中位數）
//  - 中位數 > 門檻（預設 250ms，可用環境變數 LATENCY_SLOW_MS 調整）→ 記 log＋通知所有超級管理員（同一實例 3 小時內不重複通知）
//  - 之前通知過「慢」、之後量到恢復 → 通知一次「已恢復」
// 成本：每次 6 筆讀取（約每天 300 筆），可忽略。永不拋錯、不影響服務。
const os = require('os');
const { getDb } = require('../config/firebase');

const SLOW_MS = Number(process.env.LATENCY_SLOW_MS) || 250;
const FIRST_RUN_DELAY_MS = 10 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;
const RENOTIFY_MS = 3 * 60 * 60 * 1000;
const SAMPLES = 6;

const state = { lastRunAt: null, lastMedianMs: null, lastMaxMs: null, slow: null, notifiedSlowAt: null, runs: 0 };
let timer = null;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 量測：回傳 { medianMs, maxMs, samples }
const measure = async (db = getDb(), now = () => Date.now()) => {
  const ref = db.collection('gyms').doc('gym-hsinchu');
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = now();
    await ref.get();
    times.push(now() - t);
  }
  const used = times.slice(1); // 丟掉第一次（gRPC 連線建立）
  return { medianMs: median(used), maxMs: Math.max(...used), samples: times };
};

const instanceInfo = () => ({
  deployment: (process.env.RAILWAY_DEPLOYMENT_ID || '').slice(0, 8) || null,
  replica: process.env.RAILWAY_REPLICA_ID ? String(process.env.RAILWAY_REPLICA_ID).slice(0, 8) : null,
  cpuCount: os.cpus().length,
  version: process.env.npm_package_version || null,
});

// deps 供測試注入：{ db, notify, now, log }
const checkOnce = async (deps = {}) => {
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  try {
    const notify = deps.notify || (async (p) => require('./notificationService').notifyRoleInGym({ gymId: null, role: 'super_admin', ...p }));
    const r = await measure(deps.db || getDb(), now);
    const wasSlow = state.slow;
    state.runs++; state.lastRunAt = new Date(now()); state.lastMedianMs = r.medianMs; state.lastMaxMs = r.maxMs; state.slow = r.medianMs > SLOW_MS;
    const info = instanceInfo();
    log.log(`[延遲監測] 中位數 ${r.medianMs}ms／最大 ${r.maxMs}ms（門檻 ${SLOW_MS}ms）${state.slow ? '⚠️ 偏慢' : '正常'} 實例 cpu=${info.cpuCount} deploy=${info.deployment || '-'}`);
    if (state.slow) {
      const due = !state.notifiedSlowAt || (now() - state.notifiedSlowAt) > RENOTIFY_MS;
      if (due) {
        state.notifiedSlowAt = now();
        await notify({
          type: 'system_slow_instance',
          title: '⚠️ 後端目前讀取偏慢（Railway 實例）',
          body: `這台後端實例讀取資料庫單筆中位數 ${r.medianMs}ms（正常約 50~70ms，門檻 ${SLOW_MS}ms）。客人端可能出現逾時（入場驗票、註冊、待辦載入失敗）。` +
                `可到 Railway 重新部署換實例，或請工程協助。（實例 cpu=${info.cpuCount}、部署 ${info.deployment || '-'}）`,
        });
      }
    } else if (wasSlow === true && state.notifiedSlowAt) {
      state.notifiedSlowAt = null;
      await notify({
        type: 'system_slow_instance_recovered',
        title: '✅ 後端讀取速度已恢復',
        body: `讀取資料庫單筆中位數 ${r.medianMs}ms，已回到正常範圍。（實例 cpu=${info.cpuCount}、部署 ${info.deployment || '-'}）`,
      });
    }
    return { ...r, slow: state.slow };
  } catch (e) {
    (deps.log || console).error('[延遲監測] 失敗（不影響服務）:', e.message);
    return null;
  }
};

const start = () => {
  if (timer) return;
  setTimeout(() => { checkOnce(); }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => { checkOnce(); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
};

const getState = () => ({ ...state, slowThresholdMs: SLOW_MS });

module.exports = { start, checkOnce, measure, getState, SLOW_MS };
