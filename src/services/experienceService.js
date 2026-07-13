/**
 * experienceService.js — 體驗/試上預約共用邏輯（由 routes/experienceBookings.js 拆分，2026-07-13 refactor）
 * 函式本體逐字搬移、行為不變：課程/排班建立與清理・體驗入場券發放/同步/作廢・保險名冊 Excel・預設設定。
 */
const dayjs = require('dayjs');
const XLSX = require('xlsx');
const courseService = require('./courseService');
const scheduleService = require('./scheduleService');
const { taiwanToday } = require('../utils/taiwanDate');

const COURSE_TYPES = [
  { id:'general',   label:'抱石體驗課程',          priceMap:{ 1:975, 2:875, 3:875, '4-5':825, '6-8':775, '9-12':775 } },
  { id:'children',  label:'小蜘蛛人（兒童）',        price: 600 },
  { id:'skill_fri', label:'抱石技巧班（週五20:00）', price:1075 },
  { id:'skill_sun14',label:'抱石技巧班（週日14:00）',price: 900 },
];

// ── POST /experience-bookings - 送出預約 ──────────────────────────
function parseBookingTime(bookingTime) {
  const matches = String(bookingTime || '').match(/(\d{1,2}):(\d{2})/g) || [];
  const norm = (t) => { const [h, m] = t.split(':'); return `${String(parseInt(h, 10)).padStart(2, '0')}:${m}`; };
  if (matches.length >= 2) {
    const start = norm(matches[0]), end = norm(matches[1]);
    return start < end ? { startTime: start, endTime: end } : { startTime: start, endTime: null };
  }
  if (matches.length === 1) {
    const start = norm(matches[0]);
    return { startTime: start, endTime: dayjs(`2000-01-01T${start}`).add(2, 'hour').format('HH:mm') };
  }
  return { startTime: null, endTime: null };
}

async function courseTypeLabel(db, courseType) {
  const doc = await db.collection('systemSettings').doc('experienceCourses').get();
  const s = doc.exists ? doc.data() : defaultSettings();
  const ct = (s.courseTypes || []).find(c => c.id === courseType);
  return ct?.label || courseType || '體驗課程';
}

// ── 確認體驗預約時：建立課程 + 場次 + 教練當日排班 ───────────────────
// 課程/場次皆標記 source:'experience'，供會員端過濾（不出現在報名目錄）。
async function addExperienceToCourseAndSchedule(db, booking, staff, coachId, coachName) {
  const gymId = booking.gymId;
  const label = await courseTypeLabel(db, booking.courseType);
  const numPeople = booking.numParticipants || (booking.participants || []).length || 1;
  const { startTime, endTime } = parseBookingTime(booking.bookingTime);
  const name = `體驗課程・${label}・${booking.contactName || ''}`.trim();

  // 1) 建立課程（工作坊）
  const course = await courseService.createCourse({
    gymId, staffId: staff?.id || null,
    data: {
      name, description: `體驗課程預約（${numPeople} 人）`,
      type: 'workshop', category: 'experience',
      instructor: coachName || '',
      startDate: booking.bookingDate, endDate: booking.bookingDate,
      startTime, endTime,
      maxStudents: numPeople, price: booking.totalFee || 0, totalSessions: 1,
    },
  });
  await db.collection('courses').doc(course.id).update({
    source: 'experience', experienceBookingId: booking.id,
    coachId: coachId || null, coachName: coachName || '',
  });

  // 2) 建立場次
  const session = await courseService.createSession({
    courseId: course.id, gymId, staffId: staff?.id || null,
    data: {
      date: booking.bookingDate, startTime: startTime || '', endTime: endTime || '',
      maxStudents: numPeople,
      note: `體驗課程・教練：${coachName || '—'}・${numPeople} 人`,
    },
  });
  await db.collection('courseSessions').doc(session.id).update({
    source: 'experience', experienceBookingId: booking.id,
    instructor: coachName || '', coachId: coachId || null,
  });

  // 3) 排班行事曆：指派教練當日班表（重複整天班等狀況不阻斷主流程）
  let scheduleShiftId = null;
  try {
    const staffIdForShift = coachId || `expcoach_${String(coachName || 'coach').replace(/\s+/g, '')}`;
    const useCustom = !!(startTime && endTime && startTime < endTime);
    const shift = await scheduleService.createShift({
      gymId, staffId: staffIdForShift, staffName: coachName || '教練',
      date: booking.bookingDate,
      type: useCustom ? 'custom' : 'full_day',
      startTime: useCustom ? startTime : null,
      endTime: useCustom ? endTime : null,
      note: `體驗課程・${label}・${numPeople} 人`,
      createdBy: staff?.id || null,
    });
    scheduleShiftId = shift.id;
  } catch (e) {
    console.error('[體驗排班] 建立班表失敗（不阻斷）', e.message || e.code);
  }

  return { courseId: course.id, sessionId: session.id, scheduleShiftId };
}

