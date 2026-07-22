const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const dayjs = require('dayjs');
const { ageOf, isUnder5 } = require('../utils/age');

// ── QR Code 產生 ──────────────────────────────────────────────────
const generateQRCode = async (memberId, memberPhone) => {
  const qrCodeId = `RR-${memberId.slice(0, 8).toUpperCase()}`;
  const qrData = JSON.stringify({ type: 'member', id: memberId, qrCodeId });

  // 產生 base64 QR Code 圖片，直接內嵌回傳（不再上傳 Firebase Storage）：
  //  - 入場實際走動態 qrToken（會員 App 前端即時繪製），此靜態圖僅作身分 QR。
  //  - 無人以路徑/簽名 URL 讀取此圖；直接存 base64 data URI，與 seed 舊會員一致，
  //    並移除 Storage 依賴（避免 Storage 異常時卡死建立會員）。
  const qrBase64 = await QRCode.toDataURL(qrData, {
    width: 300,
    margin: 2,
    color: { dark: '#8B1A1A', light: '#FFFFFF' },
  });

  return { qrCodeId, qrCodeUrl: qrBase64 }; // qrCodeUrl 現為 base64 data URI（欄位名沿用）
};

// ── 判斷封鎖原因 ──────────────────────────────────────────────────
const getBlockReasons = async (memberId, memberData) => {
  const db = getDb();
  const reasons = [];

  // 1. Email 未驗證（自助註冊）
  if (memberData.registeredBy === 'self' && !memberData.emailVerified) {
    reasons.push('email_unverified');
  }

  // 2/3 waiver 與墜測查詢並行（原本序列兩次 round-trip）
  const [waiverDoc, fallTests] = await Promise.all([
    db.collection(COLLECTIONS.WAIVERS).doc(memberId).get(),
    db.collection(COLLECTIONS.FALL_TESTS).where('memberId', '==', memberId).where('result', '==', 'passed').get(),
  ]);

  // 2. Waiver 未簽
  if (!waiverDoc.exists || !waiverDoc.data().isComplete) {
    if (!waiverDoc.exists) {
      reasons.push('waiver_unsigned');
    } else if (waiverDoc.data().parentRequired && !waiverDoc.data().parentSignedAt) {
      reasons.push('parent_waiver_pending');
    } else {
      reasons.push('waiver_unsigned');
    }
  }

  // 3. 墜落測驗：從未通過 → fall_test_required；曾通過但所有 passed 紀錄皆已過期 → fall_test_expired
  if (fallTests.empty) {
    reasons.push('fall_test_required');
  } else {
    // 是否至少一筆 passed 尚未過期（無到期日＝永久有效）；效期欄位比照 calcFallTestStatus
    const now = Date.now();
    let hasValid = false;
    fallTests.docs.forEach(d => {
      const t = d.data();
      const raw = t.currentExpiresAt || t.expiresAt;
      if (!raw) { hasValid = true; return; }
      const sec = raw?.seconds ?? raw?._seconds;
      const ms = sec != null ? sec * 1000 : new Date(raw).getTime();
      if (!isNaN(ms) && ms >= now) hasValid = true;
    });
    if (!hasValid) reasons.push('fall_test_expired');
  }

  return reasons;
};

// ── 建立新會員 ────────────────────────────────────────────────────
// 舊系統墜測效期遷移：(重新)註冊時以「電話+姓名」比對 legacyFallTests，
// 命中且效期未過、未被認領 → 在新帳號補建 passed 墜測（免重測），並標記已認領（一次性，防冒用/重複）。
// 其餘舊資料一律不匯入，會員仍須重簽 Waiver、重填資料、重簽墜測同意書。
// Climbio 姓名清理：去除所有括號註記（暱稱/攀岩隊標記），供比對。例
// "Allen林祺堂(新竹攀岩隊-2026/12/31)" → "Allen林祺堂"；"歐武龍(Uno)" → "歐武龍"
const cleanLegacyName = (n) => String(n || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[()（）]/g, '').replace(/\s/g, '').trim();
// 比對規則：清理後互相包含（≥2字）——Climbio 名常帶英文暱稱前後綴（Allen林祺堂/郭芳妤Kate），
// 會員註冊用中文本名，完全相等會漏配；包含式仍防共用電話冒領（姓名無關者不會互含）。
const legacyNameMatch = (legacyName, registeredName) => {
  const a = cleanLegacyName(legacyName), b = cleanLegacyName(registeredName);
  if (a.length < 2 || b.length < 2) return false;
  return a === b || a.includes(b) || b.includes(a);
};

