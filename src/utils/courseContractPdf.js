// ── 課程服務同意書（合約）PDF：報名完成後（僅週課）自動產生 ──────────────────────
// 條款文字＝紅石攀岩館「抱石課程服務同意書」正本（符合111年體育局定型化契約規範），逐字重現；
// 場館基本資料等 11 項由呼叫端即時帶入（見 courseContractService.js，讀 systemSettings/gymContracts）。
// 中文字型：bundle 隨附的 Noto Sans TC（比照 competitionInsurancePdf.js 同一套字型），否則中文會變空白方塊。
const path = require('path');
const fs = require('fs');
const PdfPrinter = require('pdfmake/js/Printer.js').default;
const URLResolver = require('pdfmake/js/URLResolver.js').default;

const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansTC-Regular.ttf');
const FONTS = { NotoSansTC: { normal: FONT_PATH, bold: FONT_PATH, italics: FONT_PATH, bolditalics: FONT_PATH } };

// 業者(乙方)簽名／店章圖檔——目前尚未提供，先留位置；到位後把檔案放進這個路徑即自動生效（免改程式碼）。
const VENDOR_SIGNATURE_PATH = path.join(__dirname, '..', 'assets', 'signatures', 'vendor-signature.png');

function getPrinter() {
  const resolver = new URLResolver(fs);
  return new PdfPrinter(FONTS, null, resolver, () => true);
}

const money = (n) => `新臺幣 ${Number(n || 0).toLocaleString()} 元`;

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
  return rows.map(([label, val]) => ({ text: [{ text: `${label}：`, bold: true }, val || ''], margin: [0, 1, 0, 1] }));
}

function partiesBlock({ studentName, guardianName, phone, vendorName, isMinor }) {
  const lines = [
    { text: '立契約書人', bold: true, fontSize: 12, margin: [0, 8, 0, 4] },
    { text: [{ text: '消費者(簡稱甲方)姓名：', bold: true }, studentName || ''] },
  ];
  if (isMinor) lines.push({ text: [{ text: '法定代理人：', bold: true }, guardianName || ''] });
  lines.push({ text: [{ text: '電話：', bold: true }, phone || ''] });
  lines.push({ text: [{ text: '業者(簡稱乙方與上課教練代表)姓名：', bold: true }, vendorName || ''] });
  lines.push({ text: [{ text: '電話、地址：', bold: true }, '(同左方業者資訊)'] });
  return lines;
}

function courseContentBlock({ courseName, startDate, endDate, weekdayLabel, startTime, endTime, totalSessions, totalFee }) {
  return [
    { text: '課程內容', bold: true, fontSize: 12, margin: [0, 10, 0, 4] },
    { text: `1. 課程名稱：${courseName || ''}`, margin: [0, 2, 0, 2] },
    { text: `2. 上課日期：${startDate || ''} 至 ${endDate || ''} 止。`, margin: [0, 2, 0, 2] },
    { text: `3. 上課時間：每週${weekdayLabel || ''} ${startTime || ''} 至 ${endTime || ''}`, margin: [0, 2, 0, 2] },
    { text: `4. 堂數：${totalSessions || 0} 堂`, margin: [0, 2, 0, 2] },
    { text: `5. 課程總金額：${money(totalFee)}`, margin: [0, 2, 0, 2] },
  ];
}

const PAY_METHOD_LABEL = { cash: '臨櫃現金付款', transfer: '匯款', linepay: '匯款', jkopay: '匯款', taiwanpay: '匯款' };

