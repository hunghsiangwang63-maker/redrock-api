// ── 一次性診斷工具（2026-09-26）：找出「12.85M 次讀取/月」的真正來源 ─────────
// 用途：monkey-patch Firestore SDK 的 4 個讀取入口（Query.get／Firestore.getAll／
// Transaction.get，涵蓋 collection().get()／doc().get()（會內部委派給 getAll，故不
// 另外 patch DocumentReference.get，避免雙重計算）／tx.get()），對每一次讀取記錄
// 「是哪個 API 路徑、哪一行程式碼呼叫的、讀了幾筆」，彙總在記憶體，透過一個受保護
// 的臨時端點查看。純觀察性質：一律呼叫原始方法、回傳值完全不變，任何診斷邏輯本身
// 的錯誤都被 try/catch 吞掉、絕不影響正常查詢結果。
//
// 安全機制：
// - 診斷視窗預設 60 分鐘，超過即自動失效（wrapper 內部檢查時間戳，過期直接呼叫原始
//   方法、不再記錄，也會把 prototype 還原成原始方法本身）——不需要手動關閉、不會忘記
//   關掉留在正式環境長期跑。
// - 呼叫點辨識用 __filename 動態排除本檔案自己的框（而非用猜的字串），對「.doc().get()
//   內部委派 getAll」這種情況已實測驗證不會誤判成本檔案自己造成、能正確歸因到真正呼叫
//   的業務程式碼行號。
// - 診斷端點限 super_admin。
const { AsyncLocalStorage } = require('async_hooks');
const { Query, Firestore, Transaction } = require('@google-cloud/firestore');

// ⚠️ 2026-09-26 08:50 部署當下才早上，館還沒開（週末營業時段約 12:00 起）——原訂 60 分鐘的
// 診斷窗口會在真正有客人/員工使用前就失效，抓不到有意義的真實流量。改成 10 小時，涵蓋整個
// 週末營業時段（含收尾）；到期後一樣自動失效還原，不影響下一次要診斷時重新調整這個常數再部署。
const DIAG_WINDOW_MS = 10 * 60 * 60 * 1000; // 10 小時
const startedAt = Date.now();
const requestContext = new AsyncLocalStorage();
const stats = new Map(); // key: `${routePath} || ${callSite}` -> { routePath, callSite, count, totalDocs }
let requestCount = 0;

function isExpired() {
  return Date.now() - startedAt > DIAG_WINDOW_MS;
}

function readSizeOf(result) {
  if (result == null) return 0;
  if (typeof result.size === 'number') return result.size; // QuerySnapshot
  if (Array.isArray(result)) return result.length; // Firestore.getAll()
  return 1; // 單一 DocumentSnapshot（Transaction.get(docRef) 的情況）
}

function callSiteOf(stack) {
  const lines = String(stack || '').split('\n').slice(1);
  for (const line of lines) {
    if (line.includes('node:internal')) continue;
    if (line.includes('node_modules/@google-cloud/firestore')) continue;
    if (line.includes('node_modules/firebase-admin')) continue;
    if (line.includes(__filename)) continue;
    return line.trim();
  }
  return 'unknown';
}

function record(size, stack) {
  try {
    const ctx = requestContext.getStore();
    const routePath = ctx?.path || '(no-request-context)';
    const callSite = callSiteOf(stack);
    const key = `${routePath} || ${callSite}`;
    const entry = stats.get(key) || { routePath, callSite, count: 0, totalDocs: 0 };
    entry.count += 1;
    entry.totalDocs += size;
    stats.set(key, entry);
  } catch (e) { /* 診斷本身絕不能影響正常查詢結果 */ }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;

  const origQueryGet = Query.prototype.get;
  Query.prototype.get = async function (...args) {
    if (isExpired()) { Query.prototype.get = origQueryGet; return origQueryGet.apply(this, args); }
    const r = await origQueryGet.apply(this, args);
    record(readSizeOf(r), new Error().stack);
    return r;
  };

  const origGetAll = Firestore.prototype.getAll;
  Firestore.prototype.getAll = async function (...args) {
    if (isExpired()) { Firestore.prototype.getAll = origGetAll; return origGetAll.apply(this, args); }
    const r = await origGetAll.apply(this, args);
    record(readSizeOf(r), new Error().stack);
    return r;
  };

  const origTxGet = Transaction.prototype.get;
  Transaction.prototype.get = async function (...args) {
    if (isExpired()) { Transaction.prototype.get = origTxGet; return origTxGet.apply(this, args); }
    const r = await origTxGet.apply(this, args);
    record(readSizeOf(r), new Error().stack);
    return r;
  };

  console.log(`[queryDiag] 診斷模式已啟用，${DIAG_WINDOW_MS / 60000} 分鐘後自動失效`);
}

// Express middleware：放在最外層，讓整個 request 生命週期（含中介層如 authenticate）
// 都在同一個 AsyncLocalStorage context 內，才能正確歸因到「這次讀取屬於哪個 API 路徑」。
function requestContextMiddleware(req, res, next) {
  if (isExpired()) return next();
  requestCount += 1;
  requestContext.run({ path: `${req.method} ${req.path}` }, next);
}

function getStats() {
  return {
    windowMinutes: DIAG_WINDOW_MS / 60000,
    active: !isExpired(),
    elapsedMinutes: Math.round((Date.now() - startedAt) / 60000 * 10) / 10,
    requestCount,
    rows: Array.from(stats.values()).sort((a, b) => b.totalDocs - a.totalDocs),
  };
}

module.exports = { install, requestContextMiddleware, getStats };
