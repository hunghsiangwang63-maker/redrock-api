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

const FALL_TEST_VALID_YEARS = 1;                 // 初次效期（與登記時 settings.validYears 預設一致）
// 自動延長規則（2026-07-24 更正）：僅在「到期前 N 個月 ~ 到期前一天」窗口內入場時判斷；
// 回看過去 1 年若有 ≥2 次（非取消）入場 → 延長 1 年（每個到期週期至多一次，延長後窗口外移天然只延一次）。
const FALL_TEST_EXTENSION_WINDOW_MONTHS = 2;     // 到期前幾個月起進入判斷窗口
const FALL_TEST_EXTENSION_LOOKBACK_YEARS = 1;    // 回看年數
const FALL_TEST_EXTENSION_MIN_VISITS = 2;        // 回看窗口內所需入場次數
const FALL_TEST_EXTENSION_YEARS = 1;             // 每次延長年數

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

// ── 墜落測驗自動延長（2026-07-24 更正）──────────────────────────────
// 規則：僅在「到期前 FALL_TEST_EXTENSION_WINDOW_MONTHS 個月 ~ 到期前一天」窗口內入場時判斷；
//       回看過去 FALL_TEST_EXTENSION_LOOKBACK_YEARS 年若有 ≥ FALL_TEST_EXTENSION_MIN_VISITS 次
//       （非取消）入場（含本次）→ 到期日 +FALL_TEST_EXTENSION_YEARS 年。
//       延長後到期日往後推一年、窗口隨之外移 → 天然每個到期週期至多延一次（無需額外去重）。
//       非窗口內、已過期、或回看不足 → 不延長（不活躍者放其自然到期、需重測）。
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

  // 目前有效期（含先前延長）與判斷窗口
  const expiry = resolveFallTestExpiry(data);
  const today = dayjs(taiwanToday()); // 台灣今日（date-level，避免時分秒邊界）
  const windowStart = expiry.subtract(FALL_TEST_EXTENSION_WINDOW_MONTHS, 'month');

  // 僅在「到期前兩個月 ~ 到期前一天」窗口內、且尚未到期時判斷
  if (today.isBefore(windowStart)) return; // 尚未進入判斷窗口
  if (!today.isBefore(expiry)) return;     // 已到期日/過期 → 不自動延長（過期不入場亦到不了此處）

  // 回看過去一年（非取消）入場次數（含本次剛寫入的）
  const lookbackStart = today.subtract(FALL_TEST_EXTENSION_LOOKBACK_YEARS, 'year').toDate();
  const visitsSnap = await db.collection(COLLECTIONS.CHECK_INS)
    .where('memberId', '==', memberId)
    .where('isCancelled', '==', false)
    .where('checkedInAt', '>=', lookbackStart)
    .get();
  if (visitsSnap.size < FALL_TEST_EXTENSION_MIN_VISITS) return; // 回看不足 → 不延長

  const previousExpiry = expiry.format('YYYY-MM-DD');
  const newExpiry = expiry.add(FALL_TEST_EXTENSION_YEARS, 'year').format('YYYY-MM-DD');
  const extensionLog = data.extensionLog || [];
  extensionLog.push({
    extendedAt: new Date(),
    checkInId,
    previousExpiresAt: previousExpiry,
    newExpiresAt: newExpiry,
    lookbackVisits: visitsSnap.size,
    reason: `到期前窗口內、過去一年入場 ${visitsSnap.size} 次`,
  });
  await docRef.update({
    extensionCount: (data.extensionCount || 0) + 1,
    currentExpiresAt: newExpiry,
    extensionLog,
    updatedAt: new Date(),
  });
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
      message: isPendingParent ? '已完成簽署，等待法定代理人完成簽署' : 'Waiver 尚未完成，請先完成簽署',
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
module.exports = { FALL_TEST_VALID_YEARS, FALL_TEST_EXTENSION_WINDOW_MONTHS, FALL_TEST_EXTENSION_LOOKBACK_YEARS, FALL_TEST_EXTENSION_MIN_VISITS, FALL_TEST_EXTENSION_YEARS, resolveFallTestExpiry, checkFallTest, hasFallTestSignature, tryExtendFallTest, checkWaiver, runEntryGates };
