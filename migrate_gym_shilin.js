/**
 * Migration：gym-zhubei → gym-shilin（竹北館 → 士林館）
 *
 * 將 Firestore 內所有對舊場館 id 的參照搬移到新 id，並修正殘留的「竹北館」顯示文字。
 * Firestore 文件 id 無法直接改名，故 gyms/gym-zhubei 採「建新 doc + 刪舊 doc」。
 *
 * 用法：
 *   node migrate_gym_shilin.js          # dry-run，只列出將變更的內容，不寫入
 *   node migrate_gym_shilin.js --apply  # 實際寫入
 */
const admin = require('firebase-admin');
const path = require('path');

const OLD_ID = 'gym-zhubei';
const NEW_ID = 'gym-shilin';
const APPLY = process.argv.includes('--apply');

const serviceAccount = require(path.join(process.env.HOME, 'Downloads/redrock-dev-a35c1-firebase-adminsdk-fbsvc-94b5c692f3.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 遞迴轉換一個值：把舊 id 換成新 id、把「竹北館」換成「士林館」。
// 回傳 [新值, 是否有變更]。不深入 Timestamp / GeoPoint / DocumentReference 等非純物件。
function transform(val) {
  if (typeof val === 'string') {
    let next = val;
    if (next === OLD_ID) next = NEW_ID;
    if (next.includes('竹北館')) next = next.split('竹北館').join('士林館');
    return [next, next !== val];
  }
  if (Array.isArray(val)) {
    let changed = false;
    const out = val.map((v) => {
      const [nv, c] = transform(v);
      if (c) changed = true;
      return nv;
    });
    return [out, changed];
  }
  if (val && typeof val === 'object' && val.constructor === Object) {
    let changed = false;
    const out = {};
    for (const k of Object.keys(val)) {
      const [nv, c] = transform(val[k]);
      if (c) changed = true;
      out[k] = nv;
    }
    return [out, changed];
  }
  return [val, false];
}

// 批次寫入（Firestore 單一 batch 上限 500 ops）
function makeBatcher() {
  let batch = db.batch();
  let n = 0;
  let total = 0;
  return {
    async set(ref, data) { batch.set(ref, data); if (++n >= 450) await this.flush(); total++; },
    async update(ref, data) { batch.update(ref, data); if (++n >= 450) await this.flush(); total++; },
    async delete(ref) { batch.delete(ref); if (++n >= 450) await this.flush(); total++; },
    async flush() { if (n > 0) { await batch.commit(); batch = db.batch(); n = 0; } },
    get total() { return total; },
  };
}

async function main() {
  console.log(`\n🔧 Migration ${OLD_ID} → ${NEW_ID}  [${APPLY ? 'APPLY 實際寫入' : 'DRY-RUN 僅預覽'}]\n`);
  const batcher = makeBatcher();
  const summary = {};

  // ── Step 1：gyms 場館文件（id 不可改 → 建新刪舊）─────────────────
  const oldGymRef = db.collection('gyms').doc(OLD_ID);
  const newGymRef = db.collection('gyms').doc(NEW_ID);
  const [oldSnap, newSnap] = await Promise.all([oldGymRef.get(), newGymRef.get()]);

  if (oldSnap.exists) {
    const [migrated] = transform(oldSnap.data());
    if (typeof migrated.address === 'string') {
      migrated.address = migrated.address.replace('新竹縣竹北市', '台北市士林區');
    }
    migrated.updatedAt = new Date();
    console.log(`📍 gyms：建立 ${NEW_ID}（name="${migrated.name}", shortName="${migrated.shortName}"）並刪除 ${OLD_ID}`);
    if (newSnap.exists) console.log(`   ⚠️  ${NEW_ID} 已存在，將被覆寫`);
    if (APPLY) { await batcher.set(newGymRef, migrated); await batcher.delete(oldGymRef); }
  } else if (newSnap.exists) {
    console.log(`📍 gyms：${OLD_ID} 不存在、${NEW_ID} 已存在 → 場館文件已是新狀態，跳過`);
  } else {
    console.log(`📍 gyms：找不到 ${OLD_ID} 也找不到 ${NEW_ID} ⚠️（資料可能不在此環境）`);
  }

  // ── Step 2：掃描所有 top-level collection 的欄位參照 ─────────────
  const collections = await db.listCollections();
  for (const col of collections) {
    if (col.id === 'gyms') continue; // 場館文件已在 Step 1 處理
    const snap = await col.get();
    for (const doc of snap.docs) {
      const [migrated, changed] = transform(doc.data());
      if (!changed) continue;
      summary[col.id] = (summary[col.id] || 0) + 1;
      if (APPLY) await batcher.set(doc.ref, migrated);
    }
  }

  await batcher.flush();

  // ── 報告 ──────────────────────────────────────────────────────
  console.log('\n📊 各 collection 受影響文件數：');
  const keys = Object.keys(summary).sort();
  if (keys.length === 0) console.log('   （無欄位參照需更新）');
  for (const k of keys) console.log(`   ${k.padEnd(22)} ${summary[k]}`);
  const fieldDocs = keys.reduce((s, k) => s + summary[k], 0);
  console.log(`\n   欄位參照文件合計：${fieldDocs}`);

  if (APPLY) {
    console.log(`\n✅ 已寫入（含 gyms 建/刪），batch ops 約 ${batcher.total}`);
  } else {
    console.log('\nℹ️  這是 dry-run，未寫入。確認無誤後執行： node migrate_gym_shilin.js --apply');
  }
  console.log('\n⚠️  注意：本腳本只掃描 top-level collection，不含 subcollection。');
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
