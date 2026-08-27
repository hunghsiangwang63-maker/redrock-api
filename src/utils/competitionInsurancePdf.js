// ── 比賽簽到表暨保險名冊：PDF 輸出（pdfmake，純 JS、無需 LibreOffice/headless Chrome）──
// 中文字型：bundle 隨附的 Noto Sans TC（OFL 授權，src/assets/fonts/），否則中文會變空白方塊。
// 2026-08-27 改版：一組一段（成人各組別/未成年）；欄位 背號/姓名/性別/身份證字號/民國生日/簽名/發票金額；
// 每 20 位選手一頁、每頁都重複完整表頭（標題+承保範圍+欄位列）；承保範圍文字 noWrap 縮字不換行。
const path = require('path');
const PdfPrinter = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;
const fs = require('fs');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTC-Regular.ttf');
const FONTS = { NotoSansTC: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH } };

const ROWS_PER_PAGE = 20; // 每頁選手數

function getPrinter() {
  const resolver = new URLResolver(fs);
  return new PdfPrinter(FONTS, null, resolver, () => true);
}

// pdfmake 的 table 沒有直接的「置中」屬性，用左右各一個彈性欄位夾住固定寬度的表格達成水平置中。
function centerBlock(tableDef) {
  return { columns: [{ width: '*', text: '' }, { width: 'auto', ...tableDef }, { width: '*', text: '' }] };
}

function insuranceTableDef(insurance) {
  // 8 欄配置：承保範圍(1) + 標籤(2) + 未滿15(2) + 15以上(3)；年齡文字 noWrap+小字＝一行完整不換行
  const body = [
    [{ text: '承保範圍', rowSpan: insurance.rows.length + 1, alignment: 'center', bold: true, fillColor: '#E0E0E0' },
      { text: '可投保年齡', colSpan: 2, alignment: 'center', fillColor: '#E0E0E0' }, {},
      { text: insurance.ageLabelUnder, colSpan: 2, alignment: 'center', fillColor: '#E0E0E0', color: 'red', fontSize: 7, noWrap: true }, {},
      { text: insurance.ageLabelOver, colSpan: 3, alignment: 'center', fillColor: '#E0E0E0', color: 'red', fontSize: 7, noWrap: true }, {}, {}],
  ];
  insurance.rows.forEach(r => {
    body.push([
      {}, // rowSpan 佔位
      { text: r.label, colSpan: 2, alignment: 'center', color: 'red', fontSize: 8, noWrap: true }, {},
      { text: r.under, colSpan: 2, alignment: 'center', color: 'red' }, {},
      { text: r.over, colSpan: 3, alignment: 'center', color: 'red' }, {}, {},
    ]);
  });
  return {
    table: { widths: [40, 42, 42, 38, 38, 30, 30, 30], body },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
    margin: [0, 4, 0, 10],
  };
}

function sigImageCell(src, width) {
  if (!src) return { text: '', margin: [0, 12, 0, 12] }; // 留白供現場補簽
  return { image: src, width, height: 28, alignment: 'center' };
}

// 成人＝單一簽名欄；未成年＝「選手簽名／法定代理人簽名」兩獨立欄同時呈現（缺者留白供現場補簽）
function dataTableDef(rows, isMinor) {
  const headLabels = isMinor
    ? ['序號', '背號', '姓名', '組別', '性別', '身份證字號', '民國生日', '選手簽名', '法定代理人簽名', '發票金額']
    : ['序號', '背號', '姓名', '性別', '身份證字號', '民國生日', '簽名', '發票金額'];
  const headers = headLabels.map(h => ({ text: h, bold: true, alignment: 'center', fillColor: '#BFBFBF', fontSize: 8 }));
  const body = [headers];
  rows.forEach(r => {
    const base = [
      { text: String(r.no || ''), alignment: 'center' },
      { text: String(r.bib || ''), alignment: 'center' },
      { text: r.name, alignment: 'center' },
      ...(isMinor ? [{ text: r.divisionName || '', alignment: 'center', fontSize: 8 }] : []),
      { text: r.gender, alignment: 'center' },
      { text: r.idNumber, alignment: 'center', fontSize: 8 },
      { text: r.birthdayRoc, alignment: 'center' },
    ];
    const sig = isMinor
      ? [sigImageCell(r.memberSignatureUrl, 55), sigImageCell(r.guardianSignatureUrl, 55)]
      : [sigImageCell(r.memberSignatureUrl, 90)];
    body.push([...base, ...sig, { text: r.invoiceAmount != null ? String(r.invoiceAmount) : '', alignment: 'center' }]);
  });
  return {
    table: {
      headerRows: 1,
      widths: isMinor ? [18, 24, 40, 36, 18, 52, 40, 56, 56, 32] : [22, 28, 48, 22, 58, 45, 90, 42],
      body,
    },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
  };
}

// 每 ROWS_PER_PAGE 位一頁，每頁重複完整表頭（標題+承保範圍+欄位列）
function buildGroupContent(title, insurance, rows, isFirstGroup, isMinor) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) chunks.push(rows.slice(i, i + ROWS_PER_PAGE));
  if (!chunks.length) chunks.push([]); // 無資料仍出一頁（表頭＋無資料提示）
  const content = [];
  chunks.forEach((chunk, ci) => {
    const pageBreak = !(isFirstGroup && ci === 0);
    content.push({ text: title, bold: true, fontSize: 13, alignment: 'center', margin: [0, 0, 0, 6], ...(pageBreak ? { pageBreak: 'before' } : {}) });
    content.push(centerBlock(insuranceTableDef(insurance)));
    content.push(chunk.length ? centerBlock(dataTableDef(chunk, isMinor)) : { text: '（無資料）', italics: true, color: '#999', alignment: 'center' });
  });
  return content;
}

async function buildCompetitionInsurancePdfBuffer({ insurance, groups }) {
  const printer = getPrinter();
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 9 },
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [24, 24, 24, 24],
    content: groups.flatMap((g, i) => buildGroupContent(g.title, insurance, g.rows, i === 0, !!g.isMinorGroup)),
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
