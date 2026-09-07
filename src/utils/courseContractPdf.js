// ── 課程服務同意書（合約）PDF：報名完成後（僅週課）自動產生 ──────────────────────
// 條款文字＝紅石攀岩館「抱石課程服務同意書」正本（符合111年體育局定型化契約規範），逐字重現；
// 場館基本資料等 11 項由呼叫端即時帶入（見 courseContractService.js，讀 systemSettings/gymContracts）。
// 中文字型：bundle 隨附的 Noto Sans TC（比照 competitionInsurancePdf.js 同一套字型），否則中文會變空白方塊。
// 2026-09-06 排版優化：品牌色分段標題／課程內容付款方式改表格／簽名欄三格並排加框線／店章固定4公分寬。
// 2026-09-07：場館資料/框線/簽名欄等純版面元件抽到 contractPdfShared.js，與定期票合約（passContractPdf.js）共用。
const fs = require('fs');
const {
  getPrinter, money, sectionHeader, fieldTable, gymInfoBlock, partyBox, signatureCell, paymentBlock, termsSections,
  ACCENT, CELL_BORDER, LABEL_BG, CM_TO_PT, VENDOR_SIGNATURE_PATH,
} = require('./contractPdfShared');

function partiesBlock({ studentName, guardianName, phone, vendorName, isMinor, gymContract }) {
  const consumerLines = [
    { text: [{ text: '姓名：', bold: true }, studentName || ''], margin: [0, 1, 0, 1] },
  ];
  if (isMinor) consumerLines.push({ text: [{ text: '法定代理人：', bold: true }, guardianName || ''], margin: [0, 1, 0, 1] });
  consumerLines.push({ text: [{ text: '電話：', bold: true }, phone || ''], margin: [0, 1, 0, 1] });

  // 業者電話／地址直接代入場館合約基本資料（非「同左方業者資訊」的參照文字）。
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

function courseContentBlock({ courseName, startDate, endDate, weekdayLabel, startTime, endTime, totalSessions, totalFee }) {
  const rows = [
    ['1. 課程名稱', courseName || ''],
    ['2. 上課日期', `${startDate || ''} 至 ${endDate || ''} 止`],
    ['3. 上課時間', `每週${weekdayLabel || ''} ${startTime || ''} 至 ${endTime || ''}`],
    ['4. 堂數', `${totalSessions || 0} 堂`],
    ['5. 課程總金額', money(totalFee)],
  ];
  return [sectionHeader('課程內容'), fieldTable(rows, 100)];
}

// 2026-09-07：條款文字改由 systemSettings/contractTerms 設定頁提供（見 courseContractService.js
// 呼叫端即時讀取、DEFAULT_COURSE_TERMS 為 fallback），此處只負責樣板變數代入＋排版（termsSections）。
function courseTermsBlock({ sections, refundFeeRate, refundPreStartFeeRate, transferFee }) {
  const postRate = Math.round((refundFeeRate ?? 0.2) * 100);
  const preRate = Math.round((refundPreStartFeeRate ?? 0) * 100);
  return termsSections(sections, { postStartFeeRate: postRate, preStartFeeRate: preRate, transferFee: transferFee ?? 600 });
}

// 學員(甲方)簽名／(未成年)法定代理人簽名／場館(乙方)店章 三格左右併排，各自加框線；店章固定寬 4 公分。
function courseSignatureBlock({ portraitSignature, guardianSignature, isMinor }) {
  const vendorSig = fs.existsSync(VENDOR_SIGNATURE_PATH) ? VENDOR_SIGNATURE_PATH : null;
  const vendorStampWidthPt = Math.round(4 * CM_TO_PT); // 印章寬度 4 公分

  const boxes = [signatureCell('消費者（簡稱甲方）簽名', portraitSignature, 130)];
  if (isMinor) boxes.push(signatureCell('法定代理人簽名', guardianSignature, 130));
  boxes.push(signatureCell('業者（簡稱乙方與上課教練代表）', vendorSig, vendorStampWidthPt));

  return [
    { text: '茲為甲方於乙方所提供教練服務事宜，經甲乙雙方同意依本契約履行，並同意上列條款，於下方簽名確認', margin: [0, 6, 0, 5], fontSize: 9 },
    { columns: boxes.map(b => ({ width: '*', ...b })), columnGap: 10 },
  ];
}

async function buildCourseContractPdfBuffer(data) {
  const printer = getPrinter();
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 10, lineHeight: 1.22 },
    pageSize: 'A4',
    pageMargins: [36, 32, 36, 40],
    footer: (currentPage, pageCount) => ({
      text: `第 ${currentPage} 頁，共 ${pageCount} 頁`, alignment: 'center', fontSize: 8, color: '#999', margin: [0, 6, 0, 0],
    }),
    content: [
      gymInfoBlock(data.gymContract || {}),
      { text: '紅石攀岩館 抱石課程服務同意書', bold: true, fontSize: 15, alignment: 'center', color: ACCENT, margin: [0, 0, 0, 3] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 1.5, lineColor: ACCENT }], margin: [0, 0, 0, 6] },
      ...partiesBlock(data),
      ...courseContentBlock(data),
      ...paymentBlock(data),
      { text: '附註：本場館教練、團體課程，使用期限超過30天、總金額超過5000元，採按月逐月繳款，且付款期數不得低於契約期數(一期為一個月為限)。', fontSize: 8, color: '#666', italics: true, margin: [0, 1, 0, 1] },
      ...courseTermsBlock(data),
      ...courseSignatureBlock(data),
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

module.exports = { buildCourseContractPdfBuffer };