function paymentBlock({ paymentMethod, installments }) {
  const content = [
    { text: '付款方式', bold: true, fontSize: 12, margin: [0, 10, 0, 4] },
    { text: `本次付款方式：${PAY_METHOD_LABEL[paymentMethod] || paymentMethod || ''}`, margin: [0, 2, 0, 2] },
  ];
  if (Array.isArray(installments) && installments.length) {
    content.push({ text: `按月逐月繳：分 ${installments.length} 期付款，各期金額與繳款期限如下：`, margin: [0, 4, 0, 4] });
    content.push({
      table: {
        widths: ['auto', 'auto', 'auto'],
        body: [
          [{ text: '期別', bold: true }, { text: '金額', bold: true }, { text: '繳款期限', bold: true }],
          ...installments.map((p, i) => [`第 ${i + 1} 期`, money(p.amount), p.dueDate || '']),
        ],
      },
      layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
      margin: [0, 0, 0, 4],
    });
  }
  content.push({ text: '附註：本場館教練、團體課程，使用期限超過30天、總金額超過5000元，採按月逐月繳款，且付款期數不得低於契約期數(一期為一個月為限)。', fontSize: 9, color: '#555', margin: [0, 2, 0, 2] });
  return content;
}

function termsBlock({ refundFeeRate, refundPreStartFeeRate }) {
  const postRate = Math.round((refundFeeRate ?? 0.2) * 100);
  const preRate = Math.round((refundPreStartFeeRate ?? 0) * 100);
  return [
    { text: '相關條款及注意事項(符合 111 年體育局所制定定型化契約內容相關規範)', bold: true, fontSize: 12, margin: [0, 10, 0, 4] },
    { text: '1. 課程與服務相關條款皆有三天審閱期，未開始上課前可全額退費，未能依課程安排期限內使用完畢可依請假規定辦理暫停、延期', margin: [0, 2, 0, 2] },
    { text: '2. 若遇以下事項可辦理展延或退費，須事先提出相關文件證明，釋明下列事由之一者', margin: [0, 2, 0, 2] },
    {
      ul: [
        '出國逾一個月。',
        '受傷、疾病或身體不適致不宜運動。',
        '懷孕、育嬰、侍親之需要。',
        '服兵役致難以履約。',
        '職務異動或遷居致難以履約。',
        '或是其他事由致難以履約',
      ], margin: [12, 0, 0, 4],
    },
    { text: '3. 終止課程、轉讓與解約', margin: [0, 2, 0, 2] },
    {
      ul: [
        '課程可於當期期限內轉讓(限一次)，轉讓費為 600 元。',
        '若甲方因個人因素終止本課程，得申請退費',
        { text: '1.退費金額計算公式：' },
        { ul: ['退費金額=剩餘堂數價金−手續費', '每堂單價：課程費用÷總堂數', '剩餘堂數：總堂數−已開課堂數（不論學員實際有無出席或請假，皆以已開課天數計算）。'] },
        { text: '2.手續費比例：' },
        { ul: [
          preRate > 0 ? `開課前申請退費：收取總課程費用之 ${preRate}%。` : '開課前申請退費：不收取手續費。',
          `開課後申請退費：收取剩餘堂數價金之 ${postRate}%。`,
        ] },
      ], margin: [12, 0, 0, 4],
    },
    { text: '乙方服務之異動通知', bold: true, margin: [0, 2, 0, 2] },
    { text: '4. 乙方所提供服務內容與時間如有異動，須事先通知，且應與原定開始服務時間相距24個小時以上，其通知方式約定如下：', margin: [0, 2, 0, 2] },
    { ul: ['公告於乙方網：app.redrocktaiwan.com', '若乙方未依前項約定時間方式通知，甲方得請求乙方於限期 7 日內提供甲方同意之補課方案。'], margin: [12, 0, 0, 4] },
    { text: '5. 不可歸責雙方事由之終止與效果。', margin: [0, 2, 0, 2] },
    { text: '因天災、戰亂、政府法令之新增或變更等不可抗力或其他不可歸責於雙方當事人之事由，致難以完成本契約之服務時，任何一方得終止契約，乙方應依未服務之堂數(含所贈與服務堂數)計算餘額退還予甲方，不得收取手續費、違約金或任何名目費用。', margin: [0, 2, 0, 2] },
    { text: '6. 不可歸責乙方事由之終止與效果。', margin: [0, 2, 0, 2] },
    { text: '甲方有影響乙方營運之不當行為情節重大，經勸告無效者，乙方得終止契約，並應依未服務之堂數(含所贈與服務堂數)計算餘額退還予甲方，不得收取手續費用、違約金或任何名目費用。', margin: [0, 2, 0, 2] },
    { text: '7. 可歸責乙方事由之終止與效果。', margin: [0, 2, 0, 2] },
    { text: '可歸責乙方之事由致無法繼續提供約定服務(含所贈與服務堂數)，應依未服務之堂數計算餘額退還予甲方，不得收取手續費、違約金或任何名目之扣費。', margin: [0, 2, 0, 2] },
    { text: '8. 甲方是否需預約才可消費?', margin: [0, 2, 0, 2] },
    { ul: ['甲方參加教練服務之時需依照課程已排定之時段準時參加。'], margin: [12, 0, 0, 4] },
    { text: '9. 若甲方無法依約定時間參加教練服務時，須事先通知，甲方若未依前項約定時間方式通知，乙方則能不予補課。', margin: [0, 2, 0, 2] },
    { text: '10. 贈品約款及其效果: 一定期間免費入場', margin: [0, 2, 0, 2] },
    { text: '11. 消費資訊及廣告', margin: [0, 2, 0, 2] },
    { text: '乙方之廣告，均為契約內容。乙方應確保其廣告內容真實，其對甲方所應負義務不得低於前項廣告內容。', margin: [0, 2, 0, 2] },
    { text: '12. 合意管轄', margin: [0, 2, 0, 2] },
    { text: '因本契約發生訴訟時，雙方同意以新竹地方法院為第一審管轄法院，但不得排除消費者保護法第四十七條或民事訴訟法第二十八條第二項、第四百三十六條之九規定之小額訴訟管轄法院之適用。', margin: [0, 2, 0, 2] },
  ];
}

