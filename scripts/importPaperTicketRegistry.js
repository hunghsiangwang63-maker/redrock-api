/**
 * 匯入紙本單張入場券清冊（票卡使用紀錄.xlsx 的 11506／11701／21506 工作表）到 Firestore paperTickets。
 *
 * 規則：票號＝工作表名（字軌）＋4 碼流水號（流水號欄會帶引號如 "0123"，只取數字）；
 *  11506 工作表內混有誤植的「11501」前綴，一律以工作表名為準。
 *  銷售欄 sell／sold 都是「已售出」；使用欄為 used＝已使用（匯入的舊資料標 usedLegacy:true、沒有 usedAt）。
 *
 * 只新增、不覆蓋：已存在的票號（可能已在系統內登記過使用）一律略過，所以可以重複執行。
 *
 * 用法（redrock-api 目錄下）：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importPaperTicketRegistry.js
 *   寫入：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importPaperTicketRegistry.js --commit
 *   自訂檔案：... node scripts/importPaperTicketRegistry.js /path/to/file.xlsx --commit
 */
const ExcelJS = require('exceljs');
const { initFirebase, getDb } = require('../src/config/firebase');
const { COLLECTION, DEFAULT_SERIES } = require('../src/services/paperTicketService');

const DEFAULT_FILE = '/Users/wanghongxiang/Library/CloudStorage/OneDrive-個人/文件/兩館共用/票卡使用紀錄.xlsx';
const args = process.argv.slice(2);
const commit = args.includes('--commit');
const file = args.find((a) => !a.startsWith('--')) || DEFAULT_FILE;

const cellText = (c) => {
  const v = c && c.value;
  if (v == null) return '';
  if (typeof v === 'object') return String(v.result ?? v.text ?? '');
  return String(v);
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const docs = new Map(); // id → data
  const stat = {};
  for (const series of DEFAULT_SERIES) {
    const ws = wb.getWorksheet(series);
    if (!ws) { console.log(`⚠️ 找不到工作表 ${series}，略過`); continue; }
    const s = { rows: 0, sold: 0, used: 0, skippedNoSerial: 0, dup: 0 };
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const cells = row.values.slice(1).map((c) => (c && typeof c === 'object' ? String(c.result ?? c.text ?? '') : (c == null ? '' : String(c))));
      // 流水號：優先看第 2 欄（4 碼，帶引號如 "0123"）；沒有的列（11701 工作表 7442 列起）用第 3～4 欄的完整票號取最後 4 碼
      let serial = String(cells[1] || '').replace(/\D/g, '');
      if (serial.length !== 4) {
        const full = [cells[2], cells[3]].map((x) => String(x || '').replace(/\D/g, '')).find((d) => d.length === 9);
        serial = full ? full.slice(5) : '';
        // 11701 工作表 8083～8370 列的完整票號欄只剩流水號本身（如 8084）→ 補零成 4 碼
        if (!serial) {
          const short = [cells[2], cells[3]].map((x) => String(x || '').replace(/\D/g, '')).find((d) => d.length >= 1 && d.length <= 4);
          serial = short ? short.padStart(4, '0') : '';
        }
      }
      if (serial.length !== 4) { if (cells.some(Boolean)) s.skippedNoSerial++; return; }
      s.rows++;
      const rest = cells.slice(2).map((x) => x.trim().toLowerCase());
      const sold = rest.includes('sell') || rest.includes('sold');
      const used = rest.includes('used');
      const id = `${series}${serial}`;
      if (docs.has(id)) { s.dup++; (s.dupIds = s.dupIds || []).push(`${id}(第${n}列)`); return; }
      if (sold) s.sold++;
      if (used) s.used++;
      const note = [cells[5], cells[6]].map((x) => String(x || '').trim()).find((x) => x && !['sell', 'sold', 'used'].includes(x.toLowerCase())) || null;
      docs.set(id, { ticketNo: id, series, serial, sold, used, usedLegacy: used, source: 'xlsx-import', sheetNote: note, importedAt: new Date() });
    });
    const nums = [...docs.keys()].filter((k) => k.startsWith(series)).map((k) => +k.slice(5));
    const missing = []; for (let n = 0; n <= Math.max(...nums); n++) if (!docs.has(series + String(n).padStart(4, '0'))) missing.push(n);
    s.missingSerials = missing.length ? missing.slice(0, 20) : 0; s.maxSerial = Math.max(...nums);
    stat[series] = s;
  }
  console.log('解析結果：', JSON.stringify(stat));
  console.log('共', docs.size, '張票');
  if (!commit) { console.log('（預覽模式，未寫入。加 --commit 才會寫入）'); process.exit(0); }

  initFirebase();
  const db = getDb();
  // 已存在的票號略過（不覆蓋系統內已登記的使用狀態）
  const existing = new Set();
  const snap = await db.collection(COLLECTION).select().get();
  snap.forEach((d) => existing.add(d.id));
  const toWrite = [...docs.entries()].filter(([id]) => !existing.has(id));
  console.log('清冊已存在', existing.size, '張；本次新增', toWrite.length, '張');
  for (let i = 0; i < toWrite.length; i += 400) {
    const batch = db.batch();
    for (const [id, data] of toWrite.slice(i, i + 400)) batch.set(db.collection(COLLECTION).doc(id), data);
    await batch.commit();
    process.stdout.write(`\r已寫入 ${Math.min(i + 400, toWrite.length)}/${toWrite.length}`);
  }
  await db.collection('systemSettings').doc('paperTicketSeries').set({ series: DEFAULT_SERIES, updatedAt: new Date() }, { merge: true });
  console.log('\n✅ 完成');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
