/**
 * 結帳相關服務
 * sweepStaleSettlementDrafts：每日清理逾期的「暫存檔」(status:'draft')——
 *   暫存檔只保留今天與最近三天，date < (今天−3) 的 draft 自動刪除。
 *   ⚠️ 只刪 status==='draft'；settled/unlocked 等正式結帳紀錄一律不動、永不刪。
 */
const dayjs = require('dayjs');
const { getDb } = require('../config/firebase');

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

// ── 現金收款寫入當日結帳「加減項」（＋現金補入）──────────────────
// 比賽/課程臨櫃現金收款確認時呼叫：金額寫進該館今日結帳加減項（note＝人名＋活動名）。
// 無今日結帳 doc → 建暫存檔（draft，開結帳頁自動載入）；已有（draft/settled）→ 附加到 deductions。
// 已 settled 的情況：附加後於「當日再次結帳」帶入重算（結帳摘要淨額即時可見）。
const addCashAdjustment = async ({ gymId, amount, note }) => {
  if (!gymId || !(Number(amount) > 0)) return { skipped: true };
  const db = getDb();
  const today = dayjs().format('YYYY-MM-DD');
  const item = { sign: '+', type: '現金補入', amount: Number(amount), note: String(note || '').trim(), auto: true };
  const snap = await db.collection('dailySettlements')
    .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
  if (snap.empty) {
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    await db.collection('dailySettlements').doc(id).set({
      id, gymId, date: today, status: 'draft', deductions: [item],
      autoDraft: true, createdAt: new Date(), updatedAt: new Date(),
    });
  } else {
    const doc = snap.docs[0];
    const ded = Array.isArray(doc.data().deductions) ? doc.data().deductions : [];
    await doc.ref.update({ deductions: [...ded, item], updatedAt: new Date() });
  }
  return { added: true };
};

module.exports = { sweepStaleSettlementDrafts, addCashAdjustment };