const claimLegacyFallTest = async (db, memberId, member) => {
  try {
    if (member.isChildAccount) return null;            // 子帳號共用電話，不自動認領（避免認錯人）
    const phone = (member.phone || '').trim();
    const name = (member.name || '').replace(/\s/g, '');
    if (!phone || !name) return null;
    const snap = await db.collection('legacyFallTests').where('phone', '==', phone).get();
    if (snap.empty) return null;
    const today = taiwanToday();
    const hit = snap.docs.find(d => {
      const x = d.data();
      if (x.claimed === true) return false;
      if (!legacyNameMatch(x.name, name)) return false;  // 姓名相符（去括號+包含式；防共用電話冒領）
      const exp = String(x.fallTestExpiresAt || '').slice(0, 10);
      return exp && exp >= today;                                     // 仍在效期內
    });
    if (!hit) return null;
    const exp = String(hit.data().fallTestExpiresAt).slice(0, 10);
    const now = new Date();
    const ftId = uuidv4();
    await db.collection('fallTests').doc(ftId).set({
      id: ftId, memberId, result: 'passed',
      testedBy: 'migration', testedByName: '舊系統轉移',
      testedAt: now,
      expiresAt: new Date(exp + 'T00:00:00+08:00'),
      source: 'climbio-migrated', migratedFrom: hit.id,
      notes: '舊系統墜測效期轉移（免重測）',
      createdAt: now, updatedAt: now,
    });
    await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
      fallTestPassed: true, fallTestExpiresAt: new Date(exp + 'T00:00:00+08:00'), updatedAt: now,
    });
    await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now });
    console.log(`[墜測遷移] ${name}/${phone} 認領舊效期至 ${exp}`);
    return { fallTestId: ftId, expiresAt: exp };
  } catch (e) { console.error('claimLegacyFallTest 失敗', e.message); return null; }
};

// ── 舊系統攀岩隊員自動認領（Climbio 名單，隊籍至 2026-12-31）────────────
// 建立會員時電話+姓名比對 legacyTeamMembers → 標記隊員（isTeamMember/since/until），
// 並確保墜測有效（隊員墜測效期與隊籍同步至 until；若 claimLegacyFallTest 已先認領則不重複建）。
// ── 舊系統 90 日票自動認領（BeClass 名單 legacyPasses）────────────
// 電話+姓名比對命中且【票尚在效期內】→ 依名單「原起訖日」發放 90 日定期票（全館通用）
// 到會員定期票列表（memberPasses），並站內通知管理員（同館 gym_manager + super_admin）。
const claimLegacyPass = async (db, memberId, member) => {
  try {
    if (member.isChildAccount) return null;
    const phone = (member.phone || '').trim();
    if (!phone || !member.name) return null;
    const snap = await db.collection('legacyPasses').where('phone', '==', phone).get();
    if (snap.empty) return null;
    const today = taiwanToday();
    const hit = snap.docs.find(d => {
      const x = d.data();
      return x.claimed !== true && legacyNameMatch(x.name, member.name)
        && String(x.endDate || '') >= today;   // 注意有效期限：已過期不發
    });
    if (!hit) return null;
    const legacy = hit.data();
    const now = new Date();
    // 票種：90日定期票（全館 shared）；找不到票種仍發放（欄位快照為主）
    let passTypeId = null, passTypeName = '90日定期票';
    const ptSnap = await db.collection('passTypes').where('name', '==', '90日定期票').limit(1).get();
    if (!ptSnap.empty) { passTypeId = ptSnap.docs[0].id; passTypeName = ptSnap.docs[0].data().name; }
    const passId = uuidv4();
    await db.collection('memberPasses').doc(passId).set({
      id: passId, memberId, memberName: member.name || '',
      gymId: legacy.gymId || 'gym-hsinchu',           // 售出館（付款館別）
      passTypeId, passTypeName,
      scope: 'shared', targetGymId: null,             // 全館通用
      startDate: legacy.startDate, endDate: legacy.endDate,   // 沿用名單原效期、不重算
      credits: null, originalCredits: null,
      status: 'active', paymentStatus: 'confirmed', paymentId: null,
      soldByStaffId: 'legacy-90day-migration',
      source: 'legacy-90day',
      notes: `舊系統 90 日票移轉（BeClass #${legacy.seq || ''}，發票 ${legacy.invoice || '—'}）`,
      createdAt: now, updatedAt: now,
    });
    await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now });
    // 通知管理員（同館 gym_manager + super_admin）
    try {
      const { notifyRoleInGym } = require('./notificationService');
      const payload = {
        gymId: legacy.gymId || 'gym-hsinchu',
        type: 'legacy_pass_claimed',
        title: '舊系統 90 日票已認領',
        body: `${member.name}（${phone}）註冊會員，已自動發放 90 日定期票（${legacy.startDate} ~ ${legacy.endDate}，全館通用）。`,
        referenceId: passId, referenceType: 'memberPass',
      };
      await notifyRoleInGym({ ...payload, role: 'gym_manager' });
      await notifyRoleInGym({ ...payload, role: 'super_admin' });
    } catch (e) { console.error('90日票認領通知失敗（票已發放）:', e.message); }
    console.log(`✅ 舊系統90日票認領: ${member.name} ${phone} → ${legacy.startDate}~${legacy.endDate}`);
    return passId;
  } catch (e) {
    console.error('claimLegacyPass 失敗（不阻斷建立會員）:', e.message);
    return null;
  }
};