// ── 重新指派教練：同步既有課程/場次 + 換教練排班（保證三邊一致）──────
// 用於已排課後改教練。updateShift 無法改教練，故刪舊班→建新班。
async function reassignExperienceCoach(db, booking, staff, coachId, coachName) {
  const label = await courseTypeLabel(db, booking.courseType);
  const numPeople = booking.numParticipants || (booking.participants || []).length || 1;
  const { startTime, endTime } = parseBookingTime(booking.bookingTime);

  // 1) 更新課程教練
  if (booking.courseId) {
    await db.collection('courses').doc(booking.courseId).update({
      instructor: coachName || '', coachId: coachId || null, coachName: coachName || '',
      updatedAt: new Date(),
    });
  }
  // 2) 更新場次教練
  if (booking.sessionId) {
    await db.collection('courseSessions').doc(booking.sessionId).update({
      instructor: coachName || '', coachId: coachId || null,
      note: `體驗課程・教練：${coachName || '—'}・${numPeople} 人`,
      updatedAt: new Date(),
    });
  }
  // 3) 換教練排班：刪舊班→建新班（任一步失敗只記 log，不阻斷）
  let scheduleShiftId = booking.scheduleShiftId || null;
  if (booking.scheduleShiftId) {
    try { await scheduleService.deleteShift(booking.scheduleShiftId); scheduleShiftId = null; }
    catch (e) { console.error('[體驗改教練] 刪舊班失敗（續建新班）', e.message || e.code); }
  }
  try {
    const staffIdForShift = coachId || `expcoach_${String(coachName || 'coach').replace(/\s+/g, '')}`;
    const useCustom = !!(startTime && endTime && startTime < endTime);
    const shift = await scheduleService.createShift({
      gymId: booking.gymId, staffId: staffIdForShift, staffName: coachName || '教練',
      date: booking.bookingDate,
      type: useCustom ? 'custom' : 'full_day',
      startTime: useCustom ? startTime : null,
      endTime: useCustom ? endTime : null,
      note: `體驗課程・${label}・${numPeople} 人`,
      createdBy: staff?.id || null,
    });
    scheduleShiftId = shift.id;
  } catch (e) {
    console.error('[體驗改教練] 建新班失敗（不阻斷）', e.message || e.code);
  }

  return { scheduleShiftId };
}

// ── 取消體驗：清理自動建立的課程/場次/教練排班（不阻斷退券主流程）──────
async function cleanupExperienceCourseAndSchedule(db, booking, staff) {
  const result = { courseCancelled: false, sessionCancelled: false, shiftDeleted: false };
  if (booking.sessionId) {
    try {
      await courseService.updateSession({ sessionId: booking.sessionId, staffId: staff?.id || null, data: { status: 'cancelled' } });
      result.sessionCancelled = true;
    } catch (e) { console.error('[體驗取消] 取消場次失敗', e.message || e.code); }
  }
  if (booking.courseId) {
    try {
      await db.collection('courses').doc(booking.courseId).update({ status: 'cancelled', updatedAt: new Date() });
      result.courseCancelled = true;
    } catch (e) { console.error('[體驗取消] 取消課程失敗', e.message || e.code); }
  }
  if (booking.scheduleShiftId) {
    try { await scheduleService.deleteShift(booking.scheduleShiftId); result.shiftDeleted = true; }
    catch (e) { console.error('[體驗取消] 刪教練班失敗', e.message || e.code); }
  }
  return result;
}

// ── POST /experience-bookings/:id/confirm - 確認收款（可指定教練→排課/排班/改教練）──
// ── 體驗入場券：發放/同步（員工手動）與作廢 helper ──────────────────
const { v4: _uuid } = require('uuid');
const EXP_TICKET_COLL = 'singleEntryTickets';

