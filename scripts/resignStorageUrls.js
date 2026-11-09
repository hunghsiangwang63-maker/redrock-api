/**
 * resignStorageUrls.js — 把 Firestore 內「用舊服務帳戶金鑰簽名的 Storage 網址」換成現行金鑰重簽的網址
 *
 * 為什麼需要：公告橫幅、班別海報、會員首頁提醒圖等存的是 getSignedUrl（V2、到期日很遠）簽出的完整網址，
 * 簽名綁定「簽名當時的服務帳戶金鑰」。金鑰輪替並刪除舊金鑰後，這些網址全部變成 403（圖片看不到），
 * 但檔案本身還在 bucket 裡。2026-10-24 輪替 Firebase 金鑰後發生（2026-11-09 修復）。
 *
 * 用法（預設只試算不寫入）：
 *   FIREBASE_STORAGE_BUCKET=redrock-dev-a35c1.firebasestorage.app \
 *   GOOGLE_APPLICATION_CREDENTIALS=<金鑰檔> node scripts/resignStorageUrls.js [--apply] [集合1 集合2 ...]
 * 未指定集合時掃預設清單。--apply 時會先把改前的值寫到 ./resign-backup-<時間>.json。
 * ⚠️ 之後每次輪替／刪除服務帳戶金鑰，都要重跑一次（或改成讀取時簽名）。
 */
const fs = require('fs');
const { initFirebase, getDb, getStorage } = require('../src/config/firebase');

const APPLY = process.argv.includes('--apply');
const cols = process.argv.slice(2).filter(a => !a.startsWith('--'));
const DEFAULT_COLS = ['gymAnnouncements', 'courseCategories', 'memberHomeReminders', 'courses', 'gyms', 'climbingRoutes', 'competitions', 'products', 'transferRecords'];
const EXPIRES = new Date('2051-01-01').getTime();

(async () => {
  initFirebase();
  const db = getDb();
  const bucket = getStorage().bucket();
  const prefix = `https://storage.googleapis.com/${bucket.name}/`;
  const backup = [];
  let changed = 0, failed = 0;

  const resign = async (url) => {
    if (typeof url !== 'string' || !url.startsWith(prefix) || !url.includes('GoogleAccessId=')) return null;
    const path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
    const [exists] = await bucket.file(path).exists();
    if (!exists) { failed++; console.log('  ⚠ 檔案不存在', path); return null; }
    const [fresh] = await bucket.file(path).getSignedUrl({ action: 'read', expires: EXPIRES });
    return fresh;
  };
  const walk = async (obj, pathPrefix, out) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (typeof v === 'string') { const n = await resign(v); if (n) out.push([pathPrefix + k, v, n]); }
      else if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string') { const n = await resign(v[i]); if (n) out.push([`${pathPrefix}${k}.${i}`, v[i], n]); }
        else if (v[i] && typeof v[i] === 'object' && !v[i].toDate) await walk(v[i], `${pathPrefix}${k}.${i}.`, out);
      } }
      else if (v && typeof v === 'object' && !v.toDate && pathPrefix.split('.').length < 5) await walk(v, pathPrefix + k + '.', out);
    }
  };

  for (const col of (cols.length ? cols : DEFAULT_COLS)) {
    const snap = await db.collection(col).get();
    let n = 0;
    for (const d of snap.docs) {
      const out = [];
      await walk(d.data(), '', out);
      if (!out.length) continue;
      n += out.length; changed += out.length;
      backup.push({ col, id: d.id, fields: out.map(([f, oldV]) => ({ field: f, old: oldV })) });
      if (APPLY) {
        const update = {};
        for (const [f, , nv] of out) update[f] = nv; // 巢狀欄位用點路徑；陣列元素需整個陣列重寫（此腳本只處理常見的單層／物件欄位）
        const arrFields = out.filter(([f]) => /\.\d+(\.|$)/.test(f));
        if (arrFields.length) { console.log('  ⚠ 含陣列內網址，略過需手動處理：', col, d.id, arrFields.map(x => x[0]).join(',')); continue; }
        await d.ref.update({ ...update, storageUrlResignedAt: new Date() });
      }
    }
    console.log(`${col}: 掃 ${snap.size} 筆，需重簽 ${n} 個欄位`);
  }
  if (APPLY && backup.length) {
    const file = `./resign-backup-${Date.now()}.json`;
    fs.writeFileSync(file, JSON.stringify(backup, null, 1));
    console.log('已備份改前網址到', file);
  }
  console.log(APPLY ? `完成：重簽 ${changed} 個欄位，失敗 ${failed}` : `（試算）將重簽 ${changed} 個欄位，檔案不存在 ${failed}；加 --apply 才會寫入`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
