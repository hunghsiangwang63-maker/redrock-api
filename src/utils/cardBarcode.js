// 卡號（優惠卡/黑卡條碼）正規化——比對/防重複/日後對照「可綁定卡號清單」都要用同一套正規化，
// 否則「AT19-0001」跟「AT190001」會被當成兩張不同的卡。店員輸入時不需要打「－」。
// 規則：去除半形/全形破折號與空白、轉大寫；不驗證格式（實體卡字軌不只一種，見 CLAUDE.md 記錄）。
function normalizeBarcode(raw) {
  return String(raw || '').replace(/[-－\s]/g, '').toUpperCase();
}

module.exports = { normalizeBarcode };