// 課程名單預留自動認領：店員先把人加進課程名單但當時查無會員，存 pendingCourseClaims；
// 該人日後註冊時以「姓名」比對（未對到者只有姓名、無電話）自動加入該課程全部場次。
// ⚠ name-only 比對有同名碰撞風險（低風險名單場景可接受；認領後通知管理員可人工核對）。
const claimPendingCourseEnrollment = async (db, memberId, member) => {
  try {
    // 子帳號「不跳過」：兒童課程（小蜘蛛人等）的學員本來就是子會員，名單認領以「上課者姓名」比對
    // （墜測/隊員/90日票認領才因共用電話跳過子帳號；課程認領為 name-only、無此顧慮）
    if (!member.name) return null;
    const snap = await db.collection('pendingCourseClaims').where('claimed', '==', false).get();
    if (snap.empty) return null;
    const hits = snap.docs.filter(d => legacyNameMatch(d.data().name, member.name));
    if (!hits.length) return null;
    const now = new Date();
    const claimed = [];
    for (const hit of hits) {
      const claim = hit.data();
      const cdoc = await db.collection('courses').doc(claim.courseId).get();
      if (!cdoc.exists) { await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now, note: '課程已不存在' }); continue; }
      const c = cdoc.data();
      const ssnap = await db.collection('courseSessions').where('courseId', '==', claim.courseId).get();
      const allSessions = ssnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const sessions = allSessions.filter(s => s.status !== 'cancelled').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      // 休館停課場次：認領者一併補發「停課補課券」（exempt、不佔配額）——與已在名單學員待遇一致。
      // 認領前已請假的日期（leaveDates）落在停課日 → 課沒上成、不發（比照既有學員請假者不補）。
      const closureSessions = allSessions.filter(s => s.status === 'cancelled' && /休館|closure/.test(String(s.cancelReason || '')));
      // 去重：已在名單則只標記已認領、不重複建
      const ex = await db.collection('courseEnrollments').where('courseId', '==', claim.courseId).where('memberId', '==', memberId).get();
      const already = ex.docs.some(d => ['confirmed', 'leave', 'waitlist'].includes(d.data().status));
      if (!already && sessions.length) {
        const gymId = c.gymId || claim.gymId || null;
        const gymAccessStart = c.unlimitedPracticeStart || c.startDate || sessions[0].date;
        const gymAccessEnd = c.unlimitedPracticeEnd || (c.endDate ? dayjs(c.endDate).add(c.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : sessions[sessions.length - 1].date);
        // 認領時自動登錄請假（claim.leaveDates：認領前已請過假的日期）→ 該堂標 leave、不佔名額；
        // 認領後跑補課額度重算（min(cap, 有效請假數)）自動給補課券
        const leaveDates = Array.isArray(claim.leaveDates) ? claim.leaveDates : [];
        const batch = db.batch(); const cnt = {};
        for (const s of sessions) {
          const eid = uuidv4();
          const isLeave = leaveDates.includes(s.date);
          batch.set(db.collection('courseEnrollments').doc(eid), {
            id: eid, memberId, memberName: member.name, sessionId: s.id, courseId: claim.courseId, courseName: c.name, gymId,
            date: s.date, startTime: s.startTime, endTime: s.endTime,
            status: isLeave ? 'leave' : 'confirmed', waitlistPosition: null, paymentId: null, paymentMethod: 'roster-claim',
            ...(isLeave ? { leaveReason: '補登記（認領時自動登錄請假）', leaveAt: now } : {}),
            originalPrice: c.price || 0, enrollmentFee: 0, installment: false, firstPayment: 0, secondPayment: 0,
            paymentStatus: 'confirmed', paymentConfirmed: true, paymentDeadline: null,
            gymAccessStart, gymAccessEnd, enrolledBy: 'roster-claim', enrolledAt: now,
            paymentDate: null, bankLastFive: claim.bankLastFive || null, healthNote: claim.healthNote || null, referralSource: null,
            confirmedLeavePolicy: false, confirmedRefundPolicy: false, portraitSignature: null, guardianSignature: null,
            memberPaidAmount: claim.paidAmount ?? null,   // BeClass 等外部名單帶入的實際匯款金額（名單顯示用）
            notes: claim.paymentNote ? `名單預留自動認領；${claim.paymentNote}` : '名單預留自動認領（註冊時姓名比對加入）', createdAt: now, updatedAt: now,
          });
          if (!isLeave) cnt[s.id] = (cnt[s.id] || 0) + 1;   // 請假堂不佔名額
        }
        for (const s of sessions) if (cnt[s.id]) batch.update(db.collection('courseSessions').doc(s.id), { enrolledCount: (s.enrolledCount || 0) + cnt[s.id], updatedAt: now });
        await batch.commit();
        // 停課補課券（豁免配額；效期＝課程結束+補課天數；leaveDates 停課日不發）
        try {
          if (closureSessions.length) {
            const rulesC = require('./courseService').resolveRules(c, await require('./courseService').getCategoryOf(db, c.categoryId));
            const expC = dayjs(c.endDate || new Date()).add(rulesC.makeupDeadlineDays ?? 60, 'day').toDate();
            for (const cs of closureSessions) {
              if (leaveDates.includes(cs.date)) continue;
              const rid = uuidv4();
              await db.collection('courseMakeupRights').doc(rid).set({
                id: rid, memberId, originalEnrollmentId: null,
                courseId: claim.courseId, courseName: c.name || '', categoryId: c.categoryId || null,
                gymId: c.gymId || null, tags: c.tags || [],
                status: 'available', expiresAt: expC, usedSessionId: null, usedAt: null,
                source: 'closure', exempt: true, closureDate: cs.date || null,
                notes: '認領時補發（該堂於認領前已休館停課）', createdAt: now, updatedAt: now,
              });
            }
            console.log(`[課程認領] ${member.name} 補發停課券 ${closureSessions.filter(x=>!leaveDates.includes(x.date)).length} 張`);
          }
        } catch (e) { console.error('[課程認領] 停課券補發失敗', e.message); }
        // 有登錄請假 → 重算補課額度（自動給補課券；lazy require 避免循環依賴）
        if (leaveDates.length) {
          try { await require('./courseService').reconcileMakeupEntitlement(db, memberId, claim.courseId); }
          catch (e) { console.error('認領請假補課額度重算失敗（報名已建立）:', e.message); }
        }
      }
      await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now });
      claimed.push(c.name);
      // 定期票 × 課程免費期間重疊補償（政策 2026-07-17；冪等、不阻斷）
      try { await require('./passOverlapService').applyCourseOverlapPassExtension({ memberId, courseId: claim.courseId }); }
      catch (e) { console.error('課程重疊補償失敗（認領已完成）:', e.message); }
      try {
        const { notifyRoleInGym } = require('./notificationService');
        const payload = {
          gymId: c.gymId || claim.gymId || 'gym-hsinchu', type: 'course_roster_claimed',
          title: '課程名單自動認領', body: `${member.name} 註冊會員，已自動加入課程名單：${c.name}${already ? '（原已在名單）' : ''}。請核對是否為同一人。`,
          referenceId: claim.courseId, referenceType: 'course',
        };
        await notifyRoleInGym({ ...payload, role: 'gym_manager' });
        await notifyRoleInGym({ ...payload, role: 'super_admin' });
      } catch (e) { console.error('課程名單認領通知失敗（已認領）:', e.message); }
      console.log(`✅ 課程名單認領: ${member.name} → ${c.name}`);
    }
    // 政策：認領課程學員一律預設「墜測通過」（免重測；移轉式、不需同意書，比照 claimLegacyFallTest）。
    // 僅在有認領到課程且該會員尚無 passed 墜測時建立；waiver 仍須另行簽署（不豁免）。
    if (claimed.length) {
      const passedSnap = await db.collection('fallTests').where('memberId', '==', memberId).where('result', '==', 'passed').get();
      if (passedSnap.empty) {
        const ftId = uuidv4();
        const exp = dayjs().add(1, 'year').toDate();
        await db.collection('fallTests').doc(ftId).set({
          id: ftId, memberId, result: 'passed',
          testedBy: 'course-claim', testedByName: '課程學員認領預設',
          testedAt: now, expiresAt: exp, source: 'course-roster-claim',
          notes: '課程學員認領預設通過墜測（免重測）', createdAt: now, updatedAt: now,
        });
        await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({ fallTestPassed: true, fallTestExpiresAt: exp, updatedAt: now });
        console.log(`[課程認領] ${member.name} 預設墜測通過（至 ${dayjs(exp).format('YYYY-MM-DD')}）`);
      }
    }
    return claimed;
  } catch (e) {
    console.error('claimPendingCourseEnrollment 失敗（不阻斷建立會員）:', e.message);
    return null;
  }
};

