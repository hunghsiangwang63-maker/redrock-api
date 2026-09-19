/**
 * 紅石賽事計分系統（Redrock-comp 專案）資料備份（2026-09-19）
 *
 * 背景：`redrock-comp` 是完全獨立的 Firebase 專案（見 config/compFirebase.js），本身沒有啟用計費
 * 方案（Spark 免費層）——Firestore 的原生「排定的備份」功能需要 Blaze 付費方案才能用。使用者確認
 * 「不要」為了備份特地幫 redrock-comp 開通計費（會讓該專案任何用量都變成即時計費，非本次目的所需），
 * 改為：把 redrock-comp 的資料透過既有的跨專案連線（COMP_FIREBASE_SA）鏡射進**本專案**
 * （redrock-dev-a35c1）自己的 Firestore——本專案已於同一天開啟每日自動備份（30 天保留），這份鏡射
 * 資料會自動被那份備份涵蓋，等於間接幫 redrock-comp 取得每日備份保護，不需要它自己啟用付費方案。
 *
 * 涵蓋範圍（依 redrock-comp 前端 `public/index.html` 實際使用的 Firestore 結構逐一核對，非猜測）：
 *   - `competitions/{compId}`           主賽事文件（賽程/組別/選手/裁判帳號/單場管理員/贊助設定等）
 *   - `competitions/{compId}/data/scores` 各賽事成績子文件（曾接近 1MB 上限，故用「鏡射成獨立目標
 *                                        文件」而非塞進同一份主文件，避免疊加超過 Firestore 1MB 限制）
 *   - `sponsors/{sponsorId}`            贊助商 Logo（含 `_settings` 全域顯示期間設定）
 * `config/admin` 舊密碼雜湊文件已於 2026-08-15/2026-09-16 安全加固後停用（規則鎖死、無人讀寫），
 * 非活躍資料，刻意不納入備份範圍。
 *
 * 做法＝**鏡射／覆寫**（非累積歷史）：每次執行都用 redrock-comp 當下的即時內容覆蓋目標集合，並把
 * 來源已不存在（賽事/贊助商被刪除）的鏡射文件一併刪除，讓目標集合的內容隨時等於「redrock-comp
 * 現在長怎樣」。多天的歷史版本由**本專案自己的 Firestore 每日備份**（30 天保留）負責保留，這裡
 * 不用自己再做版本化，避免兩套機制疊加、責任不清。
 */
const { getCompDb } = require('../config/compFirebase');
const { getDb } = require('../config/firebase');

const DEST = {
  competitions: 'compBackupCompetitions',
  scores: 'compBackupScores',
  sponsors: 'compBackupSponsors',
  meta: 'compBackupMeta',
};

// Firestore batch 上限 500 次操作/批——保守用 400 分批，即使資料量成長也不會炸。
const BATCH_LIMIT = 400;

async function commitInChunks(db, ops) {
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
    await batch.commit();
  }
}

/**
 * 鏡射一批 { id, data } 到本專案的目標集合：寫入現有文件、刪除已消失的舊鏡射文件。
 * 回傳實際寫入的文件數。⚠ `id` 由呼叫端決定——不能直接沿用來源的 doc.id：`competitions/{compId}/
 * data/scores` 這個子文件在每個賽事底下都叫一樣的字面 id「scores」，若直接拿它當目標集合的
 * doc id，不同賽事的成績會全部互相覆蓋成同一份（曾在第一次上線時踩過，只留下最後處理的那筆）。
 * 呼叫端對 scores 一律改用「所屬賽事的 compId」當目標 id，一個賽事一份、不會碰撞。
 */
async function mirrorCollection(db, items, destCollectionName) {
  const liveIds = new Set(items.map(it => it.id));
  const existingSnap = await db.collection(destCollectionName).select().get();
  const staleIds = existingSnap.docs.map(d => d.id).filter(id => !liveIds.has(id));

  const ops = [];
  for (const it of items) {
    ops.push(batch => batch.set(db.collection(destCollectionName).doc(it.id), it.data, { merge: false }));
  }
  for (const id of staleIds) {
    ops.push(batch => batch.delete(db.collection(destCollectionName).doc(id)));
  }
  await commitInChunks(db, ops);
  return { written: items.length, deleted: staleIds.length };
}

async function backupCompFirestore() {
  const cdb = getCompDb();
  if (!cdb) return { skipped: true, reason: 'COMP_NOT_CONFIGURED' };
  const db = getDb();

  const compsSnap = await cdb.collection('competitions').get();
  const sponsorsSnap = await cdb.collection('sponsors').get();

  // 逐賽事讀取 data/scores 子文件（存在才鏡射；多數賽事都有，未開賽前可能還沒有分數資料）——
  // 目標 id 用所屬賽事的 compId（見上方 mirrorCollection 註解，不可用子文件自己的 'scores' 字面 id）。
  const scoreItems = [];
  for (const c of compsSnap.docs) {
    const scoresDoc = await cdb.collection('competitions').doc(c.id).collection('data').doc('scores').get();
    if (scoresDoc.exists) scoreItems.push({ id: c.id, data: scoresDoc.data() });
  }

  const compItems = compsSnap.docs.map(d => ({ id: d.id, data: d.data() }));
  const sponsorItems = sponsorsSnap.docs.map(d => ({ id: d.id, data: d.data() }));

  const compResult = await mirrorCollection(db, compItems, DEST.competitions);
  const scoreResult = await mirrorCollection(db, scoreItems, DEST.scores);
  const sponsorResult = await mirrorCollection(db, sponsorItems, DEST.sponsors);

  const summary = {
    skipped: false,
    backedUpAt: new Date().toISOString(),
    competitionsCount: compResult.written,
    scoresCount: scoreResult.written,
    sponsorsCount: sponsorResult.written,
    deletedStale: compResult.deleted + scoreResult.deleted + sponsorResult.deleted,
  };
  await db.collection(DEST.meta).doc('latest').set({ ...summary, backedUpAt: require('firebase-admin').firestore.FieldValue.serverTimestamp() });
  return summary;
}

module.exports = { backupCompFirestore };
