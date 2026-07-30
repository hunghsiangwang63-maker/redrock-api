import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA, 'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM = 'gym-hsinchu';
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`  ${c ? '✅' : '❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@redrock.app', password: 'redrock123' }) })).json()).token;
const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` });
const fmtDate = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const now = new Date();
const cleanup = { members: [], courses: [], categories: [], enrollments: [] };

const setupMember = async (id, name, phone, extra = {}) => {
  await db.collection('members').doc(id).set({ id, name, phone, birthday: '1990-01-01', gymId: GYM, status: 'active', registeredBy: 'staff', emailVerified: true, isBlocked: false, createdAt: now, updatedAt: now, ...extra });
  await db.collection('waivers').doc(id).set({ memberId: id, isComplete: true, signedAt: now });
  await db.collection('fallTests').doc(`ft-${id}`).set({ memberId: id, result: 'passed', testedAt: now, gymId: GYM });
  cleanup.members.push(id);
};

(async () => {
  const tok = await login();

  // ── 班別 ──
  const catId = 'e2e-wp-cat';
  await db.collection('courseCategories').doc(catId).set({ id: catId, name: '【練習】週課計費測試班', group: 'special', isActive: true, createdAt: now, updatedAt: now });
  cleanup.categories.push(catId);

  // ── 會員 ──
  await setupMember('e2e-wp-m1', '【練習】M1全期', '0900920001');
  await setupMember('e2e-wp-m2a', '【練習】M2插班上半', '0900920002');
  await setupMember('e2e-wp-m2b', '【練習】M2插班下半', '0900920003');
  await setupMember('e2e-wp-m3', '【練習】M3續報', '0900920004');
  await setupMember('e2e-wp-m4', '【練習】M4舊生', '0900920005');
  await setupMember('e2e-wp-m5', '【練習】M5隊員續報', '0900920006', { isTeamMember: true, teamMemberSince: '2026-01-01', teamMemberUntil: '2026-12-31' });
  await setupMember('e2e-wp-m6', '【練習】M6工作坊', '0900920007');

  console.log('\n─── 建立「前一期」課程＋歷史報名（供續報/舊生判定，直接寫入非走 API）───');
  const prevId = 'e2e-wp-prev';
  await db.collection('courses').doc(prevId).set({
    id: prevId, gymId: GYM, name: '【練習】週課計費測試班 前一期', type: 'weekly', categoryId: catId,
    startDate: fmtDate(daysFromNow(-70)), endDate: fmtDate(daysFromNow(-40)),
    pricePerSession: 100, price: 800, totalSessions: 8, status: 'active', createdAt: now, updatedAt: now,
  });
  cleanup.courses.push(prevId);
  // M3：8/8 confirmed（整期→續報資格）；M4：僅 3/8 confirmed（插班→僅舊生資格，非續報）
  for (let i = 0; i < 8; i++) {
    const eid3 = `e2e-wp-prev-m3-${i}`, eid4 = `e2e-wp-prev-m4-${i}`;
    await db.collection('courseEnrollments').doc(eid3).set({ id: eid3, memberId: 'e2e-wp-m3', courseId: prevId, sessionId: `s${i}`, status: 'confirmed', date: fmtDate(daysFromNow(-70 + i * 4)), createdAt: now, updatedAt: now });
    cleanup.enrollments.push(eid3);
    if (i < 3) {
      await db.collection('courseEnrollments').doc(eid4).set({ id: eid4, memberId: 'e2e-wp-m4', courseId: prevId, sessionId: `t${i}`, status: 'confirmed', date: fmtDate(daysFromNow(-70 + i * 4)), createdAt: now, updatedAt: now });
      cleanup.enrollments.push(eid4);
    }
  }
  ok(true, '前一期課程＋M3(8/8整期)/M4(3/8插班)歷史報名寫入完成');

  console.log('\n─── 課程 A：全新梯次（全部場次在未來），單堂價100、續報9折/舊生95折皆開啟、試上費用公式預設 ───');
  const createRes = await fetch(`${API}/courses`, {
    method: 'POST', headers: H(tok), body: JSON.stringify({
      name: '課程A', cohortName: 'A', type: 'weekly', categoryId: catId, gymId: GYM,
      startDate: fmtDate(daysFromNow(1)), endDate: fmtDate(daysFromNow(60)),
      weekdays: [new Date(daysFromNow(1)).getDay()], // 每週同一天，約8週產生8堂（起訖60天涵蓋）
      startTime: '19:00', endTime: '20:30', maxStudents: 20, pricePerSession: 100,
      fullTermRenewalDiscountEnabled: true, fullTermRenewalDiscountRate: 0.9,
      alumniDiscountEnabled: true, alumniDiscountRate: 0.95,
      allowTrial: true, // trialPrice 不帶 → 公式預設
    }),
  });
  const courseA = (await createRes.json()).course;
  ok(!!courseA?.id, `課程A建立成功（id=${courseA?.id}）`);
  cleanup.courses.push(courseA.id);
  const genA = await (await fetch(`${API}/courses/${courseA.id}/generate-sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ confirm: true }) })).json();
  ok(genA.count > 0, `課程A產生場次：${genA.count} 堂（${genA.message}）`);

  console.log('\n─── M1：全期報名（無插班/無折扣資格）───');
  const enrM1 = await (await fetch(`${API}/courses/${courseA.id}/enroll-all`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m1', paymentMethod: 'cash' }) })).json();
  const expectTotal = genA.count;
  ok(enrM1.fee === 100 * expectTotal, `M1 全期費用 ${enrM1.fee} == 單堂100×${expectTotal}堂 = ${100 * expectTotal}`);
  ok(enrM1.originalFee === 100 * expectTotal, `M1 originalFee(baseFee) 一致 ${enrM1.originalFee}`);

  console.log('\n─── M3：續報資格（前一期整期）→ 9折 ───');
  const enrM3 = await (await fetch(`${API}/courses/${courseA.id}/enroll-all`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m3', paymentMethod: 'cash' }) })).json();
  const expectM3 = Math.round(100 * expectTotal * 0.9);
  ok(enrM3.fee === expectM3, `M3 續報9折費用 ${enrM3.fee} == ${expectM3}`);

  console.log('\n─── M4：舊生資格（插班未達整期）→ 95折 ───');
  const enrM4 = await (await fetch(`${API}/courses/${courseA.id}/enroll-all`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m4', paymentMethod: 'cash' }) })).json();
  const expectM4 = Math.round(100 * expectTotal * 0.95);
  ok(enrM4.fee === expectM4, `M4 舊生95折費用 ${enrM4.fee} == ${expectM4}`);

  console.log('\n─── M5：隊員＋續報疊加 ───');
  // M5 補歷史紀錄（整期，續報資格），與 M3 同構
  for (let i = 0; i < 8; i++) {
    const eid5 = `e2e-wp-prev-m5-${i}`;
    await db.collection('courseEnrollments').doc(eid5).set({ id: eid5, memberId: 'e2e-wp-m5', courseId: prevId, sessionId: `u${i}`, status: 'confirmed', date: fmtDate(daysFromNow(-70 + i * 4)), createdAt: now, updatedAt: now });
    cleanup.enrollments.push(eid5);
  }
  const enrM5 = await (await fetch(`${API}/courses/${courseA.id}/enroll-all`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m5', paymentMethod: 'cash' }) })).json();
  ok(enrM5.teamDiscountApplied === true, `M5 隊員折扣已套用（teamDiscountApplied=${enrM5.teamDiscountApplied}）`);
  ok(enrM5.fee < expectM3, `M5 (續報+隊員) 費用 ${enrM5.fee} < 純續報 M3 費用 ${expectM3}（隊員疊加後更低）`);

  console.log('\n─── quote 端點與實收一致性（M1/M3）───');
  // 補一位「跟 M1 一樣沒有任何歷史紀錄」的新會員來測 quote（M1 已報名過、quote 會因課程已滿名額/報名邏輯不同，另建新會員測 quote-only）
  await setupMember('e2e-wp-mq', '【練習】MQ報價測試', '0900920008');
  const q1 = await (await fetch(`${API}/courses/${courseA.id}/quote?memberId=e2e-wp-mq`, { headers: H(tok) })).json();
  ok(q1.fee === 100 * expectTotal, `新會員 quote.fee ${q1.fee} == 全期 ${100 * expectTotal}（與 M1 實收公式一致）`);
  const q3 = await (await fetch(`${API}/courses/${courseA.id}/quote?memberId=e2e-wp-m3`, { headers: H(tok) })).json();
  ok(q3.fee === expectM3, `M3 quote.fee ${q3.fee} == 實收 ${expectM3}（quote 與 enroll-all 完全一致，無漂移）`);
  ok(q3.renewalDiscountType === 'full_term_renewal', `M3 quote.renewalDiscountType = ${q3.renewalDiscountType}`);

  console.log('\n─── 試上費（公式預設 = 單堂價×1.1）───');
  const trialSessions = await (await fetch(`${API}/courses/trial-sessions?gymId=${GYM}`, { headers: H(tok) })).json().catch(() => null);
  // 若無此端點沿用既有 getTrialSessions 路徑，改用直接查 courseService 邏輯：抓場次後打 public session 端點驗證 trialPrice
  const sessA = await (await fetch(`${API}/courses/sessions?gymId=${GYM}&from=${fmtDate(daysFromNow(0))}&to=${fmtDate(daysFromNow(70))}&courseId=${courseA.id}`, { headers: H(tok) })).json();
  const oneSessionId = sessA.sessions?.[0]?.id;
  if (oneSessionId) {
    const pub = await (await fetch(`${API}/courses/public/session/${oneSessionId}`)).json();
    ok(pub.trialPrice === Math.round(100 * 1.1), `公開試上頁 trialPrice ${pub.trialPrice} == 公式 round(100×1.1)=${Math.round(100 * 1.1)}`);
  } else {
    ok(false, '找不到課程A場次以驗證試上費（sessions 查詢為空）');
  }

  console.log('\n─── 課程A：手動「新增場次」單堂加開 → 總堂數/整期總價應同步連動 ───');
  const beforeAdd = (await db.collection('courses').doc(courseA.id).get()).data();
  const addSessRes = await (await fetch(`${API}/courses/${courseA.id}/sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ date: fmtDate(daysFromNow(65)), startTime: '19:00', endTime: '20:30' }) })).json();
  ok(!!addSessRes.session?.id, `課程A手動加開一堂成功`);
  const afterAdd = (await db.collection('courses').doc(courseA.id).get()).data();
  ok(afterAdd.totalSessions === beforeAdd.totalSessions + 1, `課程A totalSessions ${beforeAdd.totalSessions}→${afterAdd.totalSessions}（+1）`);
  ok(afterAdd.price === Math.round((afterAdd.pricePerSession || 0) * afterAdd.totalSessions), `課程A price 同步重算為 ${afterAdd.price} == 單堂${afterAdd.pricePerSession}×${afterAdd.totalSessions}堂`);

  console.log('\n─── 課程 B：試上費明確覆寫 250（不應套公式）───');
  const createResB = await fetch(`${API}/courses`, {
    method: 'POST', headers: H(tok), body: JSON.stringify({
      name: '課程B', cohortName: 'B', type: 'weekly', categoryId: catId, gymId: GYM,
      startDate: fmtDate(daysFromNow(1)), endDate: fmtDate(daysFromNow(20)),
      weekdays: [new Date(daysFromNow(1)).getDay()],
      startTime: '19:00', endTime: '20:30', maxStudents: 20, pricePerSession: 100,
      allowTrial: true, trialPrice: 250,
    }),
  });
  const courseB = (await createResB.json()).course;
  cleanup.courses.push(courseB.id);
  await fetch(`${API}/courses/${courseB.id}/generate-sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ confirm: true }) });
  const sessB = await (await fetch(`${API}/courses/sessions?gymId=${GYM}&from=${fmtDate(daysFromNow(0))}&to=${fmtDate(daysFromNow(30))}&courseId=${courseB.id}`, { headers: H(tok) })).json();
  const oneSessionIdB = sessB.sessions?.[0]?.id;
  if (oneSessionIdB) {
    const pubB = await (await fetch(`${API}/courses/public/session/${oneSessionIdB}`)).json();
    ok(pubB.trialPrice === 250, `課程B明確覆寫 trialPrice ${pubB.trialPrice} == 250（不受公式影響）`);
  } else { ok(false, '找不到課程B場次以驗證試上費覆寫'); }

  console.log('\n─── 課程 C：插班（半數已過）── 驗證無加成，直接按剩餘堂數計 ───');
  // startDate 在過去、endDate 在未來，讓「今天」落在課程中段：8 堂中約 4 過 4 未過
  const createResC = await fetch(`${API}/courses`, {
    method: 'POST', headers: H(tok), body: JSON.stringify({
      name: '課程C', cohortName: 'C', type: 'weekly', categoryId: catId, gymId: GYM,
      startDate: fmtDate(daysFromNow(-21)), endDate: fmtDate(daysFromNow(28)),
      weekdays: [0, 1, 2, 3, 4, 5, 6], // 每天，startDate~endDate共49天 → 約49堂；用於精算過去/未來比例
      startTime: '19:00', endTime: '20:30', maxStudents: 50, pricePerSession: 100,
    }),
  });
  const courseC = (await createResC.json()).course;
  cleanup.courses.push(courseC.id);
  const genC = await (await fetch(`${API}/courses/${courseC.id}/generate-sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ confirm: true }) })).json();
  const enrM2a = await (await fetch(`${API}/courses/${courseC.id}/enroll-all`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m2a', paymentMethod: 'cash' }) })).json();
  // 剩餘堂數 = endDate - today + 1（每天一堂）；驗證 fee = 100 × remainingCount 精確（無 1.05 加成）
  const remainingC = enrM2a.count; // enroll-all 只建立「未來」場次的報名，count=未來場次數=剩餘堂數
  ok(enrM2a.fee === 100 * remainingC, `插班費用 ${enrM2a.fee} == 單堂100×剩餘${remainingC}堂 = ${100 * remainingC}（精確、無加成，即使剩餘比例<50%）`);
  ok(enrM2a.fee !== Math.round(100 * remainingC * 1.05), `插班費用不等於「舊加成公式」${Math.round(100 * remainingC * 1.05)}（確認加成已移除）`);

  console.log('\n─── 課程 D：起始日星期不在上課星期內 → unlimitedPracticeStart 應為第一堂真實日期 ───');
  const startD = daysFromNow(10);
  const startWd = startD.getDay();
  const otherWd = (startWd + 2) % 7; // 保證與 startDate 當天星期不同
  const createResD = await fetch(`${API}/courses`, {
    method: 'POST', headers: H(tok), body: JSON.stringify({
      name: '課程D', cohortName: 'D', type: 'weekly', categoryId: catId, gymId: GYM,
      startDate: fmtDate(startD), endDate: fmtDate(daysFromNow(40)),
      weekdays: [otherWd], startTime: '19:00', endTime: '20:30', maxStudents: 10, pricePerSession: 100,
    }),
  });
  const courseD = (await createResD.json()).course;
  cleanup.courses.push(courseD.id);
  await fetch(`${API}/courses/${courseD.id}/generate-sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ confirm: true }) });
  const freshD = (await db.collection('courses').doc(courseD.id).get()).data();
  ok(freshD.unlimitedPracticeStart !== fmtDate(startD), `課程D unlimitedPracticeStart(${freshD.unlimitedPracticeStart}) != startDate(${fmtDate(startD)})（確認未用 startDate 本身）`);
  ok(freshD.unlimitedPracticeStart > fmtDate(startD), `課程D unlimitedPracticeStart(${freshD.unlimitedPracticeStart}) 為 startDate 之後的第一堂真實日期`);

  console.log('\n─── 工作坊：midpointSurcharge / calcEnrollmentFee 完全不受影響 ───');
  const createResW = await fetch(`${API}/courses`, {
    method: 'POST', headers: H(tok), body: JSON.stringify({
      name: '工作坊E2E', type: 'workshop', categoryId: catId, gymId: GYM,
      price: 500, midpointSurcharge: 1.1, maxStudents: 10,
    }),
  });
  const courseW = (await createResW.json()).course;
  ok(!!courseW?.id, `工作坊建立成功（price=500 直接保留，未受週課欄位影響）`);
  cleanup.courses.push(courseW.id);
  // 建 3 場次：2 過去 + 1 未來
  const wSessIds = [];
  for (const offset of [-10, -5, 3]) {
    const r = await fetch(`${API}/courses/${courseW.id}/sessions`, { method: 'POST', headers: H(tok), body: JSON.stringify({ date: fmtDate(daysFromNow(offset)), startTime: '19:00', endTime: '21:00' }) });
    const j = await r.json();
    wSessIds.push(j.session?.id);
  }
  const futureWSess = wSessIds[2];
  const enrW = await (await fetch(`${API}/courses/sessions/${futureWSess}/enroll`, { method: 'POST', headers: H(tok), body: JSON.stringify({ memberId: 'e2e-wp-m6', paymentMethod: 'cash' }) })).json();
  const expectW = Math.round(500 * (1 / 3) * 1.1);
  ok(enrW.feeInfo?.fee === expectW, `工作坊插班費用 ${enrW.feeInfo?.fee} == round(500×1/3×1.1)=${expectW}（仍套用 midpointSurcharge，未受週課改動影響）`);

  console.log(`\n═══ 合計：${pass} 通過 / ${fail} 失敗 ═══`);

  console.log('\n─── 清理 ───');
  for (const id of cleanup.enrollments) await db.collection('courseEnrollments').doc(id).delete().catch(() => {});
  // 清掉本次 API 建立的報名（enroll-all/enroll 產生的，非上面手動寫入的歷史紀錄）
  const realEnrSnap = await db.collection('courseEnrollments').where('courseId', 'in', cleanup.courses.filter((_, i) => i < 10)).get().catch(() => null);
  if (realEnrSnap) for (const d of realEnrSnap.docs) await d.ref.delete().catch(() => {});
  for (const id of wSessIds) if (id) await db.collection('courseSessions').doc(id).delete().catch(() => {});
  const allSessSnaps = await Promise.all(cleanup.courses.map(cid => db.collection('courseSessions').where('courseId', '==', cid).get().catch(() => null)));
  for (const snap of allSessSnaps) if (snap) for (const d of snap.docs) await d.ref.delete().catch(() => {});
  for (const id of cleanup.courses) await db.collection('courses').doc(id).delete().catch(() => {});
  for (const id of cleanup.categories) await db.collection('courseCategories').doc(id).delete().catch(() => {});
  for (const id of cleanup.members) {
    await db.collection('members').doc(id).delete().catch(() => {});
    await db.collection('waivers').doc(id).delete().catch(() => {});
    await db.collection('fallTests').doc(`ft-${id}`).delete().catch(() => {});
  }
  console.log('清理完成');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