// ── VIP 自動認領（Climbio VIP 名單，無期限）─────────────────────
// legacyVips：{ name, phone(可空), family(全家), claimed }。
// 比對：有電話→電話+姓名；無電話→姓名（legacyNameMatch，含子帳號——名單含小孩本名，
// 認領即通知管理員核對）。命中→ vipMembers + memberType:'vip'（無期限）；
// family:true → 會員標 vipFamily，名下既有子帳號一併 VIP、之後新建子帳號也自動 VIP。
const applyVipToMember = async (db, memberId, memberName, note) => {
  const dup = await db.collection('vipMembers').where('memberId', '==', memberId).limit(1).get();
  if (dup.empty) {
    const vid = uuidv4();
    await db.collection('vipMembers').doc(vid).set({
      id: vid, memberId, memberName: memberName || '',
      note: note || 'climbio-migration', createdBy: 'system-claim',
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({ memberType: 'vip', updatedAt: new Date() });
};
const claimLegacyVip = async (db, memberId, member) => {
  try {
    // 子帳號：先看家長是否「全家 VIP」→ 直接繼承；再走名單姓名比對（名單含小孩本名）
    if (member.isChildAccount && member.parentMemberId) {
      const pDoc = await db.collection(COLLECTIONS.MEMBERS).doc(member.parentMemberId).get();
      if (pDoc.exists && pDoc.data().vipFamily === true) {
        await applyVipToMember(db, memberId, member.name, 'climbio-vip-family（家長全家 VIP）');
        console.log(`[VIP認領] 子帳號 ${member.name} 繼承家長全家 VIP`);
        return { claimed: true, viaFamily: true };
      }
    }
    const snap = await db.collection('legacyVips').get();
    const hit = snap.docs.find(d => {
      const x = d.data();
      if (x.claimed === true) return false;
      if (!legacyNameMatch(x.name, member.name)) return false;
      if (x.phone && member.phone && !member.isChildAccount) return x.phone === member.phone; // 有電話→須同號（子帳號共用家長電話、放寬）
      return true; // 無電話→姓名比對
    });
    if (!hit) return null;
    const claim = hit.data();
    await applyVipToMember(db, memberId, member.name, `climbio-vip${claim.family ? '（全家）' : ''}`);
    if (claim.family) {
      await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({ vipFamily: true, updatedAt: new Date() });
      const kids = await db.collection(COLLECTIONS.MEMBERS).where('parentMemberId', '==', memberId).get();
      for (const k of kids.docs) await applyVipToMember(db, k.id, k.data().name, 'climbio-vip-family');
    }
    await hit.ref.update({ claimed: true, claimedBy: memberId, claimedByName: member.name, claimedAt: new Date() });
    try {
      const { notifyRoleInGym } = require('./notificationService');
      for (const g of ['gym-hsinchu', 'gym-shilin']) {
        await notifyRoleInGym({ gymId: g, role: 'gym_manager', type: 'legacy_vip_claimed',
          title: 'VIP 自動認領', body: `${member.name}（${member.phone || '子帳號'}）註冊並認領 Climbio VIP「${claim.name}」${claim.family ? '（全家）' : ''}，請核對身分`,
          referenceId: memberId, referenceType: 'member' });
      }
    } catch (e) {}
    console.log(`[VIP認領] ${member.name} 認領 VIP「${claim.name}」${claim.family ? '（全家）' : ''}`);
    return { claimed: true };
  } catch (e) { console.error('claimLegacyVip 失敗（不阻斷建立會員）:', e.message); return null; }
};

// 認領公開訪客體驗預約（免登入預約時 memberId:null）：註冊會員後用電話比對綁定，之後「我的預約」看得到、可自助管理。
const claimGuestExperienceBookings = async (db, memberId, member) => {
  try {
    if (!member?.phone) return;
    const snap = await db.collection('experienceBookings')
      .where('contactPhone', '==', member.phone).get();
    const batch = db.batch();
    let n = 0;
    snap.docs.forEach(d => {
      const b = d.data();
      if (!b.memberId && b.status !== 'cancelled') {
        batch.update(d.ref, { memberId, claimedFromGuest: true, updatedAt: new Date() });
        n++;
      }
    });
    if (n) { await batch.commit(); console.log(`認領訪客體驗預約 ${n} 筆 → ${memberId}`); }
  } catch (e) { console.error('claimGuestExperienceBookings 失敗（不阻斷建立會員）:', e.message); }
};

// ── BeClass 比賽報名自動認領 ─────────────────────────────────────
// 匯入的比賽報名（memberId:null＋claimPhone/claimName）：會員註冊時電話+姓名比對命中
// → 報名掛上帳號（App 顯示我的比賽、可用報到 QR）＋通知管理員。
const claimLegacyCompetitionReg = async (db, memberId, member) => {
  try {
    if (member.isChildAccount === true && !member.parentMemberId) return null;
    const phone = (member.phone || '').trim();
    if (!phone || !member.name) return null;
    const snap = await db.collection('competitionRegistrations')
      .where('claimPhone', '==', phone).get();
    if (snap.empty) return null;
    let claimed = 0;
    for (const d of snap.docs) {
      const r = d.data();
      if (r.memberId) continue;                                   // 已認領
      if (!legacyNameMatch(r.memberName, member.name)) continue;  // 姓名相符（防共用電話冒領）
      await d.ref.update({ memberId, claimedAt: new Date(), updatedAt: new Date() });
      claimed++;
      try {
        const { notifyRoleInGym } = require('./notificationService');
        const comp = (await db.collection('competitions').doc(r.competitionId).get()).data();
        const payload = {
          gymId: comp?.gymId || 'gym-hsinchu',
          type: 'competition_reg_claimed',
          title: 'BeClass 比賽報名已認領',
          body: `${member.name}（${phone}）註冊會員，已自動掛上「${r.competitionName || ''}」報名（${r.divisionName || ''}）。`,
          referenceId: d.id, referenceType: 'competitionRegistration',
        };
        await notifyRoleInGym({ ...payload, role: 'gym_manager' });
        await notifyRoleInGym({ ...payload, role: 'super_admin' });
      } catch (e) { console.error('比賽報名認領通知失敗', e.message); }
      console.log(`✅ BeClass比賽報名認領: ${member.name} ${phone} → ${r.competitionName}`);
    }
    return claimed || null;
  } catch (e) {
    console.error('claimLegacyCompetitionReg 失敗（不阻斷建立會員）:', e.message);
    return null;
  }
};

const claimLegacyTeamMember = async (db, memberId, member) => {
  try {
    if (member.isChildAccount) return null;
    const phone = (member.phone || '').trim();
    if (!phone || !member.name) return null;
    const snap = await db.collection('legacyTeamMembers').where('phone', '==', phone).get();
    if (snap.empty) return null;
    const hit = snap.docs.find(d => {
      const x = d.data();
      return x.claimed !== true && legacyNameMatch(x.name, member.name)
        && String(x.until || '') >= taiwanToday(); // 隊籍仍有效才認領
    });
    if (!hit) return null;
    const until = String(hit.data().until || '2026-12-31').slice(0, 10);
    const now = new Date();
    await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
      isTeamMember: true,
      teamMemberSince: taiwanToday(),
      teamMemberUntil: until,
      updatedAt: now,
    });
    // 墜測與隊籍同步（若尚無有效墜測紀錄才建；Climbio 認領已建者略過）
    const ft = await db.collection('fallTests').where('memberId', '==', memberId).get();
    const hasPassed = ft.docs.some(d => d.data().result === 'passed');
    if (!hasPassed) {
      const ftId = uuidv4();
      await db.collection('fallTests').doc(ftId).set({
        id: ftId, memberId, result: 'passed',
        testedBy: 'migration', testedByName: '攀岩隊員轉移',
        testedAt: now, expiresAt: new Date(until + 'T00:00:00+08:00'),
        source: 'climbio-team', notes: `攀岩隊員（隊籍至 ${until}）墜測同步`,
        createdAt: now, updatedAt: now,
      });
      await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
        fallTestPassed: true, fallTestExpiresAt: new Date(until + 'T00:00:00+08:00'), updatedAt: now,
      });
    }
    await hit.ref.update({ claimed: true, claimedBy: memberId, claimedAt: now });
    // 一併寫入年度隊員名冊（teamApplications，員工端「攀岩隊員管理」名單資料源）
    try {
      const year = parseInt(until.slice(0, 4)) || new Date().getFullYear();
      const raw = String(hit.data().rawName || '');
      const primaryGym = /士林\/新竹|新竹\/士林/.test(raw) ? '士林/新竹'
        : /士林/.test(raw) ? '士林紅石' : '新竹紅石';
      const appId = `team_${memberId}_${year}`;
      const exist = await db.collection('teamApplications').doc(appId).get();
      if (!exist.exists) {
        await db.collection('teamApplications').doc(appId).set({
          id: appId, memberId, year,
          memberName: member.name || '', memberPhone: phone, memberEmail: member.email || '',
          memberGender: member.gender || '', memberBirthday: member.birthday || '',
          primaryGym,
          paymentAmount: 0, expectedFee: 0,
          jerseySize: '', noJersey: false,
          status: 'active', paymentStatus: 'confirmed',
          paidConfirmedBy: 'migration', paidConfirmedByName: 'Climbio 移轉',
          paidAt: now, source: 'climbio-migration',
          notes: `Climbio 移轉（隊籍至 ${until}，隊費舊系統已繳）`,
          createdAt: now, updatedAt: now,
        });
      }
    } catch (e) { console.error('隊員名冊寫入失敗（隊員標記已完成）', e.message); }
    console.log(`[隊員遷移] ${member.name}/${phone} 標記攀岩隊員至 ${until}`);
    return { until };
  } catch (e) { console.error('claimLegacyTeamMember 失敗', e.message); return null; }
};

