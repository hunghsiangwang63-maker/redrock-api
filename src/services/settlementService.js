/**
 * 結帳相關服務
 * sweepStaleSettlementDrafts：每日清理逾期的「暫存檔」(status:'draft')——
 *   暫存檔只保留今天與最近三天，date < (今天−3) 的 draft 自動刪除。
 *   ⚠️ 只刪 status==='draft'；settled/unlocked 等正式結帳紀錄一律不動、永不刪。
 */
const dayjs = require('dayjs');
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

const sweepStaleSettlementDrafts = async () => {
  const db = getDb();
  // 保留今天與最近三天，刪更舊的（date < 今天−3）
  const cutoff = dayjs().subtract(3, 'day').format('YYYY-MM-DD');
  // 單一 where（避免複合索引），date 記憶體過濾
  const snap = await db.collection('dailySettlements').where('status', '==', 'draft').get();
  const stale = snap.docs.filter(d => (d.data().date || '') < cutoff);
  let deleted = 0;
  // 分批刪除（Firestore batch 上限 500；暫存筆數少，一批通常足夠）
  for (let i = 0; i < stale.length; i += 450) {
    const batch = db.batch();
    stale.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += Math.min(450, stale.length - i);
  }
  console.log(`[結帳暫存清理] 刪除 ${deleted} 筆逾期 draft（cutoff=${cutoff}）`);
  return { deleted };
};

// ── 現金收款寫入當日結帳「加減項」（＋現金補入／−教練費等）──────────────────
// 比賽/課程臨櫃現金收款確認、租借押金收取/退還、體驗教練費等呼叫：金額寫進目標日結帳加減項
// （note＝人名＋活動名）。目標日＝targetDate（未帶則預設今天，即多數「現金當下就發生變動」
// 情境的天然基準；體驗教練費這類有自己活動日期的類型，由呼叫端明確帶入 targetDate＝活動當天，
// 而非管理員填寫金額的當下——見 experienceBookings.js）。
// 無目標日結帳 doc → 建暫存檔（draft，開結帳頁自動載入）；已有 draft → 附加到 deductions。
// ⚠️ 2026-08-11 案例：教練費在店家已經打烊、結帳完成後才被填入，`addCashAdjustment` 原本會直接
// 悄悄改寫已經結帳（status:'settled'）的紀錄，導致當時關帳的人完全沒看到這筆、金額也對不上，
// 要等事後有人重新結帳才校正回來。改為：目標日已經結帳 → 不動它，逐日往後找第一個「尚未結帳」
// 的日子（draft 或完全沒有紀錄）才寫入，避免悄悄弄亂店員已核對關閉的當日帳。
const MAX_DEFER_DAYS = 30; // 防呆上限（理論上不會真的連續跳這麼多天，純粹避免資料異常時無窮迴圈）
// ⚠️ 2026-09-19 案例（黎晉瑋體驗教練費 400→0）：`/finance` 端點的競態修好後、E2E 併發測試又抓到
// 這裡本身也有一個獨立、更根本的競態——原本是「查有沒有今日結帳文件→用讀到的 deductions 陣列
// 組新陣列→整份覆寫回去」，三步驟分開、不是原子操作。兩筆幾乎同時送來的加減項（例如同一天的
// 「－教練費400」與「＋教練費修正400」）若剛好交錯：實測過兩種真實出現的症狀——①兩邊都讀到
// 「今日尚無結帳文件」，各自建出一份新文件，同一天出現兩份 dailySettlements（其中一筆的加減項
// 從此在正常查詢路徑消失）②兩邊都讀到同一份舊的 deductions 陣列，後寫入的那筆整份覆寫蓋掉先寫
// 入的那筆（classic lost update，兩筆理應都要保留卻只剩一筆）。改用 Firestore transaction 包住
// 「查詢＋判斷＋寫入」整段——`tx.get(query)` 會把查詢範圍一併納入交易的讀取集，任何並發寫入落在
// 這個範圍就會讓其中一個 transaction 自動 abort+retry、用重新讀到的最新資料再判斷一次，兩種症狀都
// 會被排除（同一套手法已在 2026-07-16 課程/比賽報名去重用過、redrock-api 既有慣例）。
const addCashAdjustment = async ({ gymId, amount, note, sign = '+', type = '現金補入', targetDate, refId }) => {
  if (!gymId || !(Number(amount) > 0)) return { skipped: true };
  const db = getDb();
  let date = targetDate || dayjs().format('YYYY-MM-DD');
  // id：供結帳頁「系統自動加減項不可人工刪除/修改」的後端比對用（見 routes/dailySettlements.js
  // findRemovedOrAlteredAutoDeductions）——每筆自動記錄都要有穩定識別碼，儲存時才能精確核對是否被動過。
  const item = { id: uuidv4(), sign: sign === '-' ? '-' : '+', type: type || '現金補入', amount: Number(amount), note: String(note || '').trim(), auto: true };
  // refId：這筆自動加減項屬於哪個來源單據（如體驗預約 id）。來源單據改日期時，靠它找回這筆搬到新日期
  // （見 relocateAutoDeductions；2026-10-04 郭詠蓁案例：預約改上課日，教練費加減項沒跟著動）。
  if (refId) item.refId = refId;

  for (let i = 0; i < MAX_DEFER_DAYS; i++) {
    const query = db.collection('dailySettlements').where('gymId', '==', gymId).where('date', '==', date).limit(1);
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(query);
      if (snap.empty) {
        const id = uuidv4();
        tx.set(db.collection('dailySettlements').doc(id), {
          id, gymId, date, status: 'draft', deductions: [item],
          autoDraft: true, createdAt: new Date(), updatedAt: new Date(),
        });
        return 'added';
      }
      const doc = snap.docs[0];
      if (doc.data().status === 'settled') return 'defer'; // 已結帳，不動它——順延到下一天再試
      const ded = Array.isArray(doc.data().deductions) ? doc.data().deductions : [];
      tx.update(doc.ref, { deductions: [...ded, item], updatedAt: new Date() });
      return 'added';
    });
    if (outcome === 'added') return { added: true, date };
    date = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
  }
  // 極端狀況（連續 30 天都已結帳，理論上不會發生）：記 log 供人工介入，不拋錯阻斷呼叫端主流程
  console.error(`[結帳加減項] ${gymId} 從 ${targetDate || '今天'} 起連續 ${MAX_DEFER_DAYS} 天皆已結帳，放棄自動寫入：${type} ${note}`);
  return { skipped: true, reason: 'ALL_DAYS_SETTLED' };
};

