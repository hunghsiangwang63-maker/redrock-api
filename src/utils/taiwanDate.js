/**
 * 台灣時區（UTC+8）日期工具。
 *
 * 集中原本散落 30+ 處的 `new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)`，
 * 避免時區位移計算各處手寫、格式不一（曾造成營收週統計時區 bug）。
 * 皆為「以 UTC+8 為準取當下日期」，不依賴伺服器本機時區。
 */

// 台灣當日日期字串 YYYY-MM-DD
function taiwanToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

module.exports = { taiwanToday };