// 依 numParticipants 同步體驗入場券數量。allowInitialIssue=true 才允許從 0 發放；
// 否則只在「已發過券」時同步（加人補發 active、減人作廢多餘 active；不動 used）。
async function syncExperienceTickets(db, booking, staff, allowInitialIssue) {
  const target = booking.numParticipants || (booking.participants || []).length || 0;
  const snap = await db.collection(EXP_TICKET_COLL).where('experienceBookingId', '==', booking.id).get();
  const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const active = tickets.filter(t => t.status === 'active');
  const usedCount = tickets.filter(t => t.status === 'used').length;
  const currentTotal = active.length + usedCount;
  if (currentTotal === 0 && !allowInitialIssue) return { issued: 0, voided: 0, total: currentTotal };
  const now = new Date();
  const todayTW = taiwanToday();
  let issued = 0, voided = 0;
  if (target > currentTotal) {
    const batch = db.batch();
    for (let i = 0; i < target - currentTotal; i++) {
      const id = _uuid();
      batch.set(db.collection(EXP_TICKET_COLL).doc(id), {
        id, memberId: booking.memberId || null, memberName: booking.contactName || '',
        originalMemberId: booking.memberId || null, gymId: booking.gymId || null,
        ticketType: 'experience', validDate: booking.bookingDate || null, experienceBookingId: booking.id,
        issuedAt: todayTW, expiresAt: booking.bookingDate || todayTW,
        amount: 0, paymentMethod: 'free', status: 'active',
        approvalDeadline: null, approvedAt: now, approvedBy: staff?.id || null,
        cancelledAt: null, cancelledBy: null, cancelReason: null,
        transferHistory: [], usedAt: null, usedCheckInId: null,
        soldByStaffId: staff?.id || null, soldByStaffName: staff?.name || '',
        notes: `體驗入場券：${booking.courseType || ''} ${booking.bookingDate || ''}`,
        createdAt: now, updatedAt: now,
      });
      issued++;
    }
    await batch.commit();
  } else if (target < currentTotal) {
    const toVoid = Math.min(currentTotal - target, active.length);
    const batch = db.batch();
    for (let i = 0; i < toVoid; i++) {
      batch.update(db.collection(EXP_TICKET_COLL).doc(active[i].id), { status: 'cancelled', cancelledAt: now, cancelReason: '參加人數調整', updatedAt: now });
      voided++;
    }
    if (toVoid) await batch.commit();
  }
  // 回寫「已發放張數」到預約（供前端按鈕切換為「已發放入場券」）
  const ticketsIssued = currentTotal + issued - voided;
  await db.collection('experienceBookings').doc(booking.id).update({ ticketsIssued, ticketsIssuedAt: now, updatedAt: now });
  return { issued, voided, total: target, ticketsIssued };
}

async function voidExperienceTickets(db, bookingId, reason) {
  const snap = await db.collection(EXP_TICKET_COLL).where('experienceBookingId', '==', bookingId).get();
  const batch = db.batch(); let n = 0;
  snap.docs.forEach(d => {
    if (d.data().status === 'active') { // 只作廢未使用；已 used 不動
      batch.update(d.ref, { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason || '體驗取消', updatedAt: new Date() });
      n++;
    }
  });
  if (n) await batch.commit();
  return n;
}

