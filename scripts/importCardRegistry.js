/**
 * 匯入實體卡號清冊（黑卡/優惠卡）到 Firestore physicalCardRegistry，供「可綁定卡號」白名單驗證使用。
 *
 * 資料來源：使用者維護的 Excel（每個字軌一個工作表，欄位為「票號／銷售／使用」），本機路徑見下方
 * DEFAULT_FILE。正式環境（Railway）完全讀不到這個檔案——這支腳本只在本機執行一次，把資料同步進
 * Firestore；之後 /cards/discount/bind、/cards/black/bind 的白名單檢查只查 Firestore，跟這個
 * Excel 檔案無關（使用者之後更新 Excel，要重新同步時再重跑這支腳本即可，不用改任何程式碼）。
 *
 * 字軌辨識：工作表名開頭 AT/ST → cardType='black'；開頭 D+數字 → cardType='discount'；其他一律跳過
 * （此活頁簿裡還有幾張跟卡號無關的年度銷售明細表，如「11506」「11701」「21506」，會被正確忽略）。
 * 空白（尚未整理）的字軌（rowCount<2）也會跳過，例如目前 D19/D21/D24 尚未填寫。
 *
 * 冪等：卡號正規化（去除破折號/空白、轉大寫，與 src/utils/cardBarcode.js 同一套規則）後當文件 id，
 * 用 .set(...,{merge:true}) 寫入——可重複執行同步「使用」欄位最新狀態。
 *
 * 用法（redrock-api 目錄下）：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importCardRegistry.js
 *   寫入：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importCardRegistry.js --commit
 *   只匯入指定字軌：... node scripts/importCardRegistry.js --commit --series=AT19,ST19
 *   只匯入某字軌的部分號碼區間（使用者分批整理完成時用，如「D21-0001~D21-0600 已整理好」但
 *   後段尚未確認）：... node scripts/importCardRegistry.js --commit --series=D21 --range=1-600
 *   （--range 只在單一 --series 時有意義，號碼比對用去除字軌前綴後的純數字部分）
 *   自訂檔案路徑：... node scripts/importCardRegistry.js /path/to/file.xlsx --commit
 */
const ExcelJS = require('exceljs');
const { initFirebase, getDb } = require('../src/config/firebase');
const { normalizeBarcode } = require('../src/utils/cardBarcode');

const DEFAULT_FILE = '/Users/wanghongxiang/Library/CloudStorage/OneDrive-個人/文件/兩館共用/票卡使用紀錄.xlsx';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const filePath = args.find(a => !a.startsWith('--')) || DEFAULT_FILE;
const seriesFilterArg = args.find(a => a.startsWith('--series='));
const seriesFilter = seriesFilterArg ? seriesFilterArg.split('=')[1].split(',').map(s => s.trim().toUpperCase()) : null;
const rangeArg = args.find(a => a.startsWith('--range='));
const range = rangeArg ? (() => {
  const [from, to] = rangeArg.split('=')[1].split('-').map(n => parseInt(n, 10));
  return { from, to };
})() : null;

const COLLECTION = 'physicalCardRegistry';

function cardTypeOf(seriesName) {
  if (/^AT|^ST/i.test(seriesName)) return 'black';
  if (/^D\d/i.test(seriesName)) return 'discount';
  return null;
}

(async () => {
  initFirebase();
  const db = getDb();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  console.log(`讀取檔案：${filePath}\n`);

  let totalRows = 0, written = 0;

  for (const ws of wb.worksheets) {
    const seriesName = ws.name.trim();
    const cardType = cardTypeOf(seriesName);
    if (!cardType) continue; // 非卡號字軌（如年度銷售明細表），跳過
    if (seriesFilter && !seriesFilter.includes(seriesName.toUpperCase())) continue;
    if (ws.rowCount < 2) { console.log(`${seriesName}：尚無資料，跳過`); continue; }

    const header = ws.getRow(1).values;
    const numberCol = header.findIndex(v => v === '票號');
    const soldCol = header.findIndex(v => v === '銷售');
    const boundCol = header.findIndex(v => v === '使用');
    if (numberCol < 0) { console.warn(`⚠ ${seriesName} 找不到「票號」欄，跳過`); continue; }

    let seriesRows = 0, seriesSold = 0, seriesBound = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r).values;
      const rawNumber = row[numberCol];
      if (!rawNumber) continue;
      const sold = soldCol > 0 ? String(row[soldCol] || '').trim().toLowerCase() === 'sold' : false;
      const bound = boundCol > 0 ? String(row[boundCol] || '').trim().toLowerCase() === 'used' : false;
      const id = normalizeBarcode(rawNumber);

      if (range) {
        // 字軌前綴本身常含數字（如 D21、AT19），不能用「結尾連續數字」regex 抓序號（會把前綴的數字也
        // 吃進去）——改用「去掉已知字軌前綴後剩下的部分」精確取序號。
        const prefix = normalizeBarcode(seriesName);
        const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : null;
        const num = suffix ? parseInt(suffix, 10) : null;
        if (num == null || Number.isNaN(num) || num < range.from || num > range.to) continue; // 不在指定區間，跳過（不寫入、不計入統計）
      }

      seriesRows++; totalRows++;
      if (sold) seriesSold++;
      if (bound) seriesBound++;

      if (COMMIT) {
        await db.collection(COLLECTION).doc(id).set({
          id, rawNumber: String(rawNumber).trim(), series: seriesName, cardType,
          sold, bound, updatedAt: new Date(),
        }, { merge: true });
        written++;
      }
    }
    console.log(`${seriesName}（${cardType}）：共 ${seriesRows} 筆，已售出 ${seriesSold}，已綁定 ${seriesBound}，未綁定 ${seriesSold - seriesBound}`);
  }

  console.log(`\n總計掃描 ${totalRows} 筆` + (COMMIT ? `，已寫入 ${written} 筆。` : '（預覽模式，未寫入 Firestore；加 --commit 才會實際匯入）'));
})().catch(e => { console.error(e); process.exit(1); });
