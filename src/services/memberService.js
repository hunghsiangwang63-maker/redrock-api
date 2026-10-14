const { taiwanToday } = require('../utils/taiwanDate');
const { getDb, COLLECTIONS, FieldPath } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { ageOf, isUnder4 } = require('../utils/age');

// ── QR Code 產生 ──────────────────────────────────────────────────
// 2026-08-31：移除靜態 base64 QR 圖片產生與儲存（member.qrCode，~4.6KB/筆）——全庫掃描
// 確認全前端（會員/員工端）與獨立端點 GET /:id/qrcode 皆無人讀取此圖（入場實際走動態
// qrToken，會員 App 前端即時繪製）；此欄位卻在會員登入、/auth/member/me、會員詳情三個
// 高頻端點被完整讀取＋回傳，純屬浪費 Firestore 讀取/傳輸費用。只保留 qrCodeId（短字串，
// getMemberByQRCode 仍依賴它反查會員），不再產生圖片本身。
const generateQRCode = async (memberId) => {
  const qrCodeId = `RR-${memberId.slice(0, 8).toUpperCase()}`;
  return { qrCodeId };
};

// ── 判斷封鎖原因 ──────────────────────────────────────────────────
// 取封鎖判斷所需的兩筆資料（Waiver 小欄位＋已通過墜測）——與會員文件互不相依，可與 getMember 同時發出
const fetchBlockInputs = (memberId) => {
  const db = getDb();
  return Promise.all([
    db.collection(COLLECTIONS.WAIVERS).where(FieldPath.documentId(), '==', memberId)
      .select('isComplete', 'parentRequired', 'parentSignedAt', 'memberSignedAt').limit(1).get(),
    db.collection(COLLECTIONS.FALL_TESTS).where('memberId', '==', memberId).where('result', '==', 'passed').get(),
  ]);
};