// ⚠️ 2026-10-04 案例（郭詠蓁體驗教練費）：體驗預約的上課日被改（9/27→9/30→9/29），但教練費的
// 「−教練費」自動加減項早在設定當下就寫進當時預約日那天的結帳，之後沒有任何機制跟著搬，結果 9/30
// 結帳多扣一筆（店員 9/29 已手動記了教練費），差異 +400。
// 搬移規則：只動「還沒結帳（draft）」的結帳裡、帶同一個 refId 的自動加減項——把它從舊日移除、依
// 原金額/正負/類型/備註改寫到新日期（新日期已結帳則沿用 addCashAdjustment 的既有順延）。
// 已結帳（settled）的日子一律不動（比照 2026-08-11 政策：不悄悄改寫店員已核對關閉的帳）；舊日若是
// 系統自動建立的空草稿（autoDraft）且搬完沒有加減項了，順手刪掉避免留空殼。沒有 refId 的舊資料不搬。
const relocateAutoDeductions = async ({ gymId, refId, toDate }) => {
  if (!gymId || !refId || !toDate) return { moved: 0 };
  const db = getDb();
  const snap = await db.collection('dailySettlements').where('gymId', '==', gymId).where('status', '==', 'draft').get();
  const items = [];
  for (const doc of snap.docs) {
    const mine = (Array.isArray(doc.data().deductions) ? doc.data().deductions : []).filter(d => d.auto && d.refId === refId);
    if (!mine.length) continue;
    const removed = await db.runTransaction(async (tx) => {
      const cur = await tx.get(doc.ref);
      if (!cur.exists || cur.data().status !== 'draft') return [];
      const ded = Array.isArray(cur.data().deductions) ? cur.data().deductions : [];
      const m = ded.filter(d => d.auto && d.refId === refId);
      if (!m.length) return [];
      const rest = ded.filter(d => !(d.auto && d.refId === refId));
      if (rest.length === 0 && cur.data().autoDraft) tx.delete(doc.ref);
      else tx.update(doc.ref, { deductions: rest, updatedAt: new Date() });
      return m;
    });
    items.push(...removed);
  }
  for (const it of items) {
    await addCashAdjustment({ gymId, amount: it.amount, sign: it.sign, type: it.type, note: it.note, targetDate: toDate, refId });
  }
  return { moved: items.length };
};

module.exports = { sweepStaleSettlementDrafts, addCashAdjustment, relocateAutoDeductions };
