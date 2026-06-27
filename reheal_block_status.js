/**
 * 批次重整會員封鎖狀態（blockReasons / isBlocked）
 *
 * 背景：舊版 getBlockReasons 把墜測查詢值寫成 'pass'（實際儲存為 'passed'），
 * 導致已通過墜測的會員仍殘留 fall_test_required（例如王大明）。後端已修正查詢值，
 * 但既有會員文件的 blockReasons 不會自動回填，需用本腳本重算一次。
 *
 * 直接重用後端權威函式 memberService.getBlockReasons，確保與線上邏輯完全一致。
 *
 * 用法：
 *   node reheal_block_status.js            # dry-run，只列出將變更的會員，不寫入
 *   node reheal_block_status.js --apply    # 實際寫入 Firestore
 */
const admin = require('firebase-admin');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const serviceAccount = require(path.join(process.env.HOME, 'Downloads/redrock-dev-a35c1-firebase-adminsdk-fbsvc-94b5c692f3.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 必須在 admin.initializeApp 之後 require，getDb() 才會用到上面初始化的 app
const { getBlockReasons } = require('./src/services/memberService');

const sameSet = (a, b) =>
  a.length === b.length && a.every(x => b.includes(x)) && b.every(x => a.includes(x));

(async () => {
  const snap = await db.collection('members').get();
  let scanned = 0, changed = 0;

  for (const doc of snap.docs) {
    scanned++;
    const member = { id: doc.id, ...doc.data() };
    const oldReasons = Array.isArray(member.blockReasons) ? member.blockReasons : [];
    let newReasons;
    try {
      newReasons = await getBlockReasons(doc.id, member);
    } catch (e) {
      console.log(`⚠️  ${member.name || ''} (${doc.id}) 重算失敗：${e.message}`);
      continue;
    }

    if (sameSet(oldReasons, newReasons)) continue;

    changed++;
    console.log(`• ${member.name || '(無名)'} ${member.phone || ''} [${doc.id}]`);
    console.log(`    old: isBlocked=${!!member.isBlocked} [${oldReasons.join(', ')}]`);
    console.log(`    new: isBlocked=${newReasons.length > 0} [${newReasons.join(', ')}]`);

    if (APPLY) {
      await doc.ref.update({
        isBlocked: newReasons.length > 0,
        blockReasons: newReasons,
        updatedAt: new Date(),
      });
    }
  }

  console.log(`\n掃描 ${scanned} 位會員，${changed} 位需重整。${APPLY ? '✅ 已寫入。' : '（dry-run，加 --apply 才會寫入）'}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
