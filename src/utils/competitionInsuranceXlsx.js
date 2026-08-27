// ── 比賽簽到表暨保險名冊：xlsx 輸出（exceljs，支援嵌入簽名圖片）──────────────
// 2026-08-27 改版：一組一 sheet（成人各組別/未成年）；成人 8 欄（單一簽名欄）、
// 未成年 10 欄（加組別欄；簽名拆「選手簽名／法定代理人簽名」兩獨立欄同時呈現，缺者留白供現場補簽）；
// 表頭（標題+承保範圍+欄位列）設為列印標題列（每頁重複印）；每 20 位選手強制分頁；
// 承保範圍文字 shrinkToFit（不換行、自動縮字到欄寬內完整一句）。
const ExcelJS = require('exceljs');

const ROWS_PER_PAGE = 20; // 每頁選手數（列印分頁）

// 每張 sheet 的欄位配置：成人＝單一簽名欄；未成年＝加組別欄＋選手/法定代理人兩簽名欄。
// rowValues 與 headers 一一對應（簽名欄給 null、由圖片嵌入），加減欄位改這裡即可。
function layoutFor(isMinor) {
  if (isMinor) return {
    cols: 10,
    headers: ['序號', '背號', '姓名', '組別', '性別', '身份證字號', '民國生日', '選手簽名', '法定代理人簽名', '發票金額'],
    widths: [6, 8, 12, 11, 6, 14, 11, 15, 15, 10],
    memberSigCol: 8, guardianSigCol: 9,
    rowValues: (r) => [r.no, r.bib, r.name, r.divisionName, r.gender, r.idNumber, r.birthdayRoc, null, null, r.invoiceAmount],
  };
  return {
    cols: 8,
    headers: ['序號', '背號', '姓名', '性別', '身份證字號', '民國生日', '簽名', '發票金額'],
    widths: [6, 8, 12, 6, 14, 11, 20, 10],
    memberSigCol: 7, guardianSigCol: null,
    rowValues: (r) => [r.no, r.bib, r.name, r.gender, r.idNumber, r.birthdayRoc, null, r.invoiceAmount],
  };
}

function extFromDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,/.exec(dataUrl || '');
  if (!m) return null;
  return m[1] === 'jpg' ? 'jpeg' : m[1];
}

// 在指定列的指定欄嵌入一張簽名圖（佔滿該儲存格）
function addSignatureImage(workbook, ws, rowIdx, col, dataUrl) {
  if (!dataUrl) return;
  const ext = extFromDataUrl(dataUrl);
  if (!ext) return; // 非圖片格式（理論上不會發生，防呆）
  const imgId = workbook.addImage({ base64: dataUrl, extension: ext });
  ws.addImage(imgId, {
    tl: { col: col - 1, row: rowIdx - 1 + 0.05 }, // exceljs 圖片錨點用 0-based row/col
    br: { col: col, row: rowIdx - 0.05 },
    editAs: 'oneCell',
  });
}

// 承保範圍文字一律不換行、縮小字級到欄寬內完整一句（shrinkToFit 與 wrapText 互斥，明確關掉換行）
const SHRINK_ALIGN = { vertical: 'middle', horizontal: 'center', wrapText: false, shrinkToFit: true };

