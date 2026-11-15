// 季節感謝卡片（會員互送／送給教練與櫃檯）。每一季一份設定（開放日期、收件匣到期、句子、貼紙）；新增一季只要在 SEASONS 加一筆。
// 句子與貼紙一律「預設選項」，會員不能自由打字（避免騷擾／不當內容）；文字三語版本在前端（season 設定），這裡只放 id 與中文（供員工通知用）。
// 感恩節：2026-11-22 ～ 2026-11-29 開放寄送；收到的卡片顯示到 2026-12-06。
const MAX_PER_PAIR = 3;            // 同一人對同一位收件人「每一季」最多 3 張，不限寄給幾個人
const LOOKUP_LIMIT_PER_HOUR = 20;  // 以手機查詢收件人的頻率上限（防止用來掃會員名單）

const THANKSGIVING_PHRASES = {
  p1: '謝謝你，有你真好！',
  p2: '感謝你的陪伴與鼓勵！',
  p3: '謝謝你教我攀岩！',
  p4: '感謝你的照顧與幫助！',
  p5: '一起爬的日子好開心！',
  p6: '你是我最棒的岩友！',
  p7: '感恩有你，一起放手爬！',
  p8: '祝你感恩節快樂，天天平安！',
  // 俏皮打氣（攀岩哏；2026-11-11 加）
  p9: '跳出去就有了！',
  p10: '這條你一定行，相信自己！',
  p11: '放手爬，保護交給我！',
  p12: '今天的你比昨天更強！',
  p13: '卡關沒關係，休息一下再來！',
  p14: '手抓緊，心放鬆，加油！',
  p15: '下一條紅點就是你的！',
  p16: '你笑著爬的樣子最棒！',
  p17: '慢慢爬也沒關係，風景都一樣好！',
  p18: '掉下來只是重來一次，再來！',
};
const THANKSGIVING_STICKERS = ['pumpkin', 'maple', 'ginkgo', 'acorn', 'wheat', 'pumpkin2', 'star', 'cranberry', 'maple2', 'pie', 'cocoa', 'candy', 'pumpkinpie', 'hat', 'sunflower', 'turkey', 'apple', 'greenpumpkin'];


// 每一季：key、sendStart／sendEnd（含首尾，台灣日期）、inboxUntil（收件匣顯示到此日）、phrases（id→中文）、stickers（id 清單）
const SEASONS = {
  thanksgiving: {
    key: 'thanksgiving',
    sendStart: '2026-11-22', sendEnd: '2026-11-29', inboxUntil: '2026-12-06',
    phrases: THANKSGIVING_PHRASES, stickers: THANKSGIVING_STICKERS,
  },
};

const tpDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const seasonList = () => Object.values(SEASONS);
// 今天正在開放寄送的季節（沒有＝null）
const activeSendSeason = (today = tpDate()) => seasonList().find(x => today >= x.sendStart && today <= x.sendEnd) || null;
// 今天收件匣仍顯示的季節（寄送期間＋之後到 inboxUntil；多季重疊時取開始日最晚者）
const inboxSeason = (today = tpDate()) => seasonList().filter(x => today >= x.sendStart && today <= x.inboxUntil).sort((a, b) => b.sendStart.localeCompare(a.sendStart))[0] || null;
const getSeason = (key) => SEASONS[key] || null;

module.exports = {
  SEASONS, getSeason, activeSendSeason, inboxSeason, MAX_PER_PAIR, LOOKUP_LIMIT_PER_HOUR, tpDate,
  // 舊匯出（單季時期的名稱，保留相容；等同感恩節）
  SEND_START: SEASONS.thanksgiving.sendStart, SEND_END: SEASONS.thanksgiving.sendEnd, INBOX_UNTIL: SEASONS.thanksgiving.inboxUntil,
  PHRASES: THANKSGIVING_PHRASES, STICKERS: THANKSGIVING_STICKERS,
};
