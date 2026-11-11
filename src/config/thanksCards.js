// 感恩節感謝卡片（2026-11-22 ～ 2026-11-29 開放寄送；收到的卡片顯示到 2026-12-06）。
// 句子與貼紙一律「預設選項」，會員不能自由打字（避免騷擾／不當內容）；文字三語版本在前端，這裡只放 id 與中文（供員工通知用）。
const SEND_START = '2026-11-22';
const SEND_END = '2026-11-29';
const INBOX_UNTIL = '2026-12-06';
const MAX_PER_PAIR = 3;            // 同一人對同一位收件人最多 3 張，不限寄給幾個人
const LOOKUP_LIMIT_PER_HOUR = 20;  // 以手機查詢收件人的頻率上限（防止用來掃會員名單）

const PHRASES = {
  p1: '謝謝你，有你真好！',
  p2: '感謝你的陪伴與鼓勵！',
  p3: '謝謝你教我攀岩！',
  p4: '感謝你的照顧與幫助！',
  p5: '一起爬的日子好開心！',
  p6: '你是我最棒的岩友！',
  p7: '感恩有你，一起放手爬！',
  p8: '祝你感恩節快樂，天天平安！',
};
const STICKERS = ['pumpkin', 'maple', 'ginkgo', 'acorn', 'wheat', 'pie'];

const tpDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

module.exports = { SEND_START, SEND_END, INBOX_UNTIL, MAX_PER_PAIR, LOOKUP_LIMIT_PER_HOUR, PHRASES, STICKERS, tpDate };
