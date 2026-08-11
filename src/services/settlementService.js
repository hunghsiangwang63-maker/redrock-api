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
const addCashAdjustment = async ({ gymId, amount, note, sign = '+', type = '現金補入', targetDate }) => {
  if (!gymId || !(Number(amount) > 0)) return { skipped: true };
  const db = getDb();
  let date = targetDate || dayjs().format('YYYY-MM-DD');
  // id：供結帳頁「系統自動加減項不可人工刪除/修改」的後端比對用（見 routes/dailySettlements.js
  // findRemovedOrAlteredAutoDeductions）——每筆自動記錄都要有穩定識別碼，儲存時才能精確核對是否被動過。
  const item = { id: uuidv4(), sign: sign === '-' ? '-' : '+', type: type || '現金補入', amount: Number(amount), note: String(note || '').trim(), auto: true };

  for (let i = 0; i < MAX_DEFER_DAYS; i++) {
    const snap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', date).limit(1).get();
    if (snap.empty) {
      const id = uuidv4();
      await db.collection('dailySettlements').doc(id).set({
        id, gymId, date, status: 'draft', deductions: [item],
        autoDraft: true, createdAt: new Date(), updatedAt: new Date(),
      });
      return { added: true, date };
    }
    const doc = snap.docs[0];
    if (doc.data().status === 'settled') {
      date = dayjs(date).add(1, 'day').format('YYYY-MM-DD'); // 已結帳，不動它——順延到下一天再試
      continue;
    }
    const ded = Array.isArray(doc.data().deductions) ? doc.data().deductions : [];
    await doc.ref.update({ deductions: [...ded, item], updatedAt: new Date() });
    return { added: true, date };
  }
  // 極端狀況（連續 30 天都已結帳，理論上不會發生）：記 log 供人工介入，不拋錯阻斷呼叫端主流程
  console.error(`[結帳加減項] ${gymId} 從 ${targetDate || '今天'} 起連續 ${MAX_DEFER_DAYS} 天皆已結帳，放棄自動寫入：${type} ${note}`);
  return { skipped: true, reason: 'ALL_DAYS_SETTLED' };
};

module.exports = { sweepStaleSettlementDrafts, addCashAdjustment };
