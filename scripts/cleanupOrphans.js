/**
 * Dev 殘留清理：孤兒卡/券/定期票（owner 會員已不存在）+ 測試 shiftLog（stationId 前綴）
 *
 * 「孤兒」定義：文件的 owner 欄位有值、但對應的 members 文件已不存在（多半是刪測試會員後留下的）。
 * owner 為 null（未指派）者不算孤兒、不會刪。測試 shiftLog 只清 stationId 以指定前綴開頭者。
 *
 * 憑證走專案慣例（與 seedTestMembers.js 相同）：env FIREBASE_* 或 GOOGLE_APPLICATION_CREDENTIALS。
 *
 * 用法（redrock-api 目錄下）：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/cleanupOrphans.js
 *   刪除：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/cleanupOrphans.js --commit
 *   自訂測試站前綴（預設 e2e-）：... node scripts/cleanupOrphans.js --station-prefix=test-
 *   只清孤兒卡券、不動 shiftLog：... --no-shifts
 */
const { initFirebase, getDb } = require('../src/config/firebase');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const NO_SHIFTS = args.includes('--no-shifts');
const STATION_PREFIX = (args.find(a => a.startsWith('--station-prefix=')) || '--station-prefix=e2e-').split('=')[1];

// owner 欄位有值但會員不存在 → 孤兒。逐集合設定其 owner 欄位。
const ORPHAN_COLLECTIONS = [
  { name: 'discountCards', ownerField: 'ownerMemberId', label: '新優惠卡' },
  { name: 'legacyDiscountCards', ownerField: 'ownerMemberId', label: '舊優惠卡' },
  { name: 'legacyBlackCards', ownerField: 'memberId', label: '黑卡' },
  { name: 'singleEntryTickets', ownerField: 'memberId', label: '單次入場券' },
  { name: 'memberPasses', ownerField: 'memberId', label: '定期票' },
  { name: 'installmentPlans', ownerField: 'memberId', label: '分期計畫' },
];

const fmt = (ts) => (ts && ts.toDate ? ts.toDate().toISOString().slice(0, 16) : '?');

(async () => {
  initFirebase();
  const db = getDb();

  const memSnap = await db.collection('members').get();
  const memberIds = new Set(memSnap.docs.map(d => d.id));
  console.log(`現有會員 ${memberIds.size} 筆\n`);

  const toDelete = [];

  for (const c of ORPHAN_COLLECTIONS) {
    const snap = await db.collection(c.name).get();
    const orphans = snap.docs.filter(d => {
      const owner = d.data()[c.ownerField];
      return owner && !memberIds.has(owner);
    });
    console.log(`【${c.label} ${c.name}】總 ${snap.size}，孤兒 ${orphans.length}`);
    orphans.forEach(d => {
      const x = d.data();
      console.log(`   - ${d.id} owner=${x[c.ownerField]} status=${x.status || '-'} source=${x.source || '-'} 剩=${x.remainingCredits ?? '-'} 建=${fmt(x.createdAt)}`);
      toDelete.push({ ref: d.ref });
    });
  }

  if (!NO_SHIFTS) {
    const shiftSnap = await db.collection('shiftLogs').get();
    const testShifts = shiftSnap.docs.filter(d => String(d.data().stationId || '').startsWith(STATION_PREFIX));
    console.log(`\n【shiftLogs】總 ${shiftSnap.size}，測試(${STATION_PREFIX}) ${testShifts.length}`);
    testShifts.forEach(d => {
      const x = d.data();
      console.log(`   - ${d.id} station=${x.stationId} staff=${x.staffName} gym=${x.gymId} in=${fmt(x.clockInAt)}`);
      toDelete.push({ ref: d.ref });
    });
  }

  console.log(`\n===== 待刪合計 ${toDelete.length} 筆 =====`);
  if (!COMMIT) {
    console.log('（dry-run，未刪除。加 --commit 才實際刪除）');
    process.exit(0);
  }
  let n = 0;
  while (n < toDelete.length) {
    const batch = db.batch();
    toDelete.slice(n, n + 400).forEach(x => batch.delete(x.ref));
    await batch.commit();
    n += 400;
  }
  console.log(`✅ 已刪除 ${toDelete.length} 筆`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
