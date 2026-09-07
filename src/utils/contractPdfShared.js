// ── 合約 PDF 共用建構元件（2026-09-07 從 courseContractPdf.js 抽出，供課程/定期票合約共用）──
// 場館合約基本資料／簽名欄框線／字型設定等純版面元件，兩種合約完全一致，抽成單一真相；
// 改版面（如日後再調整框線/字級）只需改這裡，兩份合約自動同步，避免像先前粗體字型 bug
// 同時存在於 courseContractPdf.js 與 competitionInsurancePdf.js 兩處要分別修的情況再度發生。
const path = require('path');
const fs = require('fs');
const PdfPrinter = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTC-Regular.ttf');
// 粗體＝從 Google Fonts 官方變數字體(wght軸)以 fonttools 實際 instance 出的靜態 700 字重，非借用 Regular 假裝粗體
// （原本 bold 也指向 Regular 檔，pdfmake/PDFKit 沒有自動加粗機制，bold:true 完全無視覺效果——見 2026-09-06 修復）。
const BOLD_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTC-Bold.ttf');
const FONTS = { NotoSansTC: { normal: FONT_PATH, bold: BOLD_FONT_PATH, italics: FONT_PATH, bolditalics: BOLD_FONT_PATH } };

// 業者(乙方)簽名／店章圖檔——課程與定期票合約共用同一張店章。
const VENDOR_SIGNATURE_PATH = path.join(__dirname, '..', 'assets', 'signatures', 'vendor-signature.png');

const ACCENT = '#8B1A1A';      // 品牌色（同站內信件/UI 主色）
const CELL_BORDER = '#CCCCCC';
const LABEL_BG = '#F7F7F7';
const CM_TO_PT = 72 / 2.54;    // pdfmake 單位為 pt，1公分＝72/2.54 pt

function getPrinter() {
  const resolver = new URLResolver(fs);
  return new PdfPrinter(FONTS, null, resolver, () => true);
}

const money = (n) => `新臺幣 ${Number(n || 0).toLocaleString()} 元`;

// 分段色塊標題（品牌色底、白字）。
function sectionHeader(text) {
  return {
    table: { widths: ['*'], body: [[{ text, bold: true, fontSize: 10.5, color: '#fff', fillColor: ACCENT, margin: [7, 2, 7, 2] }]] },
    layout: 'noBorders',
    margin: [0, 5, 0, 3],
  };
}

// 帶邊框的兩欄表格（欄位名｜內容）。
function fieldTable(rows, labelWidth = 110) {
  return {
    table: { widths: [labelWidth, '*'], body: rows.map(([label, val]) => [
      { text: label, bold: true, fillColor: LABEL_BG },
      { text: val || '' },
    ]) },
    layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => CELL_BORDER, vLineColor: () => CELL_BORDER,
      paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 2, paddingBottom: () => 2 },
    margin: [0, 0, 0, 3],
  };
}

// 場館合約基本資料：字級 6、平均分三欄橫跨版面（不加框線，僅供核對用），置於主標題之上。
function gymInfoBlock(g) {
  const rows = [
    ['場所名稱', g.venueName],
    ['負責人', g.personInCharge],
    ['履約地點', g.contractLocation],
    ['坪數', g.areaPing],
    ['場館可容納人數', g.maxCapacity],
    ['預計招收會員人數', g.expectedMembers],
    ['聯絡電話', g.contactPhone],
    ['電子信箱', g.contactEmail],
    ['公司登記或行號證明', g.businessRegistrationNo],
    ['公共意外責任險額度與效期', g.liabilityInsurancePeriod],
    ['每一人體傷責任', g.perPersonInjuryLiability],
  ];
  const line = ([label, val]) => ({ text: `${label}：${val || ''}`, fontSize: 6, lineHeight: 1.15, margin: [0, 0, 0, 1] });
  const col1 = rows.slice(0, 4).map(line);
  const col2 = rows.slice(4, 8).map(line);
  const col3 = rows.slice(8, 11).map(line);
  return {
    columns: [
      { width: '*', stack: col1 },
      { width: '*', stack: col2 },
      { width: '*', stack: col3 },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 3],
  };
}

// 一方（甲方/乙方）資訊框：品牌色標題列 + 內容，四周加框線。
function partyBox(title, lines) {
  return {
    table: {
      widths: ['*'],
      body: [
        [{ text: title, bold: true, alignment: 'center', color: '#fff', fillColor: ACCENT, margin: [4, 2, 4, 2] }],
        [{ stack: lines, margin: [8, 4, 8, 4] }],
      ],
    },
    layout: { hLineWidth: () => 1, vLineWidth: () => 1, hLineColor: () => ACCENT, vLineColor: () => ACCENT },
  };
}