// ── POST /experience-bookings/:id/issue-tickets - 發放體驗入場券（員工手動）──
function buildInsuranceXlsBuffer(bookings) {
    // 工具函式
    const parseRocBirthday = (bStr) => {
      // 輸入可能是 920110(6位) 或 0920110(7位)，統一轉為 Date
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return null;
      let rocYear, mm, dd;
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        rocYear = yy <= 20 ? 100 + yy : yy; // 00-20 → 100-120
        mm = parseInt(s.slice(2, 4)) || 1;
        dd = parseInt(s.slice(4, 6)) || 1;
      } else {
        rocYear = parseInt(s.slice(0, 3));
        mm = parseInt(s.slice(3, 5)) || 1;
        dd = parseInt(s.slice(5, 7)) || 1;
      }
      return new Date(rocYear + 1911, mm - 1, dd);
    };

    const toRoc7 = (bStr) => {
      // 轉成 7 位民國格式 YYYMMDD
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return '';
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        const rocYear = yy <= 20 ? 100 + yy : yy;
        return String(rocYear).padStart(3, '0') + s.slice(2).padStart(4, '0');
      }
      return s.padStart(7, '0');
    };

    const calcAge = (birthdayDate, onDate) => {
      if (!birthdayDate || isNaN(birthdayDate)) return 99;
      let age = onDate.getFullYear() - birthdayDate.getFullYear();
      const m = onDate.getMonth() - birthdayDate.getMonth();
      if (m < 0 || (m === 0 && onDate.getDate() < birthdayDate.getDate())) age--;
      return age;
    };

    // 彙整所有參加者，並依活動日計算年齡
    const adults = [];   // 15歲以上
    const children = []; // 未滿15歲
    bookings.forEach(b => {
      const activityDate = new Date(b.bookingDate);
      (b.participants || []).forEach(p => {
        const bd = parseRocBirthday(p.birthday);
        const age = calcAge(bd, activityDate);
        const row = {
          name: p.name || '',
          idNumber: p.idNumber || '',
          birthday: toRoc7(p.birthday),
        };
        if (age >= 15) adults.push(row);
        else children.push(row);
      });
    });

    // 產生 XLS（使用 xlsx 套件）
    const headers = [
      '被保險人姓名\n(必填)\n※主被保險人放第一列',
      '被保險人ID\n(必填)',
      '出生日期\n(必填)',
      '英文姓名\n',
      '護照號碼\n',
      '投保實支\n',
      '監護宣告\n',
      '受益人姓名\n(法定繼承人不須輸入)',
      '行動電話廠牌型號',
      '受益人ID\n(超過二等親時必入)',
      '受益人與被保險人關係(請填寫代碼)\n01 本人、02 配偶、03 子女、04 父母、05 配偶父母、06 兄弟姐妹、07 (外)祖父母、08 (外)孫子女、09 其他、13 父子、14 父女、15 母子、16 母女、17 (外)祖孫',
      '受益人備註',
      '自主管理',
      '投保法傳',
    ];

    const makeSheet = (rows) => {
      const data = [headers, ...rows.map(r => [r.name, r.idNumber, r.birthday, '', '', '', '', '', '', '', '', '', '', ''])];
      return sanitizeSheet(XLSX.utils.aoa_to_sheet(data));
    };

    const wb = XLSX.utils.book_new();
    const ws1 = makeSheet(adults);
    const ws2 = makeSheet(children);
    ws1['!cols'] = [14, 14, 10, 12, 12, 8, 8, 14, 14, 14, 40, 12, 8, 8].map(w => ({ wch: w }));
    ws2['!cols'] = ws1['!cols'];
    XLSX.utils.book_append_sheet(wb, ws1, '成人名冊（15歲以上）');
    XLSX.utils.book_append_sheet(wb, ws2, '未成年名冊（未滿15歲）');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

// ── GET /experience-bookings/insurance-download - 下載保險名冊 XLS ──
function defaultSettings() {
  return {
    description: '想要攀岩，卻總是不得其門而入？紅石抱石體驗課程專為新手設計，從安全守則、攀爬規則、熱身、手/腳動作技巧到路線示範，由教練全程指導。',
    notice: '請先透過粉絲頁確認日期時間後再填寫。費用含入場、岩鞋租借、教練費及一日活動保險，一經投保恕無法退保。',
    paymentDeadlineDays: 3,
    bankInfo: {
      hsinchu: { bankName: '台新銀行(812)', branch: '關東橋分行', account: '21000100211430', accountName: '紅石攀岩有限公司' },
      shilin:  { bankName: '富邦銀行(012)', branch: '竹北分行', account: '746102003014', accountName: '紅石攀岩有限公司' },
    },
    courseTypes: [
      { id:'general',    label:'抱石體驗課程',           active:true, needsInsurance:true,
        pricingType:'tiered',
        tiers:[{min:1,max:1,price:975},{min:2,max:3,price:875},{min:4,max:5,price:825},{min:6,max:12,price:775}],
        durationNote:'1~2小時' },
      // 小蜘蛛人（兒童）/抱石技巧班 已移除：併入「班別試上」報名（小蜘蛛人入門班/技巧班）
    ],
    // 保險名冊一鍵寄送設定
    insuranceRecipientEmail: '',   // 全館共用收件人 email
    insuranceEmailTemplate: '{title}', // 信件內容公版（可用 {title} {gym} {date} {name} {count}）
    hsinchu: { bankInfo: null }, // 新竹館可覆蓋匯款帳號
  };
}

// ── POST /experience-bookings/expire-unpaid - 到期未付款自動取消 ──
// 可設定 cron 每天執行，或加入待辦總覽手動觸發
module.exports = { COURSE_TYPES, parseBookingTime, courseTypeLabel, addExperienceToCourseAndSchedule, reassignExperienceCoach, cleanupExperienceCourseAndSchedule, EXP_TICKET_COLL, syncExperienceTickets, voidExperienceTickets, buildInsuranceXlsBuffer, defaultSettings };