function signatureBlock({ portraitSignature, guardianSignature, isMinor }) {
  const sigCell = (src, w = 160, h = 50) => src ? { image: src, width: w, height: h, margin: [0, 4, 0, 4] } : { text: '（未附簽名檔）', color: '#999', margin: [0, 4, 0, 4] };
  const vendorSig = fs.existsSync(VENDOR_SIGNATURE_PATH) ? { image: VENDOR_SIGNATURE_PATH, width: 100, height: 40, margin: [0, 4, 0, 4] } : null;
  const rows = [
    [{ text: '消費者(簡稱甲方)：', bold: true }, sigCell(portraitSignature)],
  ];
  if (isMinor) rows.push([{ text: '法定代理人：', bold: true }, sigCell(guardianSignature)]);
  rows.push([{ text: '業者(簡稱乙方與上課教練代表)：', bold: true }, vendorSig || { text: '', margin: [0, 4, 0, 4] }]);
  return [
    { text: '茲為甲方於乙方所提供教練服務事宜，經甲乙雙方同意依本契約履行，並同意上列條款，於下方簽名確認', margin: [0, 10, 0, 6] },
    {
      table: { widths: ['auto', '*'], body: rows },
      layout: 'noBorders',
    },
  ];
}

async function buildCourseContractPdfBuffer(data) {
  const printer = getPrinter();
  const docDefinition = {
    defaultStyle: { font: 'NotoSansTC', fontSize: 10, lineHeight: 1.25 },
    pageSize: 'A4',
    pageMargins: [36, 30, 36, 30],
    content: [
      { text: '紅石攀岩館 抱石課程服務同意書', bold: true, fontSize: 15, alignment: 'center', margin: [0, 0, 0, 10] },
      ...gymInfoBlock(data.gymContract || {}),
      ...partiesBlock(data),
      ...courseContentBlock(data),
      ...paymentBlock(data),
      ...termsBlock(data),
      ...signatureBlock(data),
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
