// ── 課程／定期票 暫停・退費・轉讓 申請理由（單一共用清單）──────────────────
// 2026-09-07 新增：原本課程（courseAdjustmentService）與定期票（passAdjustmentService）
// 各自維護一份（課程甚至完全沒有結構化理由、只收自由文字），拆分後導致合約文字（clause 4：
// 出國逾一個月／受傷疾病或身體不適／懷孕育嬰侍親／服兵役／職務異動遷居／其他事由）與實際申請表單
// 理由選項對不上（如原本 passAdjustmentService 寫「出國逾2個月」、少了服兵役與其他事由兩項）。
// 現統一由此檔案單一定義，courses/passes 申請表單、審核記錄、合約 PDF 條款文字四處共用同一份。
// 'other' 為開放式理由，前端搭配自由文字欄位（reasonDetail）說明。
const REQUEST_REASONS = [
  { key: 'abroad', label: '出國逾一個月' },
  { key: 'health', label: '受傷、疾病或身體不適致不宜運動' },
  { key: 'family', label: '懷孕、育嬰、侍親之需要' },
  { key: 'military', label: '服兵役致難以履約' },
  { key: 'relocation', label: '職務異動或遷居致難以履約' },
  { key: 'other', label: '其他事由致難以履約' },
];

module.exports = { REQUEST_REASONS };
