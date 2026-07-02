/**
 * 將既有公開（makePublic）的個資物件改為私有
 * 範圍：waivers/（會員/家長/比賽簽名）、qrcodes/（會員 QR，App 前端自產、不用此圖）。
 * 後端已改為顯示時產生短效簽名 URL（utils/storageUrl.signFields），故簽名圖轉私有後仍可正常顯示。
 * pass-requests/ 舊憑證不在此範圍（避免影響既有請求的憑證檢視；新上傳已私有＋簽名 URL）。
 *
 * ⚠ 執行前請先部署含 signFields 的後端版本，否則現網簽名顯示會短暫失效。
 *
 * 用法：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/makeStoragePrivate.js
 *   執行：...同上... --commit
 */
const COMMIT = process.argv.includes('--commit');
const PREFIXES = ['waivers/', 'qrcodes/'];

(async () => {
  const { initFirebase, getStorage } = require('../src/config/firebase');
  initFirebase();
  const bucket = getStorage().bucket();

  let total = 0, madePrivate = 0, alreadyPrivate = 0, failed = 0;
  for (const prefix of PREFIXES) {
    const [files] = await bucket.getFiles({ prefix });
    console.log(`\n[${prefix}] 物件數：${files.length}`);
    for (const file of files) {
      total++;
      try {
        // 檢查目前是否公開（allUsers READER）
        const [meta] = await file.getMetadata();
        // 簡化：直接嘗試設私有（冪等）
        if (!COMMIT) { continue; }
        await file.makePrivate({ strict: false }); // 移除公開授權，保留其他 ACL
        madePrivate++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.error('  失敗', file.name, e.message);
      }
    }
  }
  console.log(`\n===== ${COMMIT ? '【執行】' : '（預覽）'} =====`);
  console.log(`掃描物件 ${total}`);
  if (COMMIT) console.log(`已轉私有 ${madePrivate}｜失敗 ${failed}`);
  else console.log('（預覽模式，未變更。確認後加 --commit）');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
