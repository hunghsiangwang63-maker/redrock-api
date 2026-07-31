// 台灣公司統一編號（8 碼）檢查碼驗證。
// 演算法：權重 [1,2,1,2,1,2,4,1] 逐碼相乘，乘積十位數+個位數相加後總和需為 5 的倍數
// （財政部 2021-12-22 起由「10 的倍數」改為「5 的倍數」，擴充可用號碼範圍）。
// 第七碼（index 6）為 7 時另有特例：總和 或 總和+1 任一為 5 的倍數即算合法。
const WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];

const isValidTaiwanTaxId = (id) => {
  const s = String(id || '').trim();
  if (!/^\d{8}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const prod = Number(s[i]) * WEIGHTS[i];
    sum += Math.floor(prod / 10) + (prod % 10);
  }
  if (s[6] === '7') return sum % 5 === 0 || (sum + 1) % 5 === 0;
  return sum % 5 === 0;
};

module.exports = { isValidTaiwanTaxId };
