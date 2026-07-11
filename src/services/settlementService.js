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

module.exports = { sweepStaleSettlementDrafts };