function buildInsuranceHeaderRows(ws, insurance, startRow, cols) {
  // 承保範圍（B 起依欄數配置，A 欄放「承保範圍」垂直合併標籤；末段吃滿剩餘欄位）
  const nRows = insurance.rows.length; // +1（可投保年齡那列）
  ws.mergeCells(startRow, 1, startRow + nRows, 1);
  const capCell = ws.getCell(startRow, 1);
  capCell.value = '承保範圍';
  capCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  capCell.font = { bold: true };
  capCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

  // 「可投保年齡」列
  ws.mergeCells(startRow, 2, startRow, 3);
  ws.mergeCells(startRow, 4, startRow, 5);
  ws.mergeCells(startRow, 6, startRow, cols);
  ws.getCell(startRow, 2).value = '可投保年齡';
  ws.getCell(startRow, 4).value = insurance.ageLabelUnder;
  ws.getCell(startRow, 6).value = insurance.ageLabelOver;
  for (let c = 2; c <= cols; c++) {
    const cell = ws.getCell(startRow, c);
    cell.alignment = SHRINK_ALIGN;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    cell.font = { color: { argb: 'FFCC0000' } };
  }

  insurance.rows.forEach((r, i) => {
    const row = startRow + 1 + i;
    ws.mergeCells(row, 2, row, 3);
    ws.mergeCells(row, 4, row, 5);
    ws.mergeCells(row, 6, row, cols);
    ws.getCell(row, 2).value = r.label;
    ws.getCell(row, 4).value = r.under;
    ws.getCell(row, 6).value = r.over;
    for (let c = 2; c <= cols; c++) {
      const cell = ws.getCell(row, c);
      cell.alignment = SHRINK_ALIGN;
      cell.font = { color: { argb: 'FFCC0000' } };
    }
  });
  return startRow + nRows + 1; // 回傳下一個可用列
}

function writeSheet(workbook, sheetName, title, insurance, rows, isMinor) {
  const L = layoutFor(isMinor);
  // sheet 名稱去除 xlsx 不允許的字元、上限 31 字
  const safeName = String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const ws = workbook.addWorksheet(safeName);
  L.widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // 標題列
  ws.mergeCells(1, 1, 1, L.cols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { ...SHRINK_ALIGN }; // 標題也縮字不換行（列印每頁重複、要一行完整）
  ws.getRow(1).height = 26;

  // 承保範圍表
  const nextRow = buildInsuranceHeaderRows(ws, insurance, 3, L.cols);

  // 表頭
  const headerRow = nextRow + 1;
  L.headers.forEach((label, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = label;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false, shrinkToFit: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
  });

  // 列印設定：標題+承保範圍+欄位列（第 1~headerRow 列）每頁重複印；A4 直式、寬度縮放到一頁
  ws.pageSetup = {
    paperSize: 9, orientation: 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printTitlesRow: `1:${headerRow}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };

  // 資料列（每 ROWS_PER_PAGE 位選手強制分頁）
  rows.forEach((r, i) => {
    const rowIdx = headerRow + 1 + i;
    ws.getRow(rowIdx).height = 46;
    L.rowValues(r).forEach((v, ci) => { if (v != null) ws.getCell(rowIdx, ci + 1).value = v; });
    for (let c = 1; c <= L.cols; c++) {
      ws.getCell(rowIdx, c).alignment = { vertical: 'middle', horizontal: 'center' };
    }
    // 簽名：未成年＝選手/法定代理人各自獨立欄同時呈現（缺者留白供現場補簽）；成人＝單一簽名欄
    addSignatureImage(workbook, ws, rowIdx, L.memberSigCol, r.memberSignatureUrl);
    if (L.guardianSigCol) addSignatureImage(workbook, ws, rowIdx, L.guardianSigCol, r.guardianSignatureUrl);
    if ((i + 1) % ROWS_PER_PAGE === 0 && i + 1 < rows.length) ws.getRow(rowIdx).addPageBreak();
  });

  // 外框線（簡單版：整個資料範圍加細框線）
  const lastRow = headerRow + rows.length;
  for (let row = 1; row <= lastRow; row++) {
    for (let c = 1; c <= L.cols; c++) {
      ws.getCell(row, c).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    }
  }
}

async function buildCompetitionInsuranceXlsxBuffer({ insurance, groups }) {
  const workbook = new ExcelJS.Workbook();
  groups.forEach(g => writeSheet(workbook, g.sheetName, g.title, insurance, g.rows, !!g.isMinorGroup));
  return workbook.xlsx.writeBuffer();
}

module.exports = { buildCompetitionInsuranceXlsxBuffer };