const createMember = async (memberData, staffId, options = {}) => {
  const db = getDb();
  const memberId = uuidv4();

  // 後端權威：未滿 5 歲無法成為會員（含子會員）。birthday 選填 → 有填才判斷。
  if (isUnder5(memberData.birthday)) {
    throw { code: 'AGE_UNDER_5', message: '未滿 5 歲無法成為會員' };
  }

  // 後端權威：子會員（家庭成員）僅限未滿 18 歲（滿 18 歲應註冊正式會員）。
  // 涵蓋所有建子會員入口（會員自助 /my/children、店員 /:id/children），不單靠路由層或前端。
  if (options?.isChildAccount) {
    const a = ageOf(memberData.birthday);
    if (a !== null && a >= 18) {
      throw { code: 'AGE_RESTRICTION', message: '家庭成員僅限未滿 18 歲，滿 18 歲請註冊正式會員' };
    }
  }

  // 檢查電話是否重複（子會員共用父會員電話，跳過此檢查）
  if (!options?.isChildAccount) {
    const existing = await db.collection(COLLECTIONS.MEMBERS)
      .where('phone', '==', memberData.phone)
      .limit(1)
      .get();
    if (!existing.empty) {
      throw { code: 'PHONE_EXISTS', message: '此電話號碼已被使用' };
    }
  }

  // 計算是否未成年（<18）—— 用共用 ageOf 工具
  const _age = ageOf(memberData.birthday);
  const isMinor = _age !== null && _age < 18;

  // 產生 QR Code
  const { qrCodeId, qrCodeUrl } = await generateQRCode(memberId, memberData.phone);

  const now = new Date();
  const member = {
    id: memberId,
    name: memberData.name,
    phone: memberData.phone,
    email: memberData.email || null,
    birthday: memberData.birthday || null,
    gender: memberData.gender || null,
    emergencyContact: memberData.emergencyContact || null,
    // 未成年（<18）家長/法定代理人資料（自助註冊必填；供風險安全聲明書家長簽署流程使用）
    parentName: memberData.parentName || null,
    parentPhone: memberData.parentPhone || null,
    parentRelation: memberData.parentRelation || null,
    qrCode: qrCodeUrl,
    qrCodeId,
    isMinor,
    isChildAccount: options.isChildAccount || false,
    parentMemberId: options.parentMemberId || null,
    registeredBy: staffId ? 'staff' : 'self',
    emailVerified: staffId ? true : false, // 店員建立的預設已驗證
    emailVerifyToken: null,
    emailVerifyExpiry: null,
    isBlocked: false,
    blockReasons: [],
    notes: memberData.notes || '',
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).set(member);

  // 舊系統墜測效期自動認領（電話+姓名比對，命中即免重測）→ 在算封鎖狀態前完成，避免被誤判需墜測
  await claimLegacyFallTest(db, memberId, member);
  // 攀岩隊員自動認領（Climbio 名單；隊員墜測效期同步至隊籍到期日）
  await claimLegacyTeamMember(db, memberId, member);
  // 舊系統 90 日票自動認領（BeClass 名單；效期內才發、沿用原起訖日、通知管理員）
  await claimLegacyPass(db, memberId, member);
  // BeClass 比賽報名自動認領（memberId 空的匯入報名掛上帳號）
  await claimLegacyCompetitionReg(db, memberId, member);
  // 課程名單預留自動認領（店員先建名單但當時查無會員 → 註冊時姓名比對自動加入該課程）
  await claimPendingCourseEnrollment(db, memberId, member);
  // Climbio VIP 名單自動認領（無期限；全家 VIP 含子帳號繼承）
  await claimLegacyVip(db, memberId, member);

  await claimGuestExperienceBookings(db, memberId, member);

  // 計算並更新封鎖狀態
  const blockReasons = await getBlockReasons(memberId, member);
  if (blockReasons.length > 0) {
    await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
      isBlocked: true,
      blockReasons,
      updatedAt: new Date(),
    });
    member.isBlocked = true;
    member.blockReasons = blockReasons;
  }

  return member;
};

