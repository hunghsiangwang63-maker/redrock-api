/**
 * checkin/gates.js — 入場前置關卡：墜落測驗（效期/遞延/同意書）・Waiver・runEntryGates（同日重複/分期逾期）
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 * 對外 API 仍經 services/checkinService.js 門面 re-export。
 */
const { taiwanToday } = require('../../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../../config/firebase');
const { getMember } = require('../memberService');
const dayjs = require('dayjs');
const { getMemberType } = require('./pricing');
const { getValidSingleEntryTickets } = require('./eligibility');

const FALL_TEST_VALID_YEARS = 1;       // 初次效期（與登記時 settings.validYears 預設一致）
const FALL_TEST_EXTENSION_VISITS = 2;  // 觸發遞延所需入場次數
const FALL_TEST_EXTENSION_YEARS = 1;   // 每次遞延年數

// 解析墜測有效期：優先 currentExpiresAt（含遞延），其次登記時的 expiresAt，最後回推 testedAt + 效期年數
const resolveFallTestExpiry = (test) => {
  if (test.currentExpiresAt) return dayjs(test.currentExpiresAt);
  const raw = test.expiresAt;
  const sec = raw?.seconds || raw?._seconds;
  if (sec) return dayjs(sec * 1000);
  if (raw) return dayjs(raw);
  return dayjs(test.testedAt.toDate()).add(FALL_TEST_VALID_YEARS, 'year');
};

// ── 身份別判斷 ──────────────────────────────────────────────────
// 優先序：VIP > 課程學員 > 攀岩隊員 > 兒童(未滿13) > 學生(13-22) > 一般
const checkFallTest = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'passed')
    .get();

  if (snap.empty) return { passed: false, reason: 'never_tested' };

  // 客戶端排序取最新一筆
  const tests = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const ta = a.testedAt?.seconds || 0;
    const tb = b.testedAt?.seconds || 0;
    return tb - ta;
  });
  const last = tests[0];
  const fallTestId = last.id;

  // 計算目前有效期（含所有遞延）
  const baseExpiry = resolveFallTestExpiry(last);

  const today = dayjs();
  const isExpired = today.isAfter(baseExpiry);

  if (isExpired) {
    return { passed: false, reason: 'expired', expiredAt: baseExpiry.format('YYYY-MM-DD') };
  }

  return {
    passed: true,
    fallTestId,
    expiresAt: baseExpiry.format('YYYY-MM-DD'),
    extensionCount: last.extensionCount || 0,
  };
};

// ── 是否已簽署墜落測驗同意書（與「是否通過」不同；體驗券入場僅需簽署）──
const hasFallTestSignature = async (memberId) => {
  const db = getDb();
  const snap = await db.collection('fallTestSignatures').where('memberId', '==', memberId).limit(1).get();
  return !snap.empty;
};

// ── 墜落測驗遞延：每入場2次延長1年 ──────────────────────────────
const tryExtendFallTest = async (memberId, checkInId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.FALL_TESTS)
    .where('memberId', '==', memberId)
    .where('result', '==', 'passed')
    .orderBy('testedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return;

  const docRef = snap.docs[0].ref;
  const data = snap.docs[0].data();

  // 計算目前有效期
  const currentExpiry = resolveFallTestExpiry(data);

  // 統計有效期內入場次數（含本次）
  const visitsSnap = await db.collection(COLLECTIONS.CHECK_INS)
    .where('memberId', '==', memberId)
    .where('isCancelled', '==', false)
    .where('checkedInAt', '>=', data.testedAt.toDate())
    .get();

  const visitCount = visitsSnap.size; // 包含本次剛寫入的

  // 每累積 FALL_TEST_EXTENSION_VISITS 次觸發一次遞延
  const extensionCount = data.extensionCount || 0;
  const expectedExtensions = Math.floor(visitCount / FALL_TEST_EXTENSION_VISITS);

  if (expectedExtensions > extensionCount) {
    // 補齊所有未套用的遞延（避免一次跨多門檻時只加一年、其餘永久遺失）
    const missedExtensions = expectedExtensions - extensionCount;
    const previousExpiry = currentExpiry.format('YYYY-MM-DD');
    const newExpiry = currentExpiry.add(missedExtensions * FALL_TEST_EXTENSION_YEARS, 'year').format('YYYY-MM-DD');
    const extensionLog = data.extensionLog || [];
    extensionLog.push({
      extendedAt: new Date(),
      checkInId,
      previousExpiresAt: previousExpiry,
      newExpiresAt: newExpiry,
      extensionsApplied: missedExtensions,
    });
    await docRef.update({
      extensionCount: expectedExtensions,
      currentExpiresAt: newExpiry,
      extensionLog,
      updatedAt: new Date(),
    });
  }
};

// ── waiver 檢查 ──────────────────────────────────────────────────
const checkWaiver = async (memberId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
  if (!doc.exists) return { complete: false, reason: 'not_signed' };
  const w = doc.data();
  if (!w.isComplete) return { complete: false, reason: 'incomplete' };
  return { complete: true };
};

