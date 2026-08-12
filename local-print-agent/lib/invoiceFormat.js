// 發票內容排版（純函式，不含任何序列埠/HTTP 邏輯）——由 server.js（Mac/Win10+，serialport 套件版）
// 與 win7/server.js（Win7，PowerShell 橋接版）共用，避免兩份實作各自維護排版邏輯而日後跑掉。
// 修改排版時只改這一份，兩邊自動同步。
const iconv = require('iconv-lite');

const big5 = (s) => iconv.encode(s, 'big5');
const LINE_WIDTH = 24; // 已實測：24 半形字元（12 個中文全形字）＝一行寬度
// 行距：印表機不支援 ESC/POS 的行高控制指令（ESC 3 n 實測無效、不亂碼但也無效果），
// 故用純內容的方式（每行間多插入 N 個空行）達到「加大行距」的視覺效果——保證相容。
// 0=原本緊密排版；1=每行間多一個空行（目前預設）；可依實際印出結果調整。
const LINE_SPACING = parseInt(process.env.LINE_SPACING || '1', 10);

function displayWidth(str) {
  let w = 0;
  for (const ch of str) w += (ch.codePointAt(0) > 0x7F) ? 2 : 1;
  return w;
}
function center(str) {
  const pad = Math.max(0, Math.floor((LINE_WIDTH - displayWidth(str)) / 2));
  return ' '.repeat(pad) + str;
}
function money(n) { return 'NT$' + Number(n || 0).toLocaleString(); }

// 兩館發票抬頭資訊（統一發票明細，已隨 2026-07-31 PoC 實機試印驗證過版面）。
// 只有兩館、變動機率低，故直接寫死，不做動態查詢（代理刻意保持單純、不依賴任何外部服務）。
const GYMS = {
  hsinchu: {
    header: '紅石攀岩有限公司新竹館',
    taxId: '87549069',
    addr1: '新竹市東區',
    addr2: '光復路一段75號B1',
  },
  shilin: {
    header: '紅石攀岩有限公司士林館',
    taxId: '24966621',
    addr1: '台北市士林區',
    addr2: '承德路四段261號B1',
  },
};

function buildInvoiceLines({ gymId, items, total, date, buyerTaxId }, defaultGym) {
  const g = GYMS[gymId] || GYMS[defaultGym];
  const dateStr = date || (() => {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  })();
  const itemList = Array.isArray(items) && items.length ? items : [];
  const itemLines = itemList.map((it) => {
    const name = String(it.name || '');
    const qty = Number(it.qty || 1);
    const price = Number(it.price || 0);
    const subtotal = qty * price;
    const right = `${price}*${qty}=${subtotal}`;
    const padCount = Math.max(1, LINE_WIDTH - displayWidth(name) - displayWidth(right));
    return name + ' '.repeat(padCount) + right;
  });
  // total 由呼叫端（RedRock 後端/前端）權威提供；缺省才用品項合計備援（代理不做金額判斷）
  const totalAmount = total != null ? Number(total) : itemList.reduce((s, it) => s + Number(it.qty || 1) * Number(it.price || 0), 0);

  const lines = [
    g.header,
    center(`統編：${g.taxId}`),
    center(g.addr1),
    center(g.addr2),
    dateStr,
    ...itemLines,
    `合計：      ${money(totalAmount)}`,
  ];
  if (buyerTaxId) {
    lines.push(`買受人統編：${buyerTaxId}`);
  }
  lines.push(center('以下空白'));
  return lines;
}

// 把排版好的內容行組成待送出的 Big5 位元組（含每行間的行距空行；不含 ESC_INIT/FORM_FEED，
// 那兩個是控制碼、由呼叫端各自的傳輸層加上）。
function encodeLinesToBig5(lines) {
  return lines.map((l) => big5(l + '\n'.repeat(1 + LINE_SPACING)));
}

module.exports = { GYMS, LINE_WIDTH, LINE_SPACING, big5, displayWidth, center, money, buildInvoiceLines, encodeLinesToBig5 };
