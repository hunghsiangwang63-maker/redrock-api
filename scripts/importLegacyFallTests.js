/**
 * 舊系統（Climbio）墜測效期遷移匯入
 * 從匯出檔挑出「墜測仍在效期內」的會員 → 寫入 Firestore `legacyFallTests`
 * 之後會員在新系統重新註冊（電話+姓名相符）即自動認領、免重測（一次性）。
 *
 * 用法：
 *   預覽（不寫入）：
 *     GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json \
 *     node scripts/importLegacyFallTests.js "/path/Climbio匯出.xlsx" \
 *       --phone=電話 --name=姓名 --expiry=墜測到期日 [--sheet=0]
 *   實際寫入：加 --commit
 *
 * 欄名可用「中文標題」或欄位代號(A/B/C..)。expiry 支援 YYYY-MM-DD / YYYY/MM/DD / Excel 日期序號 / 民國 YYY-MM-DD。
 * 規則：只匯到期日 >= 今天者；同電話取「最晚到期日」；doc id = 電話（重跑會更新、不重複）。
 */
const path = require('path');
const XLSX = require('xlsx');
const { initFirebase, getDb } = require('../src/config/firebase');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const COMMIT = args.includes('--commit');
const COL = { phone: opt('phone') || '電話', name: opt('name') || '姓名', expiry: opt('expiry') || '墜測到期日' };
const SHEET = parseInt(opt('sheet') || '0', 10);

if (!file) { console.error('請提供匯出檔路徑。範例見檔頭註解。'); process.exit(1); }

const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// 解析各種日期格式 → 'YYYY-MM-DD'（或 null）
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') { // Excel 日期序號
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  let s = String(v).trim().replace(/\//g, '-').replace(/\./g, '-');
  let m = s.match(/^(\d{2,4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  let [, y, mo, d] = m;
  y = parseInt(y, 10); if (y < 1911) y += 1911; // 民國 → 西元
  return `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}
const cleanPhone = v => String(v == null ? '' : v).replace(/[\s-]/g, '').trim();
const cleanName = v => String(v == null ? '' : v).trim();

(async () => {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[SHEET]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) { console.error('讀不到資料列。確認 --sheet 與檔案內容。'); process.exit(1); }
  console.log(`讀取 ${wb.SheetNames[SHEET]}：${rows.length} 列；欄位範例：`, Object.keys(rows[0]).join(' | '));
  console.log(`對應欄位：電話=${COL.phone}  姓名=${COL.name}  到期日=${COL.expiry}\n`);

  const byPhone = {};
  let total = 0, noPhone = 0, noExpiry = 0, expired = 0, valid = 0;
  for (const r of rows) {
    total++;
    const phone = cleanPhone(r[COL.phone]); const name = cleanName(r[COL.name]); const exp = parseDate(r[COL.expiry]);
    if (!phone) { noPhone++; continue; }
    if (!exp) { noExpiry++; continue; }
    if (exp < today) { expired++; continue; }
    valid++;
    if (!byPhone[phone] || exp > byPhone[phone].fallTestExpiresAt) byPhone[phone] = { phone, name, fallTestExpiresAt: exp };
  }
  const list = Object.values(byPhone);
  console.log(`總列數 ${total}｜無電話 ${noPhone}｜無到期日 ${noExpiry}｜已過期(略) ${expired}｜效期內 ${valid}｜去重後 ${list.length} 筆\n`);
  console.log('前 5 筆預覽：'); list.slice(0, 5).forEach(x => console.log(`  ${x.name} / ${x.phone} → ${x.fallTestExpiresAt}`));

  if (!COMMIT) { console.log('\n（預覽模式，未寫入。確認無誤後加 --commit 實際匯入。）'); process.exit(0); }

  initFirebase(); const db = getDb();
  let n = 0;
  for (let i = 0; i < list.length; i += 400) {
    const batch = db.batch();
    list.slice(i, i + 400).forEach(x => {
      batch.set(db.collection('legacyFallTests').doc(x.phone), {
        phone: x.phone, name: x.name, fallTestExpiresAt: x.fallTestExpiresAt,
        claimed: false, source: 'climbio', importedAt: new Date(),
      }, { merge: true });
      n++;
    });
    await batch.commit();
  }
  console.log(`\n✅ 已寫入 legacyFallTests ${n} 筆。`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
