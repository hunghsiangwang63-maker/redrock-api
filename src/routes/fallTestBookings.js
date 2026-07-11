/**
 * 墜落測驗排測（fallTestBookings）
 *
 * 會員 email 認證 → 簽 waiver + 墜測同意書後，自助「安排墜落測驗」並選場館，
 * 進入該館站台電腦待辦名單；站台員工現場測驗後於待辦按「通過/未通過」。
 *
 * POST   /fall-test-bookings          會員/家長排測（本人或子女，選場館）
 * GET    /fall-test-bookings/my       會員查自己+子女的待測預約
 * DELETE /fall-test-bookings/:id      會員取消自己/子女的待測（換館用）
 * POST   /fall-test-bookings/:id/complete  站台/員工登記測驗結果（passed/failed）
 */
const express = require('express');
const router = express.Router();
const { getDb, COLLECTIONS } = require('../config/firebase');
const { authenticate, authenticateMember, authenticateAny } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { recordFallTestResult } = require('../services/fallTestService');
const { v4: uuidv4 } = require('uuid');

const COL = COLLECTIONS.FALL_TEST_BOOKINGS;

const chunk10 = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
};

// 排測前置：該會員須已完成 waiver + 已簽墜測同意書
async function checkPrereq(db, memberId) {
  const waiver = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (!waiver.exists || !waiver.data().isComplete) {
    return { ok: false, code: 'WAIVER_INCOMPLETE', message: '請先完成風險安全聲明書簽署' };
  }
  const sig = await db.collection('fallTestSignatures')
    .where('memberId', '==', memberId).limit(1).get();
  if (sig.empty) {
    return { ok: false, code: 'CONSENT_REQUIRED', message: '請先簽署墜落測驗同意書' };
  }
  return { ok: true };
}

// ── POST /fall-test-bookings ─────────────────────────────────────
router.post('/', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, targetMemberId } = req.body;
    if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請選擇場館' });

    // 受測者：會員端本人或子女；員工端須指定 targetMemberId
    const memberId = req.member ? (targetMemberId || req.member.id) : targetMemberId;
    if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER', message: '缺少受測會員' });

    // 擁有權（會員端；員工端放行）
    const own = await checkMemberOwnership(req.member, memberId, {
      message: '只能為自己或子女安排墜落測驗',
    });
    if (own) return res.status(own.status).json(own.body);

    const memDoc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
    if (!memDoc.exists) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    const member = memDoc.data();

    const gymDoc = await db.collection(COLLECTIONS.GYMS).doc(gymId).get();
    if (!gymDoc.exists) return res.status(404).json({ error: 'GYM_NOT_FOUND', message: '場館不存在' });

    if (member.fallTestPassed) {
      return res.status(400).json({ error: 'ALREADY_PASSED', message: '已通過墜落測驗，無需安排' });
    }

    const pre = await checkPrereq(db, memberId);
    if (!pre.ok) return res.status(400).json({ error: pre.code, message: pre.message });

    // 擋重複 pending（單一 equality 查詢後記憶體過濾，避索引）
    const existing = await db.collection(COL).where('memberId', '==', memberId).get();
    const pend = existing.docs.find((d) => d.data().status === 'pending');
    if (pend) {
      return res.status(200).json({
        booking: { id: pend.id, ...pend.data() }, already: true, message: '已有待測預約',
      });
    }

    const id = uuidv4();
    const booking = {
      id,
      memberId,
      memberName: member.name || '',
      bookedByMemberId: req.member ? req.member.id : null,
      bookedByStaffId: req.staff ? req.staff.id : null,
      gymId,
      status: 'pending', // pending | passed | failed | cancelled
      createdAt: new Date(),
      completedBy: null,
      completedByName: null,
      completedAt: null,
      fallTestId: null,
    };
    await db.collection(COL).doc(id).set(booking);
    res.status(201).json({ booking, message: '已安排墜落測驗，請至現場由工作人員進行測驗' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /fall-test-bookings/my ───────────────────────────────────
router.get('/my', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const ids = [req.member.id];
    const kids = await db.collection(COLLECTIONS.MEMBERS)
      .where('parentMemberId', '==', req.member.id).get();
    kids.forEach((d) => ids.push(d.id));

    const bookings = [];
    for (const group of chunk10(ids)) {
      const snap = await db.collection(COL).where('memberId', 'in', group).get();
      snap.forEach((d) => {
        const b = d.data();
        if (b.status === 'pending') bookings.push({ id: d.id, ...b });
      });
    }
    res.json({ bookings });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── DELETE /fall-test-bookings/:id ───────────────────────────────
router.delete('/:id', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const b = doc.data();
    if (b.status !== 'pending') {
      return res.status(400).json({ error: 'NOT_PENDING', message: '僅能取消待測預約' });
    }
    const own = await checkMemberOwnership(req.member, b.memberId, {
      message: '只能取消自己或子女的排測',
    });
    if (own) return res.status(own.status).json(own.body);
    await ref.update({ status: 'cancelled', cancelledAt: new Date() });
    res.json({ message: '已取消排測' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /fall-test-bookings/:id/return ──────────────────────────
// 站台/員工「退回申請」：把單子退回會員（不登記測驗結果），會員需重新申請。
router.post('/:id/return', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { reason } = req.body;
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const b = doc.data();
    if (b.status !== 'pending') {
      return res.status(400).json({ error: 'NOT_PENDING', message: '此排測已處理' });
    }
    await ref.update({
      status: 'returned',
      returnedBy: req.staff.id,
      returnedByName: req.staff.name,
      returnedAt: new Date(),
      returnReason: reason || '',
    });
    res.json({ message: '已退回申請，會員需重新安排墜落測驗' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /fall-test-bookings/:id/complete ────────────────────────
// 站台/員工登記測驗結果。站台值班(operator) token 含 staffId，可通過 authenticate。
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { result, notes } = req.body; // 'passed' | 'failed'
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const b = doc.data();
    if (b.status !== 'pending') {
      return res.status(400).json({ error: 'NOT_PENDING', message: '此排測已處理' });
    }

    // 登記結果（passed 需已簽同意書；passed 會更新效期並重算封鎖狀態）
    const test = await recordFallTestResult({
      memberId: b.memberId, result, notes,
      staffId: req.staff.id, staffName: req.staff.name,
    });

    const status = result === 'passed' ? 'passed' : 'failed';
    await ref.update({
      status,
      completedBy: req.staff.id,
      completedByName: req.staff.name,
      completedAt: new Date(),
      fallTestId: test.id,
    });
    res.json({
      booking: { id: b.id, ...b, status },
      test,
      message: result === 'passed' ? '測驗通過！' : '測驗未通過',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
