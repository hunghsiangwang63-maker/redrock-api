/**
 * Storage 私有物件 → 短效簽名 URL
 * 取代 makePublic：物件保持私有，需要顯示時才產生有時效的簽名 URL。
 * 相容兩種儲存值：
 *   - 新格式：物件路徑（如 waivers/xxx.png）
 *   - 舊格式：公開 URL（https://storage.googleapis.com/<bucket>/waivers/xxx.png）→ 取出路徑再簽
 * 失敗一律回原值（不讓簽名錯誤中斷主要回應）。
 */
const { getStorage } = require('../config/firebase');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小時

async function signedRead(pathOrUrl, ttlMs = DEFAULT_TTL_MS) {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return pathOrUrl || null;
  if (pathOrUrl.startsWith('data:')) return pathOrUrl; // 內嵌 base64 → 原樣回傳（新格式）
  try {
    const bucket = getStorage().bucket();
    const pubPrefix = `https://storage.googleapis.com/${bucket.name}/`;
    let path = pathOrUrl;
    if (pathOrUrl.startsWith(pubPrefix)) {
      path = decodeURIComponent(pathOrUrl.slice(pubPrefix.length).split('?')[0]);
    } else if (/^https?:\/\//i.test(pathOrUrl)) {
      return pathOrUrl; // 非本 bucket 的外部連結，原樣回傳
    }
    const [url] = await bucket.file(path).getSignedUrl({ action: 'read', expires: Date.now() + ttlMs });
    return url;
  } catch (e) {
    return pathOrUrl;
  }
}

// 就地把物件內指定欄位（可能為路徑或舊公開 URL）換成簽名 URL
async function signFields(obj, fields, ttlMs = DEFAULT_TTL_MS) {
  if (!obj) return obj;
  for (const f of fields) {
    if (obj[f]) obj[f] = await signedRead(obj[f], ttlMs);
  }
  return obj;
}

module.exports = { signedRead, signFields };