// ── 關卡 0：前置關卡（單一權威來源）────────────────────────────────
// 依序：同日同館重複入場 → Waiver → 墜落測驗（含當日體驗券例外）→ 分期逾期。
// 供 verifyEntry / createPendingCheckIn / /checkin/phone 共用，避免三份各自實作漂移。
// 回傳：
//   通過 → { blocked:false, member, memberType, fallTest }
//   擋下 → { blocked:true, reason, status, httpStatus, code, message, extra }
//     - reason/status：verifyEntry 回傳用
//     - httpStatus：路由 res.status() 用（already_checked_in=400，其餘=403）
//     - code：createPendingCheckIn throw 用
const runEntryGates = async (memberId, gymId, { skipDuplicate = false, expTicketMode = 'owns', expTicketId = null, installmentMemberId = null } = {}) => {
  const db = getDb();
  const today = taiwanToday();

  // 0. 同日同館重複入場
  if (!skipDuplicate) {
    const todaySnap = await db.collection(COLLECTIONS.CHECK_INS)
      .where('memberId', '==', memberId)
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', new Date(today + 'T00:00:00+08:00'))
      .where('checkedInAt', '<=', new Date(today + 'T23:59:59+08:00'))
      .get();
    if (!todaySnap.empty) {
      const existing = todaySnap.docs[0].data();
      const hhmm = new Date(existing.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(11, 16);
      return {
        blocked: true, reason: 'already_checked_in', status: 'already_checked_in',
        httpStatus: 400, code: 'ALREADY_CHECKED_IN',
        message: `今日已於 ${hhmm} 完成入場，如需重新入場請先取消`,
        extra: { checkInId: todaySnap.docs[0].id, checkedInAt: existing.checkedInAt },
      };
    }
  }

  const member = await getMember(memberId);

  // 1. Waiver
  const waiver = await checkWaiver(memberId);
  if (!waiver.complete) {
    const isPendingParent = waiver.reason === 'incomplete';
    return {
      blocked: true, member,
      reason: isPendingParent ? 'parent_waiver_pending' : 'waiver_required',
      status: 'blocked', httpStatus: 403, code: 'WAIVER_REQUIRED',
      message: isPendingParent ? '已完成簽署，等待家長/監護人完成簽署' : 'Waiver 尚未完成，請先完成簽署',
    };
  }

  // 2. 墜落測驗（例外：持當日有效體驗券者未過墜測可入場，但須簽墜測同意書）
  const fallTest = await checkFallTest(memberId);
  if (!fallTest.passed) {
    // 例外判定：'using'＝此次入場正在使用體驗券（createPendingCheckIn 實際入場，較嚴謹）；
    //           'owns' ＝會員持有當日有效體驗券（verifyEntry / 電話顯示用）
    let hasExpTicket;
    if (expTicketMode === 'using') {
      hasExpTicket = false;
      if (expTicketId) {
        const td = await db.collection(COLLECTIONS.SINGLE_ENTRY_TICKETS).doc(expTicketId).get();
        hasExpTicket = td.exists && td.data().ticketType === 'experience';
      }
    } else {
      hasExpTicket = (await getValidSingleEntryTickets(memberId)).some(t => t.ticketType === 'experience');
    }
    if (hasExpTicket) {
      if (!(await hasFallTestSignature(memberId))) {
        return {
          blocked: true, member, reason: 'fall_test_consent_required', status: 'blocked',
          httpStatus: 403, code: 'FALL_TEST_CONSENT_REQUIRED',
          message: '請先簽署墜落測驗同意書（體驗課程可未通過墜測入場，但須簽署同意書）',
        };
      }
      // 有簽署 → 放行
    } else {
      const isNever = fallTest.reason === 'never_tested';
      return {
        blocked: true, member,
        reason: isNever ? 'fall_test_required' : 'fall_test_expired',
        status: 'blocked', httpStatus: 403,
        code: isNever ? 'FALL_TEST_REQUIRED' : 'FALL_TEST_EXPIRED',
        message: isNever ? '尚未通過安全墜落測驗' : `墜落測驗已於 ${fallTest.expiredAt} 到期，請重新測驗`,
        extra: { expiredAt: fallTest.expiredAt || null },
      };
    }
  }

  // 3. 分期付款逾期（子女入場可指定查家長分期：installmentMemberId）
  const { hasOverdueInstallment } = require('../installmentService');
  if (await hasOverdueInstallment(installmentMemberId || memberId)) {
    return {
      blocked: true, member, reason: 'installment_overdue', status: 'blocked',
      httpStatus: 403, code: 'INSTALLMENT_OVERDUE',
      message: '分期付款已逾期，入場資格已暫停，請至櫃檯完成繳款',
    };
  }

  return { blocked: false, member, memberType: getMemberType(member), fallTest };
};

// ── 主驗票：verifyEntry ──────────────────────────────────────────
// 用於「會員端選擇入場方式前」的資格確認
module.exports = { FALL_TEST_VALID_YEARS, FALL_TEST_EXTENSION_VISITS, FALL_TEST_EXTENSION_YEARS, resolveFallTestExpiry, checkFallTest, hasFallTestSignature, tryExtendFallTest, checkWaiver, runEntryGates };
