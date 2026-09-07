// ── 課程服務同意書（合約）PDF：報名完成後（僅週課）自動產生 ──────────────────────
// 條款文字＝紅石攀岩館「抱石課程服務同意書」正本（符合111年體育局定型化契約規範），逐字重現；
// 場館基本資料等 11 項由呼叫端即時帶入（見 courseContractService.js，讀 systemSettings/gymContracts）。
// 中文字型：bundle 隨附的 Noto Sans TC（比照 competitionInsurancePdf.js 同一套字型），否則中文會變空白方塊。
// 2026-09-06 排版優化：品牌色分段標題／課程內容付款方式改表格／簽名欄三格並排加框線／店章固定4公分寬。
// 2026-09-07：場館資料/框線/簽名欄等純版面元件抽到 contractPdfShared.js，與定期票合約（passContractPdf.js）共用。
const fs = require('fs');
const {
  getPrinter, money, sectionHeader, fieldTable, gymInfoBlock, partyBox, signatureCell, paymentBlock,
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

function courseTermsBlock({ refundFeeRate, refundPreStartFeeRate }) {
  const postRate = Math.round((refundFeeRate ?? 0.2) * 100);
  const preRate = Math.round((refundPreStartFeeRate ?? 0) * 100);
  const T = 8.5; // 條款字級：法規正文密度高，統一縮小以利控制頁數，仍維持可讀
  return [
    sectionHeader('相關條款及注意事項(符合 111 年體育局所制定定型化契約內容相關規範)'),
    { text: '1. 課程與服務相關條款皆有三天審閱期，未開始上課前可全額退費，未能依課程安排期限內使用完畢可依請假規定辦理暫停、延期', margin: [0, 1, 0, 1], fontSize: T },
    { text: '2. 若遇以下事項可辦理展延或退費，須事先提出相關文件證明，釋明下列事由之一者', margin: [0, 1, 0, 1], fontSize: T },
    {
      ul: [
        '出國逾一個月。',
        '受傷、疾病或身體不適致不宜運動。',
        '懷孕、育嬰、侍親之需要。',
        '服兵役致難以履約。',
        '職務異動或遷居致難以履約。',
        '或是其他事由致難以履約',
      ], margin: [10, 0, 0, 3], fontSize: T,
    },
    { text: '3. 終止課程、轉讓與解約', margin: [0, 1, 0, 1], fontSize: T },
    {
      ul: [
        '課程可於當期期限內轉讓(限一次)，轉讓費為 600 元。',
        '若甲方因個人因素終止本課程，得申請退費',
        { text: '(1) 退費金額計算公式：', margin: [0, 1, 0, 1] },
        { ul: ['退費金額=剩餘堂數價金−手續費', '每堂單價：課程費用÷總堂數', '剩餘堂數：總堂數−已開課堂數（不論學員實際有無出席或請假，皆以已開課天數計算）。'] },
        { text: '(2) 手續費比例：', margin: [0, 1, 0, 1] },
        { ul: [
          preRate > 0 ? `開課前申請退費：收取總課程費用之 ${preRate}%。` : '開課前申請退費：不收取手續費。',
          `開課後申請退費：收取剩餘堂數價金之 ${postRate}%。`,
        ] },
      ], margin: [10, 0, 0, 3], fontSize: T,
    },
    { text: '4. 乙方服務之異動通知：乙方所提供服務內容與時間如有異動，須事先通知，且應與原定開始服務時間相距24個小時以上，其通知方式約定如下：', margin: [0, 1, 0, 1], fontSize: T },
    { ul: ['公告於乙方網：app.redrocktaiwan.com', '若乙方未依前項約定時間方式通知，甲方得請求乙方於限期 7 日內提供甲方同意之補課方案。'], margin: [10, 0, 0, 3], fontSize: T },
    { text: '5. 不可歸責雙方事由之終止與效果。', margin: [0, 1, 0, 1], fontSize: T },
    { text: '因天災、戰亂、政府法令之新增或變更等不可抗力或其他不可歸責於雙方當事人之事由，致難以完成本契約之服務時，任何一方得終止契約，乙方應依未服務之堂數(含所贈與服務堂數)計算餘額退還予甲方，不得收取手續費、違約金或任何名目費用。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '6. 不可歸責乙方事由之終止與效果。', margin: [0, 1, 0, 1], fontSize: T },
    { text: '甲方有影響乙方營運之不當行為情節重大，經勸告無效者，乙方得終止契約，並應依未服務之堂數(含所贈與服務堂數)計算餘額退還予甲方，不得收取手續費用、違約金或任何名目費用。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '7. 可歸責乙方事由之終止與效果。', margin: [0, 1, 0, 1], fontSize: T },
    { text: '可歸責乙方之事由致無法繼續提供約定服務(含所贈與服務堂數)，應依未服務之堂數計算餘額退還予甲方，不得收取手續費、違約金或任何名目之扣費。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '8. 甲方是否需預約才可消費?', margin: [0, 1, 0, 1], fontSize: T },
    { ul: ['甲方參加教練服務之時需依照課程已排定之時段準時參加。'], margin: [10, 0, 0, 3], fontSize: T },
    { text: '9. 若甲方無法依約定時間參加教練服務時，須事先通知，甲方若未依前項約定時間方式通知，乙方則能不予補課。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '10. 贈品約款及其效果: 一定期間免費入場', margin: [0, 1, 0, 3], fontSize: T },
    { text: '11. 消費資訊及廣告：乙方之廣告，均為契約內容。乙方應確保其廣告內容真實，其對甲方所應負義務不得低於前項廣告內容。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '12. 合意管轄：因本契約發生訴訟時，雙方同意以新竹地方法院為第一審管轄法院，但不得排除消費者保護法第四十七條或民事訴訟法第二十八條第二項、第四百三十六條之九規定之小額訴訟管轄法院之適用。', margin: [0, 1, 0, 1], fontSize: T },
  ];
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
