/**
 * 定期票期限補償（動態即時重算）
 *
 * 規則：
 * - 效期基準仍為建立時的 90 曆日到期日（存於 pass.endDate，不改動）。
 * - 「臨時休館」（gymAnnouncements type='closure'，特殊/臨時停業）落在票期內 → 每天延長票期一天。
 * - 每週固定公休（gym.regularHours[星期].closed，如士林週一）→ 不補償。
 * - 全館票（scope='shared'）：僅在「當天沒有任何館可入場，且至少一館為臨時休館」時才補
 *   （只有單館臨時休館、另一館照常開 → 會員仍可去另一館，不補）。
 * - 單館票（scope='single'）：該館當天為臨時休館即補。
 * - 補償後票期變長，可能納入更後面的臨時休館日 → 反覆補到穩定為止（有安全上限）。
 *
 * 不改存檔的 endDate；以動態計算 effectiveEndDate 供入場資格與顯示使用。
 */
const dayjs = require('dayjs');
const { getDb, COLLECTIONS } = require('../config/firebase');

const ANNOUNCE_COLLECTION = 'gymAnnouncements';
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_EXTENSION_DAYS = 365; // 安全上限，避免異常資料造成無限延長

// 預載一次：啟用中場館（含 regularHours）+ 已發布公告
async function loadClosureContext() {
  const db = getDb();
  const now = new Date();
  const [gymSnap, annoSnap] = await Promise.all([
    db.collection(COLLECTIONS.GYMS).where('status', '==', 'active').get(),
    db.collection(ANNOUNCE_COLLECTION).where('isPublished', '==', true).get(),
  ]);
  const gyms = gymSnap.docs.map(d => ({ id: d.id, regularHours: d.data().regularHours || {} }));
  const announcements = annoSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => !a.publishAt || (a.publishAt.toDate && a.publishAt.toDate() <= now));
  return { gyms, announcements };
}

// 單館單日狀態（純記憶體，鏡射 gyms.js getGymStatusForDate 的判定順序，不打 DB）
// 回傳：'closed'(臨時休館) | 'special_closed'(特殊營業時間但關) | 'open' | 'regular_closed'(公休)
function gymStatusLocal(gym, announcements, dateStr) {
  const anns = announcements.filter(a =>
    (a.gymId === gym.id || a.gymId == null) &&
    a.effectiveFrom <= dateStr &&
    (a.effectiveTo == null || a.effectiveTo >= dateStr)
  );
  if (anns.some(a => a.type === 'closure')) return 'closed';
  const sh = anns.find(a => a.type === 'special_hours');
  if (sh) return (sh.specialOpen !== '00:00' || sh.specialClose !== '00:00') ? 'open' : 'special_closed';
  const h = gym.regularHours?.[DOW[dayjs(dateStr).day()]];
  if (!h || h.closed) return 'regular_closed';
  return 'open';
}

// 該日對此票是否「可補償」（臨時休館才算，公休不算）
function isCompensableDay(pass, ctx, dateStr) {
  const isShared = pass.scope === 'shared' || pass.scope === 'all';
  if (!isShared) {
    const gymId = pass.targetGymId || pass.gymId;
    const gym = ctx.gyms.find(g => g.id === gymId);
    if (!gym) return false;
    return gymStatusLocal(gym, ctx.announcements, dateStr) === 'closed';
  }
  // 全館票：無任一館可入場，且至少一館為臨時休館 → 補
  let anyOpen = false;
  let anySpecialClosure = false;
  for (const gym of ctx.gyms) {
    const st = gymStatusLocal(gym, ctx.announcements, dateStr);
    if (st === 'open') anyOpen = true;
    if (st === 'closed') anySpecialClosure = true;
  }
  return !anyOpen && anySpecialClosure;
}

function countCompensable(pass, ctx, startStr, endStr) {
  let count = 0;
  const end = dayjs(endStr);
  for (let cur = dayjs(startStr); !cur.isAfter(end); cur = cur.add(1, 'day')) {
    if (isCompensableDay(pass, ctx, cur.format('YYYY-MM-DD'))) count++;
  }
  return count;
}

// 動態計算補償後到期日（字串 YYYY-MM-DD）；無 start/end 時原樣回傳
function computeEffectiveEndDate(pass, ctx) {
  const base = pass.endDate;
  if (!pass.startDate || !base) return base || null;
  let end = base;
  for (let i = 0; i < 400; i++) {
    const comp = Math.min(countCompensable(pass, ctx, pass.startDate, end), MAX_EXTENSION_DAYS);
    const newEnd = dayjs(base).add(comp, 'day').format('YYYY-MM-DD');
    if (newEnd === end) break;
    end = newEnd;
  }
  return end;
}

// 便利：載入一次 context，為多張票計算 effectiveEndDate
async function attachEffectiveEndDates(passes) {
  if (!passes || passes.length === 0) return passes || [];
  const ctx = await loadClosureContext();
  return passes.map(p => ({ ...p, effectiveEndDate: computeEffectiveEndDate(p, ctx) }));
}

module.exports = {
  loadClosureContext,
  computeEffectiveEndDate,
  isCompensableDay,
  attachEffectiveEndDates,
};
