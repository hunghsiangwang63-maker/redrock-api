// ── 比賽簽到表暨保險名冊：PDF 輸出（pdfmake，純 JS、無需 LibreOffice/headless Chrome）──
// 中文字型：bundle 隨附的 Noto Sans TC（OFL 授權，src/assets/fonts/），否則中文會變空白方塊。
const path = require('path');
const PdfPrinter = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const fs = require('fs');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTC-Regular.ttf');
const FONTS = { NotoSansTC: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH } };

function getPrinter() {
  const resolver = new URLResolver(fs);
  return new PdfPrinter(FONTS, null, resolver, () => true);
}

// pdfmake 的 table 沒有直接的「置中」屬性，用左右各一個彈性欄位夾住固定寬度的表格達成水平置中。
function centerBlock(tableDef) {
  return { columns: [{ width: '*', text: '' }, { width: 'auto', ...tableDef }, { width: '*', text: '' }] };
}

function insuranceTableDef(insurance) {
  const body = [
    [{ text: '承保範圍', rowSpan: insurance.rows.length + 1, alignment: 'center', bold: true, fillColor: '#E0E0E0' },
      { text: '可投保年齡', colSpan: 2, alignment: 'center', fillColor: '#E0E0E0' }, {},
      { text: insurance.ageLabelUnder, colSpan: 2, alignment: 'center', fillColor: '#E0E0E0' }, {},
      { text: insurance.ageLabelOver, colSpan: 3, alignment: 'center', fillColor: '#E0E0E0' }, {}, {}],
  ];
  insurance.rows.forEach(r => {
    body.push([
      {}, // rowSpan 佔位
      { text: r.label, colSpan: 2, alignment: 'center', color: 'red' }, {},
      { text: r.under, colSpan: 2, alignment: 'center', color: 'red' }, {},
      { text: r.over, colSpan: 3, alignment: 'center', color: 'red' }, {}, {},
    ]);
  });
  return {
    table: { widths: [45, 33, 33, 33, 33, 27, 27, 27], body },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
    margin: [0, 4, 0, 10],
  };
}

function signatureCell(row) {
  const imgs = [row.memberSignatureUrl, row.guardianSignatureUrl].filter(Boolean);
  if (!imgs.length) return { text: '', margin: [0, 12, 0, 12] };
  return {
    columns: imgs.map(src => ({ image: src, width: imgs.length > 1 ? 45 : 90, height: 28 })),
    columnGap: 2,
  };
}

function dataTableDef(rows) {
  const headers = ['No.', '姓名', '性別', '身份字號', '民國生日', '簽名', '備註', '組別'].map(h => ({ text: h, bold: true, alignment: 'center', fillColor: '#BFBFBF' }));
  const body = [headers];
  rows.forEach(r => {
    body.push([
      { text: String(r.no), alignment: 'center' },
      { text: r.name, alignment: 'center' },
      { text: r.gender, alignment: 'center' },
      { text: r.idNumber, alignment: 'center', fontSize: 8 },
      { text: r.birthdayRoc, alignment: 'center' },
      signatureCell(r),
      { text: r.note, alignment: 'center', fontSize: 8 },
      { text: r.divisionName, alignment: 'center', fontSize: 8 },
    ]);
  });
  return {
    table: { headerRows: 1, widths: [22, 45, 22, 55, 45, 100, 45, 55], body },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
  };
}

function buildSheetContent(title, insurance, rows, pageBreakBefore) {
  return [
    { text: title, bold: true, fontSize: 13, alignment: 'center', margin: [0, 0, 0, 6], ...(pageBreakBefore ? { pageBreak: 'before' } : {}) },
    centerBlock(insuranceTableDef(insurance)),
    rows.length ? centerBlock(dataTableDef(rows)) : { text: '（無資料）', italics: true, color: '#999', alignment: 'center' },
  ];
}

async function buildCompetitionInsurancePdfBuffer({ titleBase, insurance, adults, minors }) {
  const printer = getPrinter();
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 9 },
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [24, 24, 24, 24],
    content: [
      ...buildSheetContent(`${titleBase}（成人）`, insurance, adults, false),
      ...buildSheetContent(`${titleBase}（未成年）`, insurance, minors, true),
    ],
  };
  const pdfDoc = await printer.createPdfKitDocument(docDefinition);
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', c => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

module.exports = { buildCompetitionInsurancePdfBuffer };
