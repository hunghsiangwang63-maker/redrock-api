// ── 定期票服務同意書（合約）PDF：月票/90日票/半年票等會員自助取得的定期票，比照課程服務同意書
// （courseContractPdf.js）加上完整合約書供閱讀＋簽名，套用於：
//   ①入場當下購買定期票（buy_pass）②我的票券頁線上續約（pass_renewal）
// 店員代辦（POST /passes）非會員自助操作，會員自己不會看到任何畫面，故不套用此流程。
// 條款文字＝紅石攀岩館「定期票服務同意書」正本（符合111年體育局定型化契約規範），逐字重現；
// 場館基本資料等由呼叫端即時帶入（見 passContractService.js，讀 systemSettings/gymContracts）。
// 純版面元件（場館資料/框線/簽名欄/字型）與課程合約共用，見 contractPdfShared.js。
const fs = require('fs');
const {
  getPrinter, money, sectionHeader, fieldTable, gymInfoBlock, partyBox, signatureCell, paymentBlock,
  ACCENT, CELL_BORDER, LABEL_BG, CM_TO_PT, VENDOR_SIGNATURE_PATH,
} = require('./contractPdfShared');

// ⚠️ 2026-09-07 待確認：使用者提供的合約模板寫轉讓手續費 600 元，但系統 passAdjustmentService.js
// 現行 TRANSFER_FEE 實際收 300 元——使用者已拍板「先不用（改系統），記下來待確認」，故本檔暫時
// 沿用系統現行的 300 元（與實際收費一致，避免合約承諾與實際收費不符）。若之後確認要改 600，
// 這裡與 passAdjustmentService.js 的 TRANSFER_FEE 需一併更新。
const TRANSFER_FEE_PENDING_CONFIRM = 300;

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

function passTermsBlock() {
  const T = 8.5;
  return [
    sectionHeader('相關條款及注意事項(符合 111 年體育局所制定定型化契約內容相關規範)'),
    { text: '1. 服務相關條款皆有三天審閱期，未開始使用前可全額退費。', margin: [0, 1, 0, 1], fontSize: T },
    { text: '2. 乙方於營業時間內，應提供下列服務內容：', margin: [0, 1, 0, 1], fontSize: T },
    { ul: ['合格可供正常使用之運動器材設備、中文標示及使用說明。', '各種設備於明顯處所張貼不當使用可能產生危險之警告標示及緊急處理危險方法之說明。'], margin: [10, 0, 0, 3], fontSize: T },
    { text: '3. 乙方除經甲方同意外，不得調高上述已約定之費用。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '4. 甲方若遇以下事項可辦理暫停與展延，甲方須事先提出相關文件證明/釋明下列事由之一者，乙方應於七工作日內辦理暫停會籍，會籍有效期間順延：', margin: [0, 1, 0, 1], fontSize: T },
    {
      ul: [
        '出國逾一個月。',
        '受傷、疾病或身體不適致不宜運動。',
        '懷孕、育嬰、侍親之需要。',
        '服兵役致難以履約。',
        '職務異動或遷居致難以履約。',
        '其他事由致難以履約',
      ], margin: [10, 0, 0, 3], fontSize: T,
    },
    { text: '5. 契約終止', margin: [0, 1, 0, 1], fontSize: T },
    {
      ul: [
        '可歸責甲方事由之契約終止，扣除手續費 600 元後，依未到期時間比例計算餘額退還予甲方，退款於 10 個工作天內匯入甲方指定之金融帳戶。',
        '不可歸責甲方事由之契約終止，不扣除手續費，依未到期時間比例計算餘額退還予甲方，退款於 10 個工作天內匯入甲方指定之金融帳戶。',
      ], margin: [10, 0, 0, 3], fontSize: T,
    },
    { text: '6. 終止契約之通知：甲方得以線上填單通知乙方。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '7. 契約讓與第三人', margin: [0, 1, 0, 1], fontSize: T },
    {
      ul: [
        '甲方於契約期間屆滿前經業者同意，得讓與契約予第三人，契約之內容不因讓與而受影響。',
        `乙方以有約定者為限，得向甲方請求因處理前項讓與所生之必要費用 ${TRANSFER_FEE_PENDING_CONFIRM} 元。`,
      ], margin: [10, 0, 0, 3], fontSize: T,
    },
    { text: '8. 乙方服務之異動通知：乙方所提供服務內容與時間如有異動，須事先通知，且應與原定開始服務時間相距24個小時以上，其通知方式約定如下：', margin: [0, 1, 0, 1], fontSize: T },
    { ul: ['公告於乙方網：app.redrocktaiwan.com', '若乙方未依前項約定時間方式通知，甲方得請求乙方於限期 7 日內提供甲方同意之補償方案。'], margin: [10, 0, 0, 3], fontSize: T },
    { text: '9. 贈品約款及其效果: 無贈品', margin: [0, 1, 0, 3], fontSize: T },
    { text: '10. 會籍轉點：無轉點需求。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '11. 消費資訊及廣告：乙方之廣告，均為契約內容。乙方應確保其廣告內容真實，其對甲方所應負義務不得低於前項廣告內容。', margin: [0, 1, 0, 3], fontSize: T },
    { text: '12. 合意管轄：因本契約發生訴訟時，雙方同意以新竹地方法院為第一審管轄法院，但不得排除消費者保護法第四十七條或民事訴訟法第二十八條第二項、第四百三十六條之九規定之小額訴訟管轄法院之適用。', margin: [0, 1, 0, 1], fontSize: T },
  ];
}

function passSignatureBlock({ portraitSignature, guardianSignature, isMinor }) {
  const vendorSig = fs.existsSync(VENDOR_SIGNATURE_PATH) ? VENDOR_SIGNATURE_PATH : null;
  const vendorStampWidthPt = Math.round(4 * CM_TO_PT);

  const boxes = [signatureCell('消費者（簡稱甲方）簽名', portraitSignature, 130)];
  if (isMinor) boxes.push(signatureCell('法定代理人簽名', guardianSignature, 130));
  boxes.push(signatureCell('業者（簡稱乙方與上課教練代表）', vendorSig, vendorStampWidthPt));

  return [
    { text: '茲為甲方於乙方所提供定期票服務事宜，經甲乙雙方同意依本契約履行，並同意上列條款，於下方簽名確認', margin: [0, 6, 0, 5], fontSize: 9 },
    { columns: boxes.map(b => ({ width: '*', ...b })), columnGap: 10 },
  ];
}

async function buildPassContractPdfBuffer(data) {
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
      { text: '紅石攀岩館 定期票服務同意書', bold: true, fontSize: 15, alignment: 'center', color: ACCENT, margin: [0, 0, 0, 3] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 1.5, lineColor: ACCENT }], margin: [0, 0, 0, 6] },
      ...passPartiesBlock(data),
      ...passContentBlock(data),
      ...paymentBlock(data),
      ...passTermsBlock(),
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
