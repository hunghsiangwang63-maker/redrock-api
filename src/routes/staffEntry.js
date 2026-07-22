/*
 * staffEntry.js — 員工入館 QR
 *  正職員工/管理員：免費入場
 *  兼職人員：依「上一個曆月」排班表排定的【值班】時數（scheduleShifts，排除課程帶入班）分級——
 *    ≥ 40 小時 → 次月免費；≥ 20 小時 → 次月半價（單次入場半價）；< 20 小時 → 一般價
 *  流程：員工個人登入 → 產生 QR（staffentry:<token>）→ 站台掃碼預覽 → 確認（記 checkIns、付費部分現場收現金）
 */
const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { authenticate, requireManagerOrStation } = require('../middleware/auth');
const { getEntryTypePrice } = require('../services/checkin/pricing');
const { taiwanToday } = require('../utils/taiwanDate');

// 整天班標準工時預設（與排班工時統計 getMonthlyHoursSummary 同一套；各星期幾，0=週日）
const DEFAULT_STD_HOURS = { 0: 11, 1: 9, 2: 9, 3: 9, 4: 9, 5: 9, 6: 12 };

// 上一個曆月（台灣時區）「排班表排定」的時數（小時，含小數）
// custom＝結束−開始；full_day＝用「該館排班標準工時設定」的該星期幾時數
//（systemSettings/scheduleHours_<gymId>.standardHours，與工時統計同一套；未設則 DEFAULT_STD_HOURS）。
const getLastMonthHours = async (db, staffId) => {
  const start = dayjs(taiwanToday()).startOf('month').subtract(1, 'month');
  const end = start.endOf('month');
  const startStr = start.format('YYYY-MM-DD');
  const endStr = end.format('YYYY-MM-DD');
  const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const snap = await db.collection('scheduleShifts').where('staffId', '==', staffId).get();
  // 只算「值班工時」；排除課程帶入班（體驗教練授課，source:'course' 或舊資料 note 前綴「體驗課程」）
  const isCourseShift = (s) => s.source === 'course' || String(s.note || '').startsWith('體驗課程');
  const shifts = snap.docs.map(d => d.data()).filter(s => s.date && s.date >= startStr && s.date <= endStr && !isCourseShift(s));
  // 各館標準工時設定快取（與排班工時統計同一份 systemSettings/scheduleHours_<gymId>）
  const stdCache = {};
  const stdHoursOf = async (gymId) => {
    if (stdCache[gymId] !== undefined) return stdCache[gymId];
    const doc = await db.collection('systemSettings').doc('scheduleHours_' + gymId).get();
    stdCache[gymId] = (doc.exists && doc.data().standardHours) ? doc.data().standardHours : DEFAULT_STD_HOURS;
    return stdCache[gymId];
  };
  let mins = 0;
  for (const s of shifts) {
    if (s.startTime && s.endTime) {
      const dur = hm(s.endTime) - hm(s.startTime);
      if (dur > 0) mins += dur;
    } else if (s.type === 'full_day') {
      const std = await stdHoursOf(s.gymId);
      const hrs = parseFloat(std[dayjs(s.date).day()]) || 8; // 0=週日
      mins += hrs * 60;
    }
  }
  return Math.round((mins / 60) * 10) / 10; // 小時，1 位小數
};

// 計算員工入館資格與金額
const computeEligibility = async (db, staff) => {
  const monthLabel = dayjs(taiwanToday()).format('YYYY-MM');
  const single = await getEntryTypePrice('single_ticket', 300);
  const role = staff.role;
  if (['super_admin', 'gym_manager', 'full_time'].includes(role)) {
    return { fee: 0, free: true, tier: 'full', role, monthLabel, reason: '正職員工免費入場' };
  }
  if (role === 'part_time') {
    const hours = await getLastMonthHours(db, staff.id);
    if (hours >= 40) return { fee: 0, free: true, tier: 'free', role, hours, single, monthLabel, reason: `上月工時 ${hours} 小時（≥40）→ 本月免費入場` };
    if (hours >= 20) { const fee = Math.round(single / 2); return { fee, free: false, tier: 'half', role, hours, single, monthLabel, reason: `上月工時 ${hours} 小時（≥20）→ 本月半價 NT$${fee}` }; }
    return { fee: single, free: false, tier: 'normal', role, hours, single, monthLabel, reason: `上月工時 ${hours} 小時（<20）→ 一般價 NT$${single}` };
  }
  return { fee: single, free: false, tier: 'normal', role, single, monthLabel, reason: `一般價 NT$${single}` };
};

