// ── 比賽簽到表暨保險名冊：xlsx 輸出（exceljs，支援嵌入簽名圖片）──────────────
const ExcelJS = require('exceljs');

const COLS = 8; // No / 姓名 / 性別 / 身份字號 / 民國生日 / 簽名 / 備註 / 組別
const HEADER_LABELS = ['No.', '姓名', '性別', '身份字號', '民國生日', '簽名', '備註', '組別'];
const SIG_COL = 6; // 「簽名」是第 6 欄（1-based）

function extFromDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,/.exec(dataUrl || '');
  if (!m) return null;
  return m[1] === 'jpg' ? 'jpeg' : m[1];
}

// 在指定列的「簽名」欄嵌入 1~2 張圖（參賽者本人 + 未成年時的法定代理人），左右並排
function addSignatureImages(workbook, ws, rowIdx, memberSig, guardianSig) {
  const imgs = [memberSig, guardianSig].filter(Boolean);
  if (!imgs.length) return;
  const rowTop = rowIdx - 1, rowBottom = rowIdx; // exceljs 圖片錨點用 0-based row/col
  const colLeft = SIG_COL - 1, colRight = SIG_COL; // 0-based：欄位 F(=5) 佔滿 [5,6)
  imgs.forEach((dataUrl, i) => {
    const ext = extFromDataUrl(dataUrl);
    if (!ext) return; // 非圖片格式（理論上不會發生，防呆）
    const imgId = workbook.addImage({ base64: dataUrl, extension: ext });
    const half = (colRight - colLeft) / imgs.length;
    ws.addImage(imgId, {
      tl: { col: colLeft + i * half, row: rowTop + 0.05 },
      br: { col: colLeft + (i + 1) * half, row: rowBottom - 0.05 },
      editAs: 'oneCell',
    });
  });
}

function buildInsuranceHeaderRows(ws, insurance, startRow) {
  // 承保範圍（B~H 依 8 欄配置，A 欄放「承保範圍」垂直合併標籤）
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
  ws.mergeCells(startRow, 6, startRow, 8);
  ws.getCell(startRow, 2).value = '可投保年齡';
  ws.getCell(startRow, 4).value = insurance.ageLabelUnder;
  ws.getCell(startRow, 6).value = insurance.ageLabelOver;
  for (let c = 2; c <= 8; c++) {
    const cell = ws.getCell(startRow, c);
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    cell.font = { color: { argb: 'FFCC0000' } };
  }

  insurance.rows.forEach((r, i) => {
    const row = startRow + 1 + i;
    ws.mergeCells(row, 2, row, 3);
    ws.mergeCells(row, 4, row, 5);
    ws.mergeCells(row, 6, row, 8);
    ws.getCell(row, 2).value = r.label;
    ws.getCell(row, 4).value = r.under;
    ws.getCell(row, 6).value = r.over;
    for (let c = 2; c <= 8; c++) {
      const cell = ws.getCell(row, c);
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.font = { color: { argb: 'FFCC0000' } };
    }
  });
  return startRow + nRows + 1; // 回傳下一個可用列
}

function writeSheet(workbook, sheetName, title, insurance, rows) {
  const ws = workbook.addWorksheet(sheetName);
  for (let c = 1; c <= COLS; c++) ws.getColumn(c).width = c === SIG_COL ? 20 : (c === 2 ? 12 : 10);

  // 標題列
  ws.mergeCells(1, 1, 1, COLS);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 26;

  // 承保範圍表
  const nextRow = buildInsuranceHeaderRows(ws, insurance, 3);

  // 表頭
  const headerRow = nextRow + 1;
  HEADER_LABELS.forEach((label, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = label;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
  });

  // 資料列
  rows.forEach((r, i) => {
    const rowIdx = headerRow + 1 + i;
    ws.getRow(rowIdx).height = 46;
    ws.getCell(rowIdx, 1).value = r.no;
    ws.getCell(rowIdx, 2).value = r.name;
    ws.getCell(rowIdx, 3).value = r.gender;
    ws.getCell(rowIdx, 4).value = r.idNumber;
    ws.getCell(rowIdx, 5).value = r.birthdayRoc;
    ws.getCell(rowIdx, 7).value = r.note;
    ws.getCell(rowIdx, 8).value = r.divisionName;
    for (let c = 1; c <= COLS; c++) {
      ws.getCell(rowIdx, c).alignment = { vertical: 'middle', horizontal: 'center' };
    }
    addSignatureImages(workbook, ws, rowIdx, r.memberSignatureUrl, r.guardianSignatureUrl);
  });

  // 外框線（簡單版：整個資料範圍加細框線）
  const lastRow = headerRow + rows.length;
  for (let row = 1; row <= lastRow; row++) {
    for (let c = 1; c <= COLS; c++) {
      ws.getCell(row, c).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    }
  }
}

async function buildCompetitionInsuranceXlsxBuffer({ titleBase, insurance, adults, minors }) {
  const workbook = new ExcelJS.Workbook();
  writeSheet(workbook, '成人', `${titleBase}（成人）`, insurance, adults);
  writeSheet(workbook, '未成年', `${titleBase}（未成年）`, insurance, minors);
  return workbook.xlsx.writeBuffer();
}

module.exports = { buildCompetitionInsuranceXlsxBuffer };