// 剝除敏感認證欄位，避免經 API 外洩（passwordHash / 重設・驗證 token / 登入鎖定狀態）
// getMember/searchMembers 的所有消費端都不需要這些欄位；密碼重設/登入另以 phone/token 直接查詢。
const SENSITIVE_FIELDS = ['passwordHash', 'resetPasswordToken', 'resetPasswordExpiry', 'emailVerifyToken', 'emailVerifyExpiry', 'loginFailCount', 'loginLockedUntil'];
const sanitizeMember = (m) => {
  if (!m) return m;
  const out = { ...m };
  for (const f of SENSITIVE_FIELDS) delete out[f];
  return out;
};

// 清單專用：在 sanitizeMember 基礎上再移除 qrCode（靜態 base64 QR 圖，~4.6KB/筆）。
// 全前端清單無人讀（入場走動態 qrToken）；詳情 getMember 仍保留 qrCode。
const sanitizeMemberForList = (m) => {
  const out = sanitizeMember(m);
  if (out) delete out.qrCode;
  return out;
};

// ── 搜尋會員 ─────────────────────────────────────────────────────
const searchMembers = async ({ query, gymId, role, limit = 20, cursor }) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.MEMBERS);

  // 如果是搜尋字串，先在本地過濾（Firestore 不支援全文搜尋）
  // 實際上線建議使用 Algolia 或 Typesense
  let snapshot;
  if (query) {
    // 先取最近1000筆做本地過濾
    snapshot = await ref.orderBy('createdAt', 'desc').limit(1000).get();
    const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    return all.filter(m =>
      m.name?.includes(query) ||
      m.phone?.includes(query) ||
      m.email?.includes(query)
    ).slice(0, limit).map(sanitizeMemberForList);
  }

  snapshot = await ref.orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map(d => sanitizeMemberForList({ id: d.id, ...d.data() }));
};

