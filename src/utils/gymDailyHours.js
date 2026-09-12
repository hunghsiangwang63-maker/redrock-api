/**
 * 場館「特殊營業時間」逐日／逐館時段解析（gymAnnouncements type='special_hours'）。
 *
 * 供 routes/gyms.js（今日營業狀態）、services/passExpiryService.js（定期票臨停補償）、
 * services/scheduleService.js（排班自動產生時段調整）三處共用單一判定邏輯——避免各自
 * 維護一份「找出當天生效時段」的算法、改一處忘了同步另外兩處（本專案過去反覆踩過這類坑）。
 *
 * dailyHours 列格式：{ date:'YYYY-MM-DD', gymId: 特定館別id | null(兩館皆同), open:'HH:MM', close:'HH:MM' }
 * 向下相容：舊格式公告（無 dailyHours 或空陣列）沿用公告本身的 specialOpen/specialClose，
 * 對 effectiveFrom~effectiveTo 整段效期套用同一組時段（維持原本行為，不受影響）。
 */

// 找出某個 type='special_hours' 公告在 (gymId, dateStr) 當天實際生效的時段。
// 呼叫端需自行先把 announcements 篩到「與此 gymId／此日期在效期內」的範圍（各呼叫端既有
// 的篩選邏輯不變，這裡只處理「篩出來的公告裡，這天這館實際該套用哪組時間」）。
// 回傳 { announcement, open, close } 或 null（此公告的 dailyHours 沒有對應這天/這館的列，
// 代表這天不受此公告影響，呼叫端應視為未命中、繼續往下判斷標準營業時間或其他公告）。
function resolveSpecialHoursForDay(specialAnnouncement, gymId, dateStr) {
  if (!specialAnnouncement) return null;
  const rows = specialAnnouncement.dailyHours;
  if (!rows || !rows.length) {
    // 舊格式：整段效期套用同一組時段，與 gymId 無關（公告本身的 gymId 範圍已由呼叫端篩過）。
    return { announcement: specialAnnouncement, open: specialAnnouncement.specialOpen, close: specialAnnouncement.specialClose };
  }
  const row = rows.find(r => r.date === dateStr && (!r.gymId || r.gymId === gymId));
  if (!row) return null;
  return { announcement: specialAnnouncement, open: row.open, close: row.close };
}

// 在一批已篩過（gymId/效期）範圍的公告中，找出 (gymId, dateStr) 當天第一個「有命中」的
// special_hours 公告（多筆重疊時，逐一嘗試直到有命中為止，而非只看陣列第一筆——避免混合
// 型公告（部分日期用 dailyHours、部分日期落空）誤判整份不適用）。
function findMatchingSpecialHours(dateAnnouncements, gymId, dateStr) {
  for (const a of dateAnnouncements) {
    if (a.type !== 'special_hours') continue;
    const resolved = resolveSpecialHoursForDay(a, gymId, dateStr);
    if (resolved) return resolved;
  }
  return null;
}

module.exports = { resolveSpecialHoursForDay, findMatchingSpecialHours };
