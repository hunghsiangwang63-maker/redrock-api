/**
 * Excel/CSV 公式注入防護
 * 對 xlsx 產生的 worksheet 掃描字串儲存格，若以 = + - @ Tab CR 開頭（可能被試算表當公式執行），
 * 前置單引號使其強制為文字。正常資料不受影響（極少以這些字元開頭）。
 */
const DANGEROUS = /^[=+\-@\t\r]/;

function sanitizeSheet(ws) {
  if (!ws || typeof ws !== 'object') return ws;
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue; // 略過 !ref / !merges 等 metadata
    const cell = ws[addr];
    if (cell && cell.t === 's' && typeof cell.v === 'string' && DANGEROUS.test(cell.v)) {
      cell.v = "'" + cell.v;
      if (typeof cell.w === 'string') cell.w = "'" + cell.w;
    }
  }
  return ws;
}

module.exports = { sanitizeSheet };