// ── 取得單一會員 ──────────────────────────────────────────────────
const getMember = async (memberId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
  if (!doc.exists) throw { code: 'MEMBER_NOT_FOUND', message: '找不到此會員' };
  return sanitizeMember({ id: doc.id, ...doc.data() });
};

// ── 透過 QR Code ID 取得會員 ──────────────────────────────────────
const getMemberByQRCode = async (qrCodeId) => {
  const db = getDb();
  const snapshot = await db.collection(COLLECTIONS.MEMBERS)
    .where('qrCodeId', '==', qrCodeId)
    .limit(1)
    .get();

  if (snapshot.empty) throw { code: 'MEMBER_NOT_FOUND', message: '查無此 QR Code' };
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
};

// ── 透過電話取得會員 ─────────────────────────────────────────────
const getMemberByPhone = async (phone) => {
  const db = getDb();
  let docs;
  // 支援輸入末四碼
  if (phone.length === 4) {
    const snapshot = await db.collection(COLLECTIONS.MEMBERS)
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();
    docs = snapshot.docs.filter(d => d.data().phone?.endsWith(phone));
  } else {
    const snapshot = await db.collection(COLLECTIONS.MEMBERS)
      .where('phone', '==', phone)
      .get();
    docs = snapshot.docs;
  }
  if (!docs.length) throw { code: 'MEMBER_NOT_FOUND', message: '查無此電話' };
  // 親子共用電話：子帳號繼承家長電話，一支電話可能對應多筆。
  // 優先回傳「家長帳號」（非子帳號），避免誤解析到子會員（原 limit(1) 無排序不確定）。
  const pick = docs.find(d => { const m = d.data(); return !m.isChildAccount && !m.parentMemberId; }) || docs[0];
  return { id: pick.id, ...pick.data() };
};