// GET /staff-entry/eligibility - 員工查自己的入館資格
router.get('/eligibility', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const elig = await computeEligibility(db, req.staff);
    res.json(elig);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /staff-entry/qr - 產生入館 QR（30 分鐘有效）
router.post('/qr', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const elig = await computeEligibility(db, req.staff);
    const token = uuidv4();
    const now = new Date();
    await db.collection('pendingStaffEntries').doc(token).set({
      token, staffId: req.staff.id, staffName: req.staff.name, staffRole: req.staff.role,
      gymId: req.body.gymId || null,
      fee: elig.fee, free: elig.free, tier: elig.tier, reason: elig.reason,
      status: 'pending',
      createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60000),
    });
    res.json({ token: `staffentry:${token}`, ...elig });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /staff-entry/scan - 站台掃碼預覽（值班/管理員）
router.post('/scan', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const token = String(req.body.token || '').replace(/^staffentry:/, '');
    const doc = await db.collection('pendingStaffEntries').doc(token).get();
    if (!doc.exists) return res.status(404).json({ code: 'NOT_FOUND', message: '找不到此員工入館碼' });
    const p = doc.data();
    if (p.status === 'used') return res.status(400).json({ code: 'ALREADY_USED', message: '此入館碼已使用' });
    if (p.expiresAt?.toDate?.() && p.expiresAt.toDate() < new Date()) return res.status(400).json({ code: 'EXPIRED', message: '此入館碼已逾時，請員工重新產生' });
    res.json({ token, staffName: p.staffName, staffRole: p.staffRole, fee: p.fee, free: p.free, tier: p.tier, reason: p.reason });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /staff-entry/confirm - 站台確認員工入館（值班/管理員）；付費部分現場收現金
router.post('/confirm', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const token = String(req.body.token || '').replace(/^staffentry:/, '');
    const gymId = req.staff?.gymId || req.body.gymId;
    const ref = db.collection('pendingStaffEntries').doc(token);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ code: 'NOT_FOUND', message: '找不到此員工入館碼' });
    const p = doc.data();
    if (p.status === 'used') return res.status(400).json({ code: 'ALREADY_USED', message: '此入館碼已使用' });
    if (p.expiresAt?.toDate?.() && p.expiresAt.toDate() < new Date()) return res.status(400).json({ code: 'EXPIRED', message: '此入館碼已逾時' });
    const now = new Date();
    const checkInId = uuidv4();
    await db.collection('checkIns').doc(checkInId).set({
      id: checkInId, memberId: null, isStaffEntry: true, staffId: p.staffId, memberName: p.staffName,
      gymId: gymId || null, entryType: 'staff_entry',
      amountPaid: p.fee || 0, paymentMethod: p.fee > 0 ? 'cash' : 'staff_free',
      entryFee: p.fee || 0, staffTier: p.tier,
      checkedInAt: now, isCancelled: false, confirmedBy: req.staff.id, createdAt: now,
    });
    if (p.fee > 0) {
      await db.collection('transactions').doc(uuidv4()).set({
        type: 'checkin', entryType: 'staff_entry', totalAmount: p.fee, amount: p.fee, entryFee: p.fee,
        paymentMethod: 'cash', gymId: gymId || null, relatedId: checkInId,
        memberName: p.staffName, notes: '員工入館', status: 'completed',
        createdAt: now, recognitionDate: taiwanToday(),
      });
    }
    await ref.update({ status: 'used', usedAt: now, checkInId, confirmedBy: req.staff.id });
    res.json({ success: true, checkInId, fee: p.fee, free: p.free, staffName: p.staffName, message: p.free ? `${p.staffName} 免費入館` : `${p.staffName} 入館，收現金 NT$${p.fee}` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
