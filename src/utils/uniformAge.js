// 制服已領滿兩年判斷（滿 2 年可再次發放）。issuedAt 為 'YYYY-MM-DD' 或月份精度 'YYYY-MM'（月份以當月最後一天算，避免誤判）；日期不詳者不判斷。
const { taiwanToday } = require('./taiwanDate');

const normIssued = (v) => {
  if (!v) return null;
  if (/^\d{4}-\d{2}$/.test(v)) { const [y, m] = v.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};
// issues：該會員未作廢的制服領取紀錄 → { lastDate: 最近一次領取日（無可判斷日期為 null）, over2y: 最近一次已滿兩年 }
const uniformAge = (issues, today = taiwanToday()) => {
  const dates = (issues || []).map((u) => normIssued(u.issuedAt)).filter(Boolean).sort();
  const lastDate = dates.length ? dates[dates.length - 1] : null;
  if (!lastDate) return { lastDate: null, over2y: false };
  const lim = new Date(lastDate + 'T00:00:00Z'); lim.setUTCFullYear(lim.getUTCFullYear() + 2);
  return { lastDate, over2y: lim.toISOString().slice(0, 10) <= today };
};
module.exports = { uniformAge, normIssued };