// ── 更新封鎖狀態 ──────────────────────────────────────────────────
const refreshBlockStatus = async (memberId) => {
  const db = getDb();
  const member = await getMember(memberId);
  const blockReasons = await getBlockReasons(memberId, member);

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
    isBlocked: blockReasons.length > 0,
    blockReasons,
    updatedAt: new Date(),
  });

  return blockReasons;
};

// ── 驗證 Email ────────────────────────────────────────────────────
const verifyEmail = async (token) => {
  const db = getDb();
  const snapshot = await db.collection(COLLECTIONS.MEMBERS)
    .where('emailVerifyToken', '==', token)
    .limit(1)
    .get();

  if (snapshot.empty) throw { code: 'INVALID_TOKEN', message: '無效的驗證連結' };

  const doc = snapshot.docs[0];
  const member = doc.data();

  // 冪等：已驗證再點（重複點擊、信箱程式預抓、多封信其一已成功）→ 直接回成功，不看效期
  if (member.emailVerified) return { memberId: doc.id, already: true };

  if (member.emailVerifyExpiry && dayjs().isAfter(dayjs(member.emailVerifyExpiry.toDate()))) {
    throw { code: 'TOKEN_EXPIRED', message: '驗證連結已過期，請重新申請' };
  }

  // token 保留（不再用完即毀）：同一連結重複點擊由上方 emailVerified 冪等處理，
  // 避免「信箱安全掃描先開連結消耗 token → 本人再點顯示無效」的誤判
  await doc.ref.update({
    emailVerified: true,
    updatedAt: new Date(),
  });

  // 重新計算封鎖狀態
  await refreshBlockStatus(doc.id);

  return { memberId: doc.id };
};

module.exports = {
  createMember,
  claimLegacyFallTest,
  searchMembers,
  getMember,
  getMemberByQRCode,
  getMemberByPhone,
  getBlockReasons,
  refreshBlockStatus,
  generateQRCode,
  verifyEmail,
};
