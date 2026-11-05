/**
 * 裝置識別碼 cookie（伺服器核發，HttpOnly，約 400 天）
 *
 * 起因：裝置綁定原本只靠前端存在 localStorage 的 device_token，瀏覽器清除網站資料／Safari 7 天清除／
 * 無痕視窗都會讓識別碼消失，同一台電腦同一個帳號就得重新驗證（2026-11-05 使用者反映）。
 * 現在由後端在登入成功時把識別碼同時寫成 cookie；之後識別碼以「cookie 優先、body（localStorage）其次」決定，
 * 即使 localStorage 被清掉，只要 cookie 還在就仍是同一台裝置。舊用戶端（只帶 body）行為不變。
 * 既有已信任裝置：下次成功登入時，cookie 會被設成它原本的 body 識別碼，信任紀錄自動沿用。
 */
const COOKIE_NAME = 'rr_device';
const MAX_AGE_SEC = 400 * 24 * 60 * 60; // Chrome 對 cookie 效期上限 400 天
const VALID = /^[A-Za-z0-9_-]{8,100}$/;

const readCookie = (req) => {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return VALID.test(v) ? v : null;
    }
  }
  return null;
};

// 本次請求採用的裝置識別碼：cookie 優先，否則用前端送來的 deviceToken（格式不合者視為沒有）
const resolveDeviceToken = (req) => {
  const fromCookie = readCookie(req);
  if (fromCookie) return fromCookie;
  const b = req.body?.deviceToken;
  return (typeof b === 'string' && VALID.test(b)) ? b : null;
};

// SameSite=None＋Secure：員工端同網域（staff.→api.redrocktaiwan.com）與 *.web.app 備用網址都能帶；
// 沒有識別碼（舊用戶端）就不設。
const setDeviceCookie = (res, token) => {
  if (!token || !VALID.test(token)) return;
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${MAX_AGE_SEC}; Path=/; Secure; HttpOnly; SameSite=None`);
};

module.exports = { readCookie, resolveDeviceToken, setDeviceCookie, COOKIE_NAME };