const getBlockReasons = async (memberId, memberData, prefetched = null) => {
  const db = getDb();
  const reasons = [];

  // 1. Email 未驗證（自助註冊；子帳號無密碼、不會被登入卡住，此檢查對其無意義，排除）
  if (memberData.registeredBy === 'self' && !memberData.emailVerified && !memberData.isChildAccount) {
    reasons.push('email_unverified');
  }

  // 2/3 waiver 與墜測查詢並行（原本序列兩次 round-trip）；waiver 只需這三個小欄位判斷封鎖狀態，
  // waivers 文件平均 ~76KB（內嵌簽名 base64 圖），此函式呼叫頻繁（會員詳情/登入等多處），加 .select()。
  // DocumentReference 沒有 .select()——改用 collection query + documentId() 過濾
  // （QuerySnapshot：.empty/.docs[0] 取代 .exists/.data()）。
  const [waiverSnap, fallTests] = prefetched || await fetchBlockInputs(memberId);
  const waiverExists = !waiverSnap.empty;
  const waiverData = waiverExists ? waiverSnap.docs[0].data() : null;

  // 2. Waiver 未簽
  if (!waiverExists || !waiverData.isComplete) {
    if (!waiverExists) {
      reasons.push('waiver_unsigned');
    } else if (waiverData.parentRequired && waiverData.memberSignedAt && !waiverData.parentSignedAt) {
      // 「等待法定代理人」須本人真的簽過（memberSignedAt）才成立——員工用 /waiver/reset 退回未成年
      // 會員重簽時只清 isComplete/signedAt，parentRequired/parentSignedAt 原樣保留，若不檢查
      // memberSignedAt 會把「本人尚未重簽」誤判成「本人已簽、等家長」死路狀態（2026-09-26 合併簽署時修正）。
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



// 前期請假補課券自動媒合（2026-10-04，宋沛德案例）：前期（舊梯次）學員欠補課、但本期沒有報名任何課，
// 註冊前沒有 memberId 可掛券。館方先在 crossCohortMakeups 建一筆待安排紀錄並帶 autoIssue
// （{courseId:掛靠用虛擬課程, expiresAt}），該人註冊時以「手機」精確比對（不比姓名，避免同名碰撞），
// 命中就依 owedDates 逐日發 prev_leave 豁免補課券（不佔請假額度），紀錄標 converted。
// 只處理有 autoIssue 的紀錄（舊的待安排紀錄不受影響）；子帳號共用家長電話一律跳過；失敗不阻斷註冊。
const claimPendingPrevLeaveRights = async (db, memberId, member) => {
  try {
    if (member.isChildAccount) return null;
    const phone = normalizePhone(member.phone);
    if (!phone) return null;
    const snap = await db.collection('crossCohortMakeups').where('status', '==', 'pending_arrange').get();
    const hits = snap.docs.filter(d => d.data().autoIssue && d.data().autoIssue.courseId && normalizePhone(d.data().phone) === phone);
    if (!hits.length) return null;
    const now = new Date();
    let issued = 0;
    for (const hit of hits) {
      const x = hit.data(); const ai = x.autoIssue;
      const cdoc = await db.collection('courses').doc(ai.courseId).get();
      if (!cdoc.exists) { console.error('[前期補課認領] 掛靠課程不存在', ai.courseId); continue; }
      const c = cdoc.data();
      const expiresAt = new Date(`${ai.expiresAt || x.deadline}T00:00:00+08:00`);
      const ids = [];
      for (const dt of (x.owedDates || [])) {
        const rid = uuidv4(); ids.push(rid);
        await db.collection('courseMakeupRights').doc(rid).set({
          id: rid, memberId, originalEnrollmentId: null,
          courseId: ai.courseId, courseName: c.name || '', categoryId: c.categoryId || null,
          gymId: c.gymId || x.gymId || null, tags: c.tags || [],
          status: 'available', expiresAt, usedSessionId: null, usedAt: null,
          source: 'prev_leave', exempt: true, prevLeaveDate: dt,
          notes: '註冊自動媒合（前期請假，依手機比對）', createdAt: now, updatedAt: now,
        });
        issued++;
      }
      await hit.ref.update({ status: 'converted', claimedBy: memberId, claimedAt: now, convertedRightIds: ids, updatedAt: now });
      try {
        const { notifyGymManagers } = require('./notificationService');
        await notifyGymManagers({
          gymId: x.gymId || c.gymId || 'gym-hsinchu', type: 'prev_leave_claimed',
          title: '前期補課券已自動發放',
          body: `${member.name}（${member.phone}）註冊會員，已依手機自動發放 ${ids.length} 張前期請假補課券（${(x.owedDates || []).join('、')}；${x.courseName || c.name}），效期至 ${dayjs(expiresAt).format('YYYY-MM-DD')}。請核對是否為同一人。`,
          referenceId: ai.courseId, referenceType: 'course', link: '/staff/courses',
        });
      } catch (e) { console.error('前期補課認領通知失敗（券已發放）:', e.message); }
      console.log(`✅ 前期補課券認領: ${member.name} ${phone} → ${ids.length} 張`);
    }
    return issued;
  } catch (e) {
    console.error('claimPendingPrevLeaveRights 失敗（不阻斷建立會員）:', e.message);
    return null;
  }
};

// ── 舊系統課程舊生名單自動認領（如 BeClass 小蜘蛛人歷史報名，用來判定「舊生報名優惠」）───
// legacyCourseAlumni：{ name(上課者/小孩姓名), phone(家長電話，已正規化為純數字), categoryId, claimed }。
// 比對：電話（正規化）+ 姓名（legacyNameMatch，去括號＋包含式；子帳號共用家長電話，name 比對上課者本人姓名）。
// 命中（可多筆，橫跨多期）→ 把 categoryId 聯集寫入 member.legacyAlumniCategoryIds，
// 供 courseService.computeAlumniStatus / courses.js enroll-all 判定「舊生(isAlumni)」——
// 僅補 isAlumni，不補續報(isFullTermRenewal)（匯入資料只證明曾報名繳費，非整期出席佐證）。
const normalizePhone = (p) => String(p || '').replace(/[^0-9]/g, '');


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
      .where('contactPhone', '==', member.phone).select('memberId', 'status').get();
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

// ── 待指派體驗單日券自動認領（姓名+生日比對）─────────────────────────
// 逐參加者發券時比對不到會員的券（pendingAssign:true、存 participantName/participantBirthday）：
// 該參加者日後自己註冊，姓名+生日命中 → 券綁到本人（免櫃檯指定發送）。
const claimPendingExperienceTickets = async (db, memberId, member) => {
  try {
    if (!member?.name || !member?.birthday) return;
    const nm = String(member.name).trim(), bd = String(member.birthday).trim();
    const snap = await db.collection('singleEntryTickets').where('pendingAssign', '==', true).get();
    const batch = db.batch(); let n = 0;
    snap.docs.forEach(d => {
      const t = d.data();
      if (t.status !== 'active' || t.ticketType !== 'experience') return;
      if (String(t.participantName || '').trim() === nm && String(t.participantBirthday || '').trim() === bd) {
        batch.update(d.ref, { memberId, memberName: member.name, originalMemberId: memberId, pendingAssign: false, claimed: true, claimedAt: new Date(), updatedAt: new Date() });
        n++;
      }
    });
    if (n) { await batch.commit(); console.log(`認領待指派體驗券 ${n} 張 → ${memberId}`); }
  } catch (e) { console.error('claimPendingExperienceTickets 失敗（不阻斷建立會員）:', e.message); }
};

// ── 公開報名（免登入）送出前：填的電話是不是已經是註冊會員？───────────────
// 背景（2026-09-08）：訪客報名原本一律建 guest_<uuid>（或 experienceBookings 的 memberId:null）佔位，
// 若填的電話其實是「已註冊會員」（忘記登入、或直接點分享連結），這筆報名會永遠是無主的「幽靈」記錄——
// 下面的 claimGuestXxx 系列只在「新會員完成註冊」那一刻觸發，對「早就註冊過」的人永遠不會補跑；之後任何
// 把這個佔位 id 當真實會員 id 查詢的地方（如櫃檯「今日課程學員」快速入場 /checkin/phone）都會出錯——
// 已實際發生多起（課程 3 起、體驗 3 起）並個別手動修正資料。故公開報名一律先查電話，命中就直接歸戶到
// 真實會員（沿用會員身分＝隊員價/黑名單擋等權威判斷皆自動生效，比維持訪客身分更正確），查無才退回訪客
// 流程（fallbackPrefix 由呼叫端決定佔位格式：課程/試上用 'guest_<uuid>' 字串、一般體驗預約用 null）。
// 比對邏輯（僅比電話）與既有 claimGuestXxx 系列一致，不額外要求姓名相符。
const resolveGuestOrMemberId = async (db, phone, fallbackPrefix = 'guest_') => {
  const trimmed = String(phone || '').trim();
  const fallback = fallbackPrefix === null ? null : `${fallbackPrefix}${uuidv4()}`;
  if (!trimmed) return { memberId: fallback, isGuestBooking: true };
  try {
    const snap = await db.collection(COLLECTIONS.MEMBERS).where('phone', '==', trimmed).limit(1).get();
    if (!snap.empty) return { memberId: snap.docs[0].id, isGuestBooking: false };
  } catch (e) { console.error('[公開報名] 電話比對既有會員失敗（改走訪客流程）:', e.message); }
  return { memberId: fallback, isGuestBooking: true };
};

// ── 認領公開訪客課程/工作坊/試上報名 ───────────────────────────────
// 免登入公開報名頁（週課整期/單堂工作坊/試上）建立時 memberId 為 guest_<uuid> 佔位字串（非 null，避免
// 與其他訪客同場次/同梯次誤判重複報名，見 courses.js handleEnrollAll / experienceBookings.js handleTrialBooking
// 的說明）、並標 isGuest:true + contactPhone。註冊會員後用電話比對綁定，之後「我的課程」看得到。
const claimGuestCourseEnrollments = async (db, memberId, member) => {
  try {
    if (!member?.phone) return;
    const snap = await db.collection('courseEnrollments').where('contactPhone', '==', member.phone).select('isGuest', 'status').get();
    const batch = db.batch(); let n = 0;
    snap.docs.forEach(d => {
      const e = d.data();
      if (e.isGuest && e.status !== 'cancelled' && e.status !== 'course_cancelled') {
        batch.update(d.ref, { memberId, claimedFromGuest: true, updatedAt: new Date() });
        n++;
      }
    });
    if (n) { await batch.commit(); console.log(`認領訪客課程/工作坊/試上報名 ${n} 筆 → ${memberId}`); }
    // 同步認領 courseRegistrations header（Phase 1 雙寫，僅供顯示查詢用；失敗不影響上面主要認領）
    try {
      const hSnap = await db.collection('courseRegistrations').where('contactPhone', '==', member.phone).select('isGuest', 'status').get();
      const hBatch = db.batch(); let hn = 0;
      hSnap.docs.forEach(d => {
        const h = d.data();
        if (h.isGuest && h.status !== 'cancelled') { hBatch.update(d.ref, { memberId, claimedFromGuest: true, updatedAt: new Date() }); hn++; }
      });
      if (hn) await hBatch.commit();
    } catch (e) { console.error('claimGuestCourseEnrollments header 認領失敗（不阻斷）:', e.message); }
  } catch (e) { console.error('claimGuestCourseEnrollments 失敗（不阻斷建立會員）:', e.message); }
};

// ── 認領公開訪客比賽報名 ──────────────────────────────────────────
// 與上方 claimGuestCourseEnrollments 同款（memberId 為 guest_<uuid>、isGuest:true）；比賽報名文件既有欄位叫
// `phone`（非 contactPhone），比對時沿用該集合原本的欄位名。與 claimLegacyCompetitionReg（BeClass 匯入舊資料、
// 用 claimPhone+模糊姓名比對）是完全不同的兩套機制，勿混淆。
const claimGuestCompetitionRegistrations = async (db, memberId, member) => {
  try {
    if (!member?.phone) return;
    const snap = await db.collection('competitionRegistrations').where('phone', '==', member.phone).select('isGuest', 'status').get();
    const batch = db.batch(); let n = 0;
    snap.docs.forEach(d => {
      const r = d.data();
      if (r.isGuest && r.status !== 'cancelled') {
        batch.update(d.ref, { memberId, claimedFromGuest: true, updatedAt: new Date() });
        n++;
      }
    });
    if (n) { await batch.commit(); console.log(`認領訪客比賽報名 ${n} 筆 → ${memberId}`); }
  } catch (e) { console.error('claimGuestCompetitionRegistrations 失敗（不阻斷建立會員）:', e.message); }
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

  // 後端權威：未滿 4 歲無法成為會員（含子會員）。birthday 選填 → 有填才判斷。
  if (isUnder4(memberData.birthday)) {
    throw { code: 'AGE_UNDER_5', message: '未滿 4 歲無法成為會員' };
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
  const { qrCodeId } = await generateQRCode(memberId);

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
    // 暱稱（選填，≤10字）——2026-09-02 新增，供路線積分排行榜、路線標記朋友(tag)等社交功能公開
    // 顯示用（不需像本名一樣遮蔽中間字）；沿用原本僅限「路線排名」的 routeNickname 欄位設計，
    // 因當時 0 位會員設定過，直接升級成一般會員資料欄位、不留舊欄位相容負擔。
    nickname: memberData.nickname ? String(memberData.nickname).trim().slice(0, 10) : null,
    notes: memberData.notes || '',
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).set(member);
  invalidateMemberSearchCache(); // 讓剛建立的會員立刻可被搜尋到（見 searchMembers 上方註解）

  // ⚠️ 2026-10-14：12 個自動認領原本逐個 await（每個至少 1 次資料庫往返，累計約 13 個先後往返；Railway 慢實例上
  // 新會員自助註冊超過客人端 10 秒逾時）。12 個函式皆自己吞錯、不會拋出；依「碰同一批資料／有先後相依」分成幾條鏈，
  // 鏈內維持原順序、各鏈同時執行，全部做完才算封鎖狀態（原本也是全部做完才算）。
  //  鏈1 墜測相關＋課程報名：舊墜測 → 攀岩隊員（同步墜測效期，依賴前者）→ 前期請假補課券 → 公開訪客課程報名
  //  鏈2 訪客比賽報名　　：claimGuestCompetitionRegistrations
  //  鏈3 VIP：claimLegacyVip（只更新會員文件的 VIP 相關欄位）
  //  鏈4 體驗　　　　　　：訪客體驗預約 → 待指派體驗單日券
  //  （2026-10-14 已移除：舊 90 日票認領〔來源 legacyPasses 23 筆已全數認領〕、BeClass 比賽報名認領〔12 筆全已綁會員〕、
  //   課程名單預留認領〔pendingCourseClaims 49 筆全已認領，且全專案已無任何程式會建立新預留〕——來源資料皆已處理完畢；
  //   以及舊生名單認領〔legacyCourseAlumni 151 筆中 116 筆已認領、剩 35 筆；使用者 2026-10-14 決定移除，這 35 位日後註冊將不再自動判定舊生報名優惠〕）
  await Promise.all([
    (async () => {
      // 舊系統墜測效期自動認領（電話+姓名比對，命中即免重測）→ 在算封鎖狀態前完成，避免被誤判需墜測
      await claimLegacyFallTest(db, memberId, member);
      // 攀岩隊員自動認領（Climbio 名單；隊員墜測效期同步至隊籍到期日）
      await claimLegacyTeamMember(db, memberId, member);
      // 前期請假補課券自動媒合（手機比對；館方先在 crossCohortMakeups 建 autoIssue 紀錄）
      await claimPendingPrevLeaveRights(db, memberId, member);
      // 公開訪客報名認領（課程整期/工作坊/試上；電話比對，見函式說明）
      await claimGuestCourseEnrollments(db, memberId, member);
    })(),
    // 公開訪客比賽報名認領（電話比對）
    claimGuestCompetitionRegistrations(db, memberId, member),
    // Climbio VIP 名單自動認領（無期限；全家 VIP 含子帳號繼承）
    claimLegacyVip(db, memberId, member),
    (async () => {
      await claimGuestExperienceBookings(db, memberId, member);
      // 待指派體驗單日券自動認領（逐參加者發券時比對不到、之後本人註冊 → 姓名+生日命中綁本人）
      await claimPendingExperienceTickets(db, memberId, member);
    })(),
  ]);

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
  delete out.qrCode; // 2026-08-31：欄位已停用（見 generateQRCode 註解），雙重防護舊資料清理過渡期
  return out;
};

// 清單專用：在 sanitizeMember 基礎上再移除 qrCode（靜態 base64 QR 圖，~4.6KB/筆）。
// 全前端清單無人讀（入場走動態 qrToken）；詳情 getMember 仍保留 qrCode。
const sanitizeMemberForList = (m) => {
  const out = sanitizeMember(m);
  if (out) delete out.qrCode;
  return out;
};

// 搜尋清單投影欄位：搜尋比對用（name/phone/email）＋ MembersPage.jsx 清單列顯示用
// （isChildAccount/memberType/waiverSigned/fallTestPassed/createdAt）。點進去看詳情走
// 另一支單筆 getMember()（不受此投影影響），故清單本身不需要 qrCode/密碼雜湊等其他欄位。
// fallTestExpiresAt：一併帶出供前端比對是否已過期（fallTestPassed 是一次性寫死旗標、
// 過期後不會被清掉，前端需自行拿 fallTestExpiresAt 跟今天比較才能正確顯示「已過期」）。
const SEARCH_LIST_FIELDS = ['name', 'phone', 'email', 'isChildAccount', 'memberType', 'waiverSigned', 'fallTestPassed', 'fallTestExpiresAt', 'createdAt', 'isTeamMember', 'teamMemberSince', 'teamMemberUntil'];

// ── 搜尋會員 ─────────────────────────────────────────────────────
// ⚠️ 2026-09-08 查 Firestore 查詢洞察資料發現：query 分支的全表掃描（見下方）單一查詢型態
// 佔全站單日 Read Ops 約 6.5%（35 次搜尋、每次讀約 1473 筆＝幾乎整個 members 集合）。搜尋詞
// 不影響「要撈哪些文件」（一律整表掃描、只有搜尋詞不同時的記憶體過濾結果不同），故用單一
// 全域快取鍵存「整份投影後的會員清單」——TTL 內不論搜什麼字，都重用同一份清單只在記憶體
// 篩選（篩選本身不耗 Firestore 讀取）。⚠️ 唯一風險：剛註冊/剛建立的會員在快取視窗內搜不到
// （像系統故障，比「資料顯示稍舊」嚴重）——createMember() 寫入會員文件後主動清快取解決；
// 其餘欄位變動（如剛簽完 waiver）在快取視窗內顯示稍舊可接受，不逐一補清快取。
// ⚠️ 2026-09-13 查詢洞察：仍是次高單一查詢型態（24 次搜尋、每次讀約 1563 筆＝37,537／天）。
// 搜尋本身對「幾分鐘內資料略舊」無感（同上，剛建立會員的唯一風險已由主動清快取解決），
// TTL 由 20 秒放寬到 90 秒；2026-09-13 使用者確認可接受、再放寬到 5 分鐘（詳情頁不受影響，
// 見上方註解——這裡最舊只影響清單頁的姓名/waiver/墜測等狀態小標籤）。
const MEMBER_SEARCH_CACHE_TTL_MS = 300000;
const _memberSearchCache = { data: null, expiresAt: 0 };
const invalidateMemberSearchCache = () => { _memberSearchCache.data = null; _memberSearchCache.expiresAt = 0; };

const searchMembers = async ({ query, gymId, role, limit = 20, cursor }) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.MEMBERS);

  // 如果是搜尋字串，先在本地過濾（Firestore 不支援全文搜尋）
  // 實際上線建議使用 Algolia 或 Typesense（會員數大到影響效能/成本時再評估）
  let snapshot;
  if (query) {
    if (_memberSearchCache.data && _memberSearchCache.expiresAt > Date.now()) {
      return _memberSearchCache.data.filter(m =>
        m.name?.includes(query) ||
        m.phone?.includes(query) ||
        m.email?.includes(query)
      ).slice(0, limit).map(sanitizeMemberForList);
    }
    // ⚠️ 原本只取「最近建立的 1000 筆」做本地過濾（省成本的權宜做法）——會員數超過 1000 後，
    // 較早建立的會員會直接被排除在候選範圍外，變成不管搜電話或姓名都完全查不到（非搜尋條件本身
    // 的問題）。2026-08-11 發現：真實案例（會員數來到 1031 筆時，一位 7/13 建立的會員突然搜不到）。
    // 目前會員規模（一千餘筆）全表掃描成本仍低，改為掃全部——之後真的成長到影響效能/成本再接
    // 專用搜尋服務，不要重新加一個「只看最近 N 筆」這種會隨規模再度默默失效的上限。
    // ⚠️ 2026-08-21 加 .select()：會員文件平均 5.3KB，其中 qrCode（靜態 base64 QR 圖，前端清單
    // 全無人讀）就佔 4.4KB（82%）；全表掃描每次搜尋原本會把這些完全用不到的 bytes 也整批讀進來，
    // 與稍早 courseEnrollments 簽名圖是同一種浪費。投影後只讀取真正會用到的 8 個欄位，讀取「筆數」
    // 不變（Firestore 讀取計費看筆數、非投影後省的欄位），但傳輸量大幅下降。
    snapshot = await ref.select(...SEARCH_LIST_FIELDS).get();
    const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    _memberSearchCache.data = all;
    _memberSearchCache.expiresAt = Date.now() + MEMBER_SEARCH_CACHE_TTL_MS;
    return all.filter(m =>
      m.name?.includes(query) ||
      m.phone?.includes(query) ||
      m.email?.includes(query)
    ).slice(0, limit).map(sanitizeMemberForList);
  }

  snapshot = await ref.orderBy('createdAt', 'desc').select(...SEARCH_LIST_FIELDS).limit(limit).get();
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
  // 會員文件與封鎖判斷用的 Waiver／墜測查詢互不相依 → 同時發出（原先 getMember 之後才查，多一個先後往返；2026-10-14）。
  // 會員不存在時 getMember 照舊拋 MEMBER_NOT_FOUND（預先發出的查詢若失敗，用空 catch 吞掉避免 unhandledRejection）。
  const inputsP = fetchBlockInputs(memberId); inputsP.catch(() => {});
  const member = await getMember(memberId);
  const blockReasons = await getBlockReasons(memberId, member, await inputsP);

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

// ── 子會員升級為正式會員（獨立電話+Email+密碼）──────────────────────
// 2026-09-02 新增：原本只有員工端 POST /members/:id/promote（authenticate+members.create）
// 能做，現在也開放家長在 App 自助辦理（POST /members/my/children/:id/promote，會員自己的
// 子會員才能操作，見 routes/members.js 呼叫端的擁有權檢查）。核心邏輯抽成單一函式共用，
// 兩條路由僅差在「呼叫前的身份/擁有權驗證」與「actor 記錄哪個欄位」。
// actor：{staffId} 或 {memberId}（自助升級時記，供稽核；未帶不記，維持既有員工路徑不變）。
const promoteChildToMember = async (childId, { phone, email, password }, actor = {}) => {
  const db = getDb();
  const childRef = db.collection(COLLECTIONS.MEMBERS).doc(childId);
  const childDoc = await childRef.get();
  if (!childDoc.exists) throw { code: 'NOT_FOUND', message: '找不到此會員' };

  const child = childDoc.data();
  if (!child.isChildAccount) throw { code: 'NOT_CHILD_ACCOUNT', message: '此會員並非子會員，無需升級' };

  // 新手機號碼不可重複（不可跟現有任何會員相同，含原本共用的家長電話）
  const phoneClash = await db.collection(COLLECTIONS.MEMBERS).where('phone', '==', phone).get();
  if (!phoneClash.empty) throw { code: 'PHONE_EXISTS', message: '此電話號碼已被其他會員使用' };

  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = require('firebase-admin');

  // 課程/票券/入場/紀錄等資料一律以 memberId 關聯（courseEnrollments、memberPasses、checkIns、
  // competitionRegistrations、discountCards、routeAscents…皆是）——升級是「原地更新同一份會員
  // 文件」、memberId（文件 id）完全不變，故所有既有資料自動、完整地跟著這個 id 走，不需任何搬移。
  //
  // 但 parentMemberId/coParentIds 若留著，會讓「已獨立」的會員仍出現在前家長的 /my/children
  // 清單、且 checkMemberOwnership 只認這兩個欄位（2026-07-10 起不再檢查 isChildAccount）→
  // 前家長仍可代操作（報名/入場/查看票券等）。故升級時必須清除，才是真正的「獨立」；
  // 用 formerParentMemberId 留一筆歷史紀錄供稽核，不具任何功能性關聯。
  // ⚠️ 修正一個既有 bug（員工端 /:id/promote 上線以來即存在，非本次新引入）：子會員建立時
  // （POST /my/children → createMember）registeredBy 一律存 'self'（createMember 對 staffId
  // 缺省的既有邏輯），登入時的 email 驗證 gate 原本靠 isChildAccount:true 豁免（子帳號本就無法
  // 獨立登入）——但升級把 isChildAccount 設成 false 後，這份豁免同時失效，若系統當下開著
  // 「Email 認證總開關」，升級後的會員會被 EMAIL_NOT_VERIFIED 卡死、完全無法登入看到任何
  // 已完整保留的課程/票券/紀錄。升級是家長已登入、經過身份驗證的主動行為，比照店員建立帳號
  // （emailVerified:true）同等信任層級直接視為已驗證，不需再走一次 Email 驗證流程。
  const updates = {
    phone, email, passwordHash,
    isChildAccount: false,
    emailVerified: true,
    parentMemberId: null,
    coParentIds: admin.firestore.FieldValue.delete(),
    formerParentMemberId: child.parentMemberId || null,
    promotedAt: new Date(),
    updatedAt: new Date(),
  };
  if (actor.staffId) updates.promotedBy = actor.staffId;
  if (actor.memberId) updates.promotedByMemberId = actor.memberId;
  await childRef.update(updates);

  return { name: child.name };
};

module.exports = {
  createMember,
  claimLegacyFallTest,
  resolveGuestOrMemberId,
  searchMembers,
  invalidateMemberSearchCache,
  getMember,
  getMemberByQRCode,
  getMemberByPhone,
  getBlockReasons,
  refreshBlockStatus,
  generateQRCode,
  verifyEmail,
  promoteChildToMember,
};
