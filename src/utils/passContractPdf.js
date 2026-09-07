// ── 定期票服務同意書（合約）PDF：月票/90日票/半年票等會員自助取得的定期票，比照課程服務同意書
// （courseContractPdf.js）加上完整合約書供閱讀＋簽名，套用於：
//   ①入場當下購買定期票（buy_pass）②我的票券頁線上續約（pass_renewal）
// 店員代辦（POST /passes）非會員自助操作，會員自己不會看到任何畫面，故不套用此流程。
// 條款文字＝紅石攀岩館「定期票服務同意書」正本（符合111年體育局定型化契約規範），逐字重現；
// 場館基本資料等由呼叫端即時帶入（見 passContractService.js，讀 systemSettings/gymContracts）。
// 純版面元件（場館資料/框線/簽名欄/字型）與課程合約共用，見 contractPdfShared.js。
const fs = require('fs');
const {
  getPrinter, money, sectionHeader, fieldTable, gymInfoBlock, partyBox, signatureCell, paymentBlock, termsSections,
  ACCENT, CELL_BORDER, LABEL_BG, CM_TO_PT, VENDOR_SIGNATURE_PATH,
} = require('./contractPdfShared');

const SCOPE_LABEL = { shared: '全館', 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };

function passPartiesBlock({ memberName, guardianName, phone, vendorName, isMinor, gymContract }) {
  const consumerLines = [
    { text: [{ text: '姓名：', bold: true }, memberName || ''], margin: [0, 1, 0, 1] },
  ];
  if (isMinor) consumerLines.push({ text: [{ text: '法定代理人：', bold: true }, guardianName || ''], margin: [0, 1, 0, 1] });
  consumerLines.push({ text: [{ text: '電話：', bold: true }, phone || ''], margin: [0, 1, 0, 1] });

  const g = gymContract || {};
  const vendorLines = [
    { text: [{ text: '姓名：', bold: true }, vendorName || ''], margin: [0, 1, 0, 1] },
    { text: [{ text: '電話：', bold: true }, g.contactPhone || ''], margin: [0, 1, 0, 1] },
    { text: [{ text: '地址：', bold: true }, g.contractLocation || ''], margin: [0, 1, 0, 1] },
  ];

  return [
    sectionHeader('立契約書人'),
    {
      columns: [
        { width: '*', ...partyBox('消費者（簡稱甲方）', consumerLines) },
        { width: '*', ...partyBox('業者（簡稱乙方與上課教練代表）', vendorLines) },
      ],
      columnGap: 10, margin: [0, 0, 0, 2],
    },
  ];
}

function passContentBlock({ passTypeName, scope, targetGymId, startDate, endDate, totalFee }) {
  const scopeLabel = scope === 'shared' ? SCOPE_LABEL.shared : (SCOPE_LABEL[targetGymId] || '全館');
  const rows = [
    ['1. 票種與會籍費用', `${passTypeName || ''}：${money(totalFee)}`],
    ['2. 使用館別', scopeLabel],
    ['3. 起迄日期', `${startDate || ''} 至 ${endDate || ''} 止`],
    ['4. 使用方式', '本人得於上述效期營業時間內不限次數入場'],
    ['5. 使用限制', '限本人使用'],
  ];
  return [sectionHeader('定期票服務內容'), fieldTable(rows, 110)];
}

// 2026-09-07：條款文字改由 systemSettings/contractTerms 設定頁提供（見 passContractService.js
// 呼叫端即時讀取、DEFAULT_PASS_TERMS 為 fallback），此處只負責樣板變數代入＋排版（termsSections）。
// 轉讓手續費已由使用者拍板改為 600 元（與課程一致，2026-09-07 修正，取代原本的 300 元待確認註記）。
function passTermsBlock({ termsText, refundFee, transferFee }) {
  return termsSections(termsText, { refundFee: refundFee ?? 600, transferFee: transferFee ?? 600 });
}

function passSignatureBlock({ portraitSignature, guardianSignature, isMinor }) {
  const vendorSig = fs.existsSync(VENDOR_SIGNATURE_PATH) ? VENDOR_SIGNATURE_PATH : null;
  const vendorStampWidthPt = Math.round(3.2 * CM_TO_PT); // 印章寬度 3.2 公分（2026-09-07 由 4cm 縮小，配合合約維持 2 頁內）

  const boxes = [signatureCell('消費者（簡稱甲方）簽名', portraitSignature, 130)];
  if (isMinor) boxes.push(signatureCell('法定代理人簽名', guardianSignature, 130));
  boxes.push(signatureCell('業者（簡稱乙方與上課教練代表）', vendorSig, vendorStampWidthPt));

  return [
    {
      unbreakable: true,
      stack: [
        { text: '茲為甲方於乙方所提供定期票服務事宜，經甲乙雙方同意依本契約履行，並同意上列條款，於下方簽名確認', margin: [0, 4, 0, 4], fontSize: 8.5 },
        { columns: boxes.map(b => ({ width: '*', ...b })), columnGap: 10 },
      ],
    },
  ];
}

async function buildPassContractPdfBuffer(data) {
  const printer = getPrinter();
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 9.5, lineHeight: 1.12 },
    pageSize: 'A4',
    pageMargins: [32, 24, 32, 28],
    footer: (currentPage, pageCount) => ({
      text: `第 ${currentPage} 頁，共 ${pageCount} 頁`, alignment: 'center', fontSize: 8, color: '#999', margin: [0, 4, 0, 0],
    }),
    content: [
      gymInfoBlock(data.gymContract || {}),
      { text: '紅石攀岩館 定期票服務同意書', bold: true, fontSize: 14, alignment: 'center', color: ACCENT, margin: [0, 0, 0, 2] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 531, y2: 0, lineWidth: 1.5, lineColor: ACCENT }], margin: [0, 0, 0, 4] },
      ...passPartiesBlock(data),
      ...passContentBlock(data),
      ...paymentBlock(data),
      ...passTermsBlock(data),
      ...passSignatureBlock(data),
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

module.exports = { buildPassContractPdfBuffer };