// 簽名欄一個方格：上方置中標籤（淺灰底）、下方置中圖片（或留白提示），四周加框線。
function signatureCell(label, imgSrc, imgWidth) {
  const body = imgSrc
    ? { image: imgSrc, width: imgWidth, alignment: 'center', margin: [0, 3, 0, 3] }
    : { text: '（未附檔）', color: '#999', alignment: 'center', fontSize: 9, margin: [0, 12, 0, 12] };
  return {
    table: {
      widths: ['*'],
      body: [
        [{ text: label, bold: true, alignment: 'center', fillColor: LABEL_BG, fontSize: 9, margin: [2, 2, 2, 2] }],
        [body],
      ],
    },
    layout: { hLineWidth: () => 1, vLineWidth: () => 1, hLineColor: () => '#999', vLineColor: () => '#999' },
  };
}

// 通用付款方式區塊（課程/定期票共用；分期期別表格一致）。
const PAY_METHOD_LABEL = { cash: '臨櫃現金付款', transfer: '匯款', linepay: '匯款', jkopay: '匯款', taiwanpay: '匯款' };
function paymentBlock({ paymentMethod, installments }) {
  const content = [
    sectionHeader('付款方式'),
    fieldTable([['本次付款方式', PAY_METHOD_LABEL[paymentMethod] || paymentMethod || '']], 100),
  ];
  if (Array.isArray(installments) && installments.length) {
    content.push({ text: `按月逐月繳：分 ${installments.length} 期付款，各期金額與繳款期限如下：`, margin: [0, 0, 0, 2], fontSize: 8.5 });
    content.push({
      table: {
        widths: ['auto', 'auto', 'auto'],
        body: [
          [{ text: '期別', bold: true, fillColor: LABEL_BG, alignment: 'center' },
            { text: '金額', bold: true, fillColor: LABEL_BG, alignment: 'center' },
            { text: '繳款期限', bold: true, fillColor: LABEL_BG, alignment: 'center' }],
          ...installments.map((p, i) => [
            { text: `第 ${i + 1} 期`, alignment: 'center' },
            { text: money(p.amount), alignment: 'right' },
            { text: p.dueDate || '', alignment: 'center' },
          ]),
        ],
      },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => CELL_BORDER, vLineColor: () => CELL_BORDER,
        paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 1, paddingBottom: () => 1 },
      fontSize: 8.5,
      margin: [0, 0, 0, 2],
    });
  }
  return content;
}

// 動態合約條款區塊（課程/定期票共用）——text 為 systemSettings/contractTerms 存的整段純文字
// （設定頁單一大文字框編輯，見 routes/settings.js /contract-terms），支援 {{token}} 樣板變數
// （見 contractTermsDefaults.js fillTemplate）；換行斷行、「・」開頭轉條列、空白行斷段——皆為
// 純樣式判斷（行首「數字. 」視為段落標題，字級略大＋加大上邊距，不加粗），非結構化欄位。
const { fillTemplate } = require('./contractTermsDefaults');
function termsSections(text, vars) {
  const blocks = [sectionHeader('相關條款及注意事項(符合 111 年體育局所制定定型化契約內容相關規範)')];
  const lines = fillTemplate(text, vars).split('\n');
  let bulletBuf = [];
  const flush = () => { if (bulletBuf.length) { blocks.push({ ul: bulletBuf.slice(), margin: [10, 0, 0, 2], fontSize: 8 }); bulletBuf = []; } };
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return; // 空白行僅斷段，靠下一個標題行自帶的上邊距呈現段落間距
    if (trimmed.startsWith('・')) { bulletBuf.push(trimmed.slice(1).trim()); return; }
    flush();
    const isHeading = /^\d+[.、]/.test(trimmed);
    blocks.push({ text: trimmed, fontSize: isHeading ? 8.5 : 8, margin: isHeading ? [0, 3, 0, 1] : [0, 0.5, 0, 0.5] });
  });
  flush();
  return blocks;
}

module.exports = {
  FONTS, getPrinter, money, sectionHeader, fieldTable, gymInfoBlock, partyBox, signatureCell, paymentBlock, termsSections,
  ACCENT, CELL_BORDER, LABEL_BG, CM_TO_PT, VENDOR_SIGNATURE_PATH, PAY_METHOD_LABEL,
};
