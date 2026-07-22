/**
 * 排班表 Service
 *
 * 排班單位：整天指派 (full_day) 或自由時段 (custom，填開始/結束時間)
 * 編排權限：各館管理員編自己館、super_admin編全部（由route層的checkPermission控管）
 * 員工查詢：可查看自己館整月所有人的班表，唯讀
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const { taiwanToday } = require('../utils/taiwanDate');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const MAX_RECURRING_MONTHS = 3;

// ── 排班通知輔助 ─────────────────────────────────────────────────
const GYM_NAMES = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };
const gymName = (g) => GYM_NAMES[g] || g || '';
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const shiftTimeLabel = (type, startTime, endTime) =>
  type === 'full_day' ? '全天' : `${startTime || ''}~${endTime || ''}`;

// 站內通知：發到「被排班員工的個人帳號」（targetStaffId）。全程 try/catch，永不影響排班主流程。
const notifyShiftStaff = async ({ targetStaffId, gymId, type, title, body, referenceId }) => {
  if (!targetStaffId) return;
  try {
    await require('./notificationService').createNotification({
      gymId, targetStaffId, type, title, body, referenceId: referenceId || null, referenceType: 'shift',
    });
  } catch (e) { console.error('[排班通知] 失敗（不影響排班）:', e.message); }
};

// ── 批次建立固定週班 ──────────────────────────────────────────────
// weekdays: [0-6]（0=日）；遇休館公告該天直接跳過；遇特殊營業時間公告，
// 若該筆排班為整天班(full_day)則自動改用當天公告的特殊時段，自由時段班(custom)維持原樣不調整。
// 與既有排班共存，不檢查/阻擋衝突。
const createRecurringShifts = async ({ gymId, staffId, staffName, weekdays, type, startTime, endTime, note, rangeStart, rangeEnd, createdBy }) => {
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw { code: 'MISSING_WEEKDAYS', message: '請至少選擇一個星期幾' };
  }
  if (!['full_day', 'custom'].includes(type)) {
    throw { code: 'INVALID_TYPE', message: 'type 必須為 full_day 或 custom' };
  }
  if (type === 'custom' && (!startTime || !endTime)) {
    throw { code: 'MISSING_TIME', message: '自由時段排班需填寫開始與結束時間' };
  }
  if (!rangeStart || !rangeEnd) {
    throw { code: 'MISSING_RANGE', message: '請設定適用期間' };
  }
  const maxEnd = dayjs(rangeStart).add(MAX_RECURRING_MONTHS, 'month').format('YYYY-MM-DD');
  if (rangeEnd > maxEnd) {
    throw { code: 'RANGE_TOO_LONG', message: `適用期間最長不可超過 ${MAX_RECURRING_MONTHS} 個月` };
  }
  if (rangeStart > rangeEnd) {
    throw { code: 'INVALID_RANGE', message: '結束日期必須晚於開始日期' };
  }

  const db = getDb();
  const now = new Date();
  const batch = db.batch();

  let createdCount = 0, skippedClosed = 0, adjustedSpecial = 0, skippedDuplicate = 0;

  // ── 效能優化：一次性抓取場館資料、公告清單、既有整天班，迴圈內純記憶體運算 ──
  // （原本每一天都重新查一次DB，35-40天會循序執行70-80次查詢，導致請求耗時近10秒逼近timeout）
  const gymDoc = await db.collection(COLLECTIONS.GYMS).doc(gymId).get();
  if (!gymDoc.exists) throw { code: 'GYM_NOT_FOUND', message: '找不到指定場館' };
  const gym = gymDoc.data();

  const annoSnap = await db.collection('gymAnnouncements').where('isPublished', '==', true).get();
  const allAnnouncements = annoSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const existingFullDaySnap = type === 'full_day'
    ? await db.collection(COLLECTIONS.SCHEDULE_SHIFTS)
        .where('gymId', '==', gymId).where('staffId', '==', staffId).where('type', '==', 'full_day').get()
    : null;
  const existingFullDayDates = new Set((existingFullDaySnap?.docs || []).map(d => d.data().date));

  // 純記憶體運算版的場館狀態判斷，邏輯與 gyms.js 的 getGymStatusForDate 一致但不重新查DB
  const resolveStatusForDate = (dateStr) => {
    const dayOfWeek = ['sun','mon','tue','wed','thu','fri','sat'][dayjs(dateStr).day()];
    const dateAnnouncements = allAnnouncements.filter(a =>
      (a.gymId === gymId || a.gymId === null) &&
      a.effectiveFrom <= dateStr &&
      (a.effectiveTo === null || a.effectiveTo >= dateStr) &&
      (!a.publishAt || a.publishAt.toDate() <= now)
    );
    const closureAnnouncement = dateAnnouncements.find(a => a.type === 'closure');
    if (closureAnnouncement) return { status: 'closed' };

    const specialHours = dateAnnouncements.find(a => a.type === 'special_hours');
    if (specialHours) return { status: 'special', specialOpen: specialHours.specialOpen, specialClose: specialHours.specialClose };

    const hours = gym.regularHours?.[dayOfWeek];
    if (!hours || hours.closed) return { status: 'regular_closed' };
    return { status: 'open' };
  };

  // 追蹤這次批次內，本次執行已建立整天班的日期（尚未commit到Firestore，無法靠查詢偵測，需本地追蹤）
  const fullDayDatesInThisBatch = new Set();

  let cur = dayjs(rangeStart);
  const end = dayjs(rangeEnd);
  while (cur.isSame(end) || cur.isBefore(end)) {
    if (weekdays.includes(cur.day())) {
      const dateStr = cur.format('YYYY-MM-DD');
      const gymStatus = resolveStatusForDate(dateStr);

      if (gymStatus.status === 'closed') {
        skippedClosed++;
      } else if (type === 'full_day' && (fullDayDatesInThisBatch.has(dateStr) || existingFullDayDates.has(dateStr))) {
        skippedDuplicate++;
      } else {
        let shiftStartTime = startTime, shiftEndTime = endTime;
        if (type === 'full_day' && gymStatus.status === 'special' && gymStatus.specialOpen && gymStatus.specialClose) {
          shiftStartTime = gymStatus.specialOpen;
          shiftEndTime = gymStatus.specialClose;
          adjustedSpecial++;
        }

        const shiftId = uuidv4();
        batch.set(db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(shiftId), {
          id: shiftId, gymId, staffId, staffName, date: dateStr,
          type,
          startTime: type === 'custom' ? startTime : (shiftStartTime || null),
          endTime: type === 'custom' ? endTime : (shiftEndTime || null),
          note: note || '',
          isRecurring: true,
          specialAdjusted: type === 'full_day' && gymStatus.status === 'special',
          createdBy, createdAt: now, updatedAt: now,
        });
        if (type === 'full_day') fullDayDatesInThisBatch.add(dateStr);
        createdCount++;
      }
    }
    cur = cur.add(1, 'day');
  }

  await batch.commit();

  // 批次建立 → 只發「一則彙總」通知（避免一班一則洗版）；沒建成任何班就不發
  if (createdCount > 0) {
    const wdLabel = [...weekdays].sort((a, b) => a - b).map(d => WEEKDAY_LABELS[d]).join('、');
    await notifyShiftStaff({
      targetStaffId: staffId, gymId, type: 'shift_assigned',
      title: '新排班通知',
      body: `你被排定 ${rangeStart}~${rangeEnd} 每週 ${wdLabel} ${shiftTimeLabel(type, startTime, endTime)}，共 ${createdCount} 個班 @ ${gymName(gymId)}`,
    });
  }

  return { createdCount, skippedClosed, skippedDuplicate, adjustedSpecial };
};

// ── 檢查某員工某天是否已有整天班（同一人同一天最多一筆整天班，但可搭配自由時段班）──
const hasExistingFullDayShift = async (gymId, staffId, date, excludeShiftId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.SCHEDULE_SHIFTS)
    .where('gymId', '==', gymId)
    .where('staffId', '==', staffId)
    .where('date', '==', date)
    .where('type', '==', 'full_day')
    .get();
  return snap.docs.some(d => d.id !== excludeShiftId);
};

// ── 建立排班 ──────────────────────────────────────────────────────
const createShift = async ({ gymId, staffId, staffName, date, type, startTime, endTime, note, createdBy, source, courseId, courseName }) => {
  if (!['full_day', 'custom'].includes(type)) {
    throw { code: 'INVALID_TYPE', message: 'type 必須為 full_day 或 custom' };
  }
  if (type === 'custom' && (!startTime || !endTime)) {
    throw { code: 'MISSING_TIME', message: '自由時段排班需填寫開始與結束時間' };
  }
  if (type === 'custom' && startTime >= endTime) {
    throw { code: 'INVALID_TIME_RANGE', message: '結束時間必須晚於開始時間' };
  }
  if (type === 'full_day' && await hasExistingFullDayShift(gymId, staffId, date)) {
    throw { code: 'DUPLICATE_FULL_DAY', message: '此員工當天已有一筆整天班，同一人同一天最多一筆整天班' };
  }

  const db = getDb();
  const shiftId = uuidv4();
  const now = new Date();
  const shift = {
    id: shiftId, gymId, staffId, staffName, date,
    type,
    startTime: type === 'custom' ? startTime : null,
    endTime: type === 'custom' ? endTime : null,
    note: note || '',
    source: source || 'manual',              // 'manual'=值班排班 / 'course'=課程帶入(教練授課班)
    courseId: courseId || null,
    courseName: courseName || null,
    createdBy, createdAt: now, updatedAt: now,
  };
  await db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(shiftId).set(shift);

  // 即時通知被排班員工（不阻斷）
  await notifyShiftStaff({
    targetStaffId: staffId, gymId, type: 'shift_assigned', referenceId: shiftId,
    title: '新排班通知',
    body: `你被排班：${date} ${shiftTimeLabel(type, startTime, endTime)} @ ${gymName(gymId)}`,
  });

  return shift;
};

// ── 更新排班 ──────────────────────────────────────────────────────
const updateShift = async (shiftId, { staffId, staffName, date, type, startTime, endTime, note }) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(shiftId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此排班' };

  if (type && !['full_day', 'custom'].includes(type)) {
    throw { code: 'INVALID_TYPE', message: 'type 必須為 full_day 或 custom' };
  }
  const finalType = type || doc.data().type;
  if (finalType === 'custom' && (startTime || endTime) && startTime >= endTime) {
    throw { code: 'INVALID_TIME_RANGE', message: '結束時間必須晚於開始時間' };
  }
  const finalDate = date !== undefined ? date : doc.data().date;
  const finalStaffId = staffId !== undefined ? staffId : doc.data().staffId;
  if (finalType === 'full_day' && await hasExistingFullDayShift(doc.data().gymId, finalStaffId, finalDate, shiftId)) {
    throw { code: 'DUPLICATE_FULL_DAY', message: '此員工當天已有一筆整天班，同一人同一天最多一筆整天班' };
  }

  const updates = { updatedAt: new Date() };
  if (staffId !== undefined) updates.staffId = staffId;
  if (staffName !== undefined) updates.staffName = staffName;
  if (date !== undefined) updates.date = date;
  if (type !== undefined) {
    updates.type = type;
    if (type === 'full_day') { updates.startTime = null; updates.endTime = null; }
  }
  if (startTime !== undefined) updates.startTime = startTime;
  if (endTime !== undefined) updates.endTime = endTime;
  if (note !== undefined) updates.note = note;

  await ref.update(updates);

  // 通知（不阻斷）：對「目前 staffId」發異動通知；若換人，另通知「原 staffId」班已被移除
  const orig = doc.data();
  const gymId = orig.gymId;
  const finalStart = updates.startTime !== undefined ? updates.startTime : orig.startTime;
  const finalEnd = updates.endTime !== undefined ? updates.endTime : orig.endTime;
  await notifyShiftStaff({
    targetStaffId: finalStaffId, gymId, type: 'shift_updated', referenceId: shiftId,
    title: '排班異動通知',
    body: `你的班已異動：${finalDate} ${shiftTimeLabel(finalType, finalStart, finalEnd)} @ ${gymName(gymId)}`,
  });
  if (staffId !== undefined && orig.staffId && orig.staffId !== finalStaffId) {
    await notifyShiftStaff({
      targetStaffId: orig.staffId, gymId, type: 'shift_updated', referenceId: shiftId,
      title: '排班異動通知',
      body: `你的 ${orig.date} 班已被調整（改由他人值班）@ ${gymName(gymId)}`,
    });
  }

  return { id: shiftId, ...orig, ...updates };
};

// ── 刪除排班 ──────────────────────────────────────────────────────
const deleteShift = async (shiftId) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(shiftId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此排班' };
  await ref.delete();
};

// ── 查詢某館某月份的所有排班（月曆檢視用）───────────────────────────
const getMonthlyShifts = async (gymId, yearMonth) => {
  // yearMonth: 'YYYY-MM'
  const db = getDb();
  const start = dayjs(`${yearMonth}-01`).format('YYYY-MM-DD');
  const end = dayjs(`${yearMonth}-01`).endOf('month').format('YYYY-MM-DD');

  const snap = await db.collection(COLLECTIONS.SCHEDULE_SHIFTS)
    .where('gymId', '==', gymId).get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.date >= start && s.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
};

// ── 取得某員工在 [fromDate, toDate]（含）內的自己排班（員工本人待辦頁用）──
const getUpcomingShiftsForStaff = async (staffId, fromDate, toDate) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.SCHEDULE_SHIFTS)
    .where('staffId', '==', staffId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.date >= fromDate && s.date <= toDate)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
};

// ── 計算某館某月份每位員工的工時統計 ─────────────────────────────────
const getMonthlyHoursSummary = async (gymId, yearMonth) => {
  const shifts = await getMonthlyShifts(gymId, yearMonth);
  const summary = {};

  // 讀取該館的標準工時設定
  const db = getDb();
  const settingsDoc = await db.collection('systemSettings').doc('scheduleHours_' + gymId).get();
  const defaultHours = { 0:11, 1:9, 2:9, 3:9, 4:9, 5:9, 6:12 };
  const standardHours = settingsDoc.exists ? settingsDoc.data().standardHours : defaultHours;

  // 課程帶入班（教練授課）：source==='course' 或舊資料 note 前綴「體驗課程」
  const isCourseShift = (s) => s.source === 'course' || String(s.note || '').startsWith('體驗課程');

  shifts.forEach(s => {
    if (!summary[s.staffId]) {
      summary[s.staffId] = { staffId: s.staffId, staffName: s.staffName, totalHours: 0, dutyHours: 0, courseHours: 0, shiftCount: 0, dutyShiftCount: 0, courseShiftCount: 0, fullDayCount: 0, customCount: 0 };
    }
    let hrs;
    if (s.type === 'full_day') {
      summary[s.staffId].fullDayCount++;
      const dow = dayjs(s.date).day(); // 0=週日
      hrs = parseFloat(standardHours[dow]) || 8;
    } else {
      summary[s.staffId].customCount++;
      const start = dayjs(`2000-01-01T${s.startTime}`);
      const end = dayjs(`2000-01-01T${s.endTime}`);
      hrs = end.diff(start, 'minute') / 60;
    }
    summary[s.staffId].shiftCount++;
    summary[s.staffId].totalHours += hrs;
    if (isCourseShift(s)) { summary[s.staffId].courseHours += hrs; summary[s.staffId].courseShiftCount++; }
    else { summary[s.staffId].dutyHours += hrs; summary[s.staffId].dutyShiftCount++; }
  });

  const r1 = (n) => Math.round(n * 10) / 10;
  return Object.values(summary).map(s => ({ ...s, totalHours: r1(s.totalHours), dutyHours: r1(s.dutyHours), courseHours: r1(s.courseHours) }));
};

// ── 清空某館某月所有排班 ─────────────────────────────────────────
const clearMonthShifts = async (gymId, yearMonth) => {
  const shifts = await getMonthlyShifts(gymId, yearMonth);
  const db = getDb();
  for (let i = 0; i < shifts.length; i += 400) {
    const batch = db.batch();
    shifts.slice(i, i + 400).forEach(s => batch.delete(db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(s.id)));
    await batch.commit();
  }
  return shifts.length;
};

// ── 複製上月排班到本月（以星期為主：第 N 個某星期 → 本月第 N 個同星期）──
const copyPreviousMonthShifts = async (gymId, targetMonth, createdBy) => {
  const prevMonth = dayjs(`${targetMonth}-01`).subtract(1, 'month').format('YYYY-MM');
  const prevShifts = await getMonthlyShifts(gymId, prevMonth);
  const db = getDb();
  const now = new Date();

  // 上月某日 → 本月對應日（同星期、同「當月第幾個該星期」）
  const targetDateFor = (prevDateStr) => {
    const d = dayjs(prevDateStr);
    const weekday = d.day();
    const nth = Math.floor((d.date() - 1) / 7) + 1; // 當月第幾個此星期
    let first = dayjs(`${targetMonth}-01`);
    while (first.day() !== weekday) first = first.add(1, 'day');
    const target = first.add((nth - 1) * 7, 'day');
    return target.format('YYYY-MM') === targetMonth ? target.format('YYYY-MM-DD') : null;
  };

  const toCreate = [];
  const seenFullDay = new Set(); // 本次複製內避免同人同日重複整天班
  for (const s of prevShifts) {
    const td = targetDateFor(s.date);
    if (!td) continue; // 本月無對應日（如第 5 個星期）→ 略過
    if (s.type === 'full_day') {
      const key = `${s.staffId}|${td}`;
      if (seenFullDay.has(key)) continue;
      if (await hasExistingFullDayShift(gymId, s.staffId, td)) continue; // 本月該員已有整天班
      seenFullDay.add(key);
    }
    toCreate.push({
      id: uuidv4(), gymId, staffId: s.staffId, staffName: s.staffName, date: td,
      type: s.type, startTime: s.startTime || null, endTime: s.endTime || null,
      note: s.note || '', createdBy, createdAt: now, updatedAt: now,
    });
  }
  for (let i = 0; i < toCreate.length; i += 400) {
    const batch = db.batch();
    toCreate.slice(i, i + 400).forEach(doc => batch.set(db.collection(COLLECTIONS.SCHEDULE_SHIFTS).doc(doc.id), doc));
    await batch.commit();
  }
  return { created: toCreate.length, prevMonth, prevCount: prevShifts.length };
};

// ── 值班前 2 天提醒（每日 9 點排程呼叫）──────────────────────────
// 查 date === 台灣今天+2 的班次，對每筆 staffId 發 shift_reminder；
// 冪等：已送過（reminderSentAt）的略過，避免每日排程重送同一班。
const runShiftReminders = async () => {
  const db = getDb();
  const targetDate = dayjs(taiwanToday()).add(2, 'day').format('YYYY-MM-DD');
  const snap = await db.collection(COLLECTIONS.SCHEDULE_SHIFTS).where('date', '==', targetDate).get();
  let sent = 0, skipped = 0;
  for (const d of snap.docs) {
    const s = d.data();
    if (s.reminderSentAt) { skipped++; continue; } // 已送過 → 略過
    if (!s.staffId) continue;
    await notifyShiftStaff({
      targetStaffId: s.staffId, gymId: s.gymId, type: 'shift_reminder', referenceId: s.id || d.id,
      title: '值班提醒',
      body: `後天(${s.date})有班：${shiftTimeLabel(s.type, s.startTime, s.endTime)} @ ${gymName(s.gymId)}`,
    });
    await d.ref.update({ reminderSentAt: new Date() }); // 標記已送（冪等）
    sent++;
  }
  return { targetDate, total: snap.size, sent, skipped };
};

module.exports = {
  createShift,
  createRecurringShifts,
  updateShift,
  runShiftReminders,
  deleteShift,
  getMonthlyShifts,
  getUpcomingShiftsForStaff,
  getMonthlyHoursSummary,
  clearMonthShifts,
  copyPreviousMonthShifts,
};
