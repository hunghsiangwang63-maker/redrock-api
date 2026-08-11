// E2E：工作坊保證金（收款確認記帳、退還/沒收獨立動作、提前取消分級退還、名單顯示、欄位持久化）
// throwaway，測後刪除
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('/Users/wanghongxiang/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json')) });
const db = admin.firestore();
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const BASE = 'https://api.redrocktaiwan.com';

async function main() {
  const results = [];
  const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? '✅' : '❌'), name, extra !== undefined ? JSON.stringify(extra) : ''); };
  const cleanup = { courses: [], sessions: [], members: [] };

  const gymId = 'gym-e2e-test';
  const today = dayjs();
  const now = new Date();

  const login = await fetch(`${BASE}/auth/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@redrock.app', password: 'redrock123' }),
  }).then(r => r.json());
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

  const memberId = 'e2e-deposit-member-' + Date.now();
  await db.collection('members').doc(memberId).set({ id: memberId, name: '【E2E】保證金測試會員', phone: '0900000088', birthday: '1990-01-01', createdAt: now });
  cleanup.members.push(memberId);

  async function makeWorkshop({ price, depositAmount, daysFromToday = 10 }) {
    const courseId = 'e2e-dep-' + uuidv4();
    const sessDate = today.add(daysFromToday, 'day').format('YYYY-MM-DD');
    await db.collection('courses').doc(courseId).set({
      id: courseId, name: '【E2E】保證金測試工作坊', type: 'workshop', gymId, status: 'active',
      price, depositAmount, midpointSurcharge: 1.05,
      startDate: sessDate, endDate: sessDate, maxStudents: 10, createdAt: now, updatedAt: now,
    });
    cleanup.courses.push(courseId);
    const sid = uuidv4();
    await db.collection('courseSessions').doc(sid).set({
      id: sid, courseId, gymId, date: sessDate, startTime: '10:00', endTime: '12:00',
      status: 'scheduled', enrolledCount: 0, waitlistCount: 0, maxStudents: 10, createdAt: now, updatedAt: now,
    });
    cleanup.sessions.push(sid);
    return { courseId, sid };
  }

  async function enrollAndBuildTransfer(courseId, sid, amount) {
    const enrollRes = await fetch(`${BASE}/courses/sessions/${sid}/enroll`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ memberId, paymentMethod: 'cash' }),
    }).then(r => r.json());
    const enrollmentId = enrollRes.enrollment?.id;
    // 建 transferRecords（模擬待收款單）供確認收款流程
    const trId = uuidv4();
    await db.collection('transferRecords').doc(trId).set({
      id: trId, orderType: 'course', refId: enrollmentId, memberId, memberName: '【E2E】保證金測試會員',
      gymId, courseId, amount, paymentMethod: 'cash', status: 'pending', submittedAt: now, createdAt: now, updatedAt: now,
    });
    return { enrollmentId, trId };
  }

  async function getSettlementDeductions() {
    const dateStr = today.format('YYYY-MM-DD');
    const snap = await db.collection('dailySettlements').where('gymId', '==', gymId).where('date', '==', dateStr).limit(1).get();
    if (snap.empty) return [];
    return snap.docs[0].data().deductions || [];
  }

  // ── ① 建立→收款確認→應記「+保證金收取」，enrollment 標 depositCollectedAdjDone ──
  const A = await makeWorkshop({ price: 1000, depositAmount: 500 });
  const enrA = await enrollAndBuildTransfer(A.courseId, A.sid, 1500);
  {
    const doc0 = await db.collection('courseEnrollments').doc(enrA.enrollmentId).get();
    check('①enroll 快照 depositAmount=500', doc0.data().depositAmount === 500, doc0.data().depositAmount);
    check('①enroll depositCollectedAdjDone 初始為 false', doc0.data().depositCollectedAdjDone === false);

    await fetch(`${BASE}/transfers/${enrA.trId}/confirm`, { method: 'PUT', headers: hdr, body: JSON.stringify({}) }).then(r => r.json());
    const doc1 = await db.collection('courseEnrollments').doc(enrA.enrollmentId).get();
    check('①收款確認後 depositCollectedAdjDone=true', doc1.data().depositCollectedAdjDone === true);
    const ded1 = await getSettlementDeductions();
    const found1 = ded1.find(d => d.type === '保證金收取' && d.amount === 500 && d.sign === '+');
    check('①settlement 正確記「+保證金收取 500」', !!found1, found1);
  }

  // ── ② 退還保證金（獨立動作）→ 記「-保證金退還」，冪等擋二次操作 ──
  {
    const res1 = await fetch(`${BASE}/courses/enrollments/${enrA.enrollmentId}/refund-deposit`, { method: 'POST', headers: hdr }).then(r => r.json());
    check('②退還成功', res1.success === true, res1);
    const doc = await db.collection('courseEnrollments').doc(enrA.enrollmentId).get();
    check('②depositResolved=true, resolution=refunded', doc.data().depositResolved === true && doc.data().depositResolution === 'refunded');
    const ded2 = await getSettlementDeductions();
    const found2 = ded2.find(d => d.type === '保證金退還' && d.amount === 500 && d.sign === '-');
    check('②settlement 正確記「-保證金退還 500」', !!found2, found2);

    const res2 = await fetch(`${BASE}/courses/enrollments/${enrA.enrollmentId}/refund-deposit`, { method: 'POST', headers: hdr }).then(r => r.json());
    check('②二次退還被冪等擋下(ALREADY_RESOLVED)', res2.error === 'ALREADY_RESOLVED', res2);
  }

  // ── ③ 免費工作坊+保證金：fee=0，仍可收保證金並走同一套收款確認流程 ──
  const B = await makeWorkshop({ price: 0, depositAmount: 300 });
  const enrB = await enrollAndBuildTransfer(B.courseId, B.sid, 300);
  {
    const enrollDoc = await db.collection('courseEnrollments').doc(enrB.enrollmentId).get();
    check('③免費工作坊 enrollmentFee=0', enrollDoc.data().enrollmentFee === 0, enrollDoc.data().enrollmentFee);
    check('③免費工作坊 depositAmount=300', enrollDoc.data().depositAmount === 300);
    await fetch(`${BASE}/transfers/${enrB.trId}/confirm`, { method: 'PUT', headers: hdr, body: JSON.stringify({}) }).then(r => r.json());
    const doc = await db.collection('courseEnrollments').doc(enrB.enrollmentId).get();
    check('③收款確認後 depositCollectedAdjDone=true', doc.data().depositCollectedAdjDone === true);
  }

  // ── ④ 沒收保證金（未出席）→ 不另記帳，僅標記狀態 ──
  const C = await makeWorkshop({ price: 1000, depositAmount: 400 });
  const enrC = await enrollAndBuildTransfer(C.courseId, C.sid, 1400);
  {
    await fetch(`${BASE}/transfers/${enrC.trId}/confirm`, { method: 'PUT', headers: hdr, body: JSON.stringify({}) }).then(r => r.json());
    const dedBefore = (await getSettlementDeductions()).length;
    const res = await fetch(`${BASE}/courses/enrollments/${enrC.enrollmentId}/forfeit-deposit`, { method: 'POST', headers: hdr, body: JSON.stringify({ reason: '未出席' }) }).then(r => r.json());
    check('④沒收成功', res.success === true, res);
    const doc = await db.collection('courseEnrollments').doc(enrC.enrollmentId).get();
    check('④depositResolved=true, resolution=forfeited, refundedAmount=0', doc.data().depositResolved === true && doc.data().depositResolution === 'forfeited' && doc.data().depositRefundedAmount === 0);
    const dedAfter = (await getSettlementDeductions()).length;
    check('④沒收不新增任何 settlement 加減項（錢已在收款確認記過）', dedAfter === dedBefore, { dedBefore, dedAfter });
  }

  // ── ⑤ 提前取消：距開課10天(100%級距)，保證金同比例部分退還 ──
  const D = await makeWorkshop({ price: 1000, depositAmount: 600, daysFromToday: 10 });
  const enrD = await enrollAndBuildTransfer(D.courseId, D.sid, 1600);
  {
    await fetch(`${BASE}/transfers/${enrD.trId}/confirm`, { method: 'PUT', headers: hdr, body: JSON.stringify({}) }).then(r => r.json());
    const refundRes = await fetch(`${BASE}/course-adjustments/enrollments/${enrD.enrollmentId}/refund-request`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ memberId, reason: 'E2E 提前取消保證金測試' }),
    }).then(r => r.json());
    check('⑤退費申請成功', !refundRes.error, refundRes.error);
    const reqDoc = await db.collection('courseAdjustmentRequests').doc(refundRes.requestId).get();
    check('⑤申請文件 depositAmount=600, suggestedDepositRefund=600(100%級距)', reqDoc.data().depositAmount === 600 && reqDoc.data().suggestedDepositRefund === 600, reqDoc.data());

    const dedBefore = await getSettlementDeductions();
    const approveRes = await fetch(`${BASE}/course-adjustments/requests/${refundRes.requestId}/approve`, { method: 'POST', headers: hdr, body: JSON.stringify({}) }).then(r => r.json());
    check('⑤核准成功', approveRes.success === true, approveRes);
    const dedAfter = await getSettlementDeductions();
    const newDeposit = dedAfter.slice(dedBefore.length).find(d => d.type === '保證金退還' && d.amount === 600 && d.sign === '-');
    check('⑤核准後新增「-保證金退還 600」', !!newDeposit, newDeposit);
    const enrollDoc = await db.collection('courseEnrollments').doc(enrD.enrollmentId).get();
    check('⑤enrollment depositResolved=true, resolution=refunded, refundedAmount=600', enrollDoc.data().depositResolved === true && enrollDoc.data().depositResolution === 'refunded' && enrollDoc.data().depositRefundedAmount === 600);
  }

  // ── ⑥ 邊界：保證金尚未收款確認就想退還/沒收 → 擋 DEPOSIT_NOT_COLLECTED ──
  const E = await makeWorkshop({ price: 1000, depositAmount: 200 });
  {
    const enrollRes = await fetch(`${BASE}/courses/sessions/${E.sid}/enroll`, { method: 'POST', headers: hdr, body: JSON.stringify({ memberId, paymentMethod: 'cash' }) }).then(r => r.json());
    const eid = enrollRes.enrollment?.id;
    const res = await fetch(`${BASE}/courses/enrollments/${eid}/refund-deposit`, { method: 'POST', headers: hdr }).then(r => r.json());
    check('⑥未收款前退還被擋(DEPOSIT_NOT_COLLECTED)', res.error === 'DEPOSIT_NOT_COLLECTED', res);
  }

  // ── ⑦ 邊界：無保證金的課程 → NO_DEPOSIT ──
  const F = await makeWorkshop({ price: 1000, depositAmount: 0 });
  {
    const enrollRes = await fetch(`${BASE}/courses/sessions/${F.sid}/enroll`, { method: 'POST', headers: hdr, body: JSON.stringify({ memberId, paymentMethod: 'cash' }) }).then(r => r.json());
    const eid = enrollRes.enrollment?.id;
    const res = await fetch(`${BASE}/courses/enrollments/${eid}/refund-deposit`, { method: 'POST', headers: hdr }).then(r => r.json());
    check('⑦無保證金課程退還被擋(NO_DEPOSIT)', res.error === 'NO_DEPOSIT', res);
  }

  // ── ⑧ 報名名單端點正確回傳保證金欄位 ──
  {
    const rosterRes = await fetch(`${BASE}/courses/${A.courseId}/enrollments`, { headers: hdr }).then(r => r.json());
    const row = (rosterRes.enrollments || []).find(r => r.memberId === memberId);
    check('⑧名單端點回傳 enrollmentId 正確', row?.enrollmentId === enrA.enrollmentId, row?.enrollmentId);
    check('⑧名單端點回傳 depositAmount=500', row?.depositAmount === 500, row?.depositAmount);
    check('⑧名單端點回傳 depositResolved=true(已退還)', row?.depositResolved === true && row?.depositResolution === 'refunded');
  }

  // ── ⑨ course.depositAmount 建立/更新持久化 ──
  {
    const createRes = await fetch(`${BASE}/courses`, {
      method: 'POST', headers: hdr, body: JSON.stringify({
        name: '【E2E】保證金欄位持久化測試', type: 'workshop', gymId, price: 800, maxStudents: 5, depositAmount: 250,
        startDate: today.add(20, 'day').format('YYYY-MM-DD'), endDate: today.add(20, 'day').format('YYYY-MM-DD'),
      }),
    }).then(r => r.json());
    const id = createRes.course?.id;
    if (id) cleanup.courses.push(id);
    check('⑨建立時 depositAmount 正確存入', createRes.course?.depositAmount === 250, createRes.course?.depositAmount);
    if (id) {
      await fetch(`${BASE}/courses/${id}`, { method: 'PUT', headers: hdr, body: JSON.stringify({ depositAmount: 0 }) }).then(r => r.json());
      const doc = await db.collection('courses').doc(id).get();
      check('⑨更新為 0 正確覆蓋（清空保證金）', doc.data().depositAmount === 0, doc.data().depositAmount);
    }
  }

  console.log('\n=== 結果彙總 ===');
  const pass = results.filter(r => r.ok).length;
  console.log(`${pass}/${results.length} 通過`);
  if (pass !== results.length) console.log('失敗項目：', JSON.stringify(results.filter(r => !r.ok), null, 2));

  // ── 清理 ──
  console.log('\n清理測試資料...');
  for (const cid of cleanup.courses) {
    const es = await db.collection('courseEnrollments').where('courseId', '==', cid).get();
    for (const d of es.docs) await d.ref.delete();
    const hs = await db.collection('courseRegistrations').where('courseId', '==', cid).get();
    for (const d of hs.docs) await d.ref.delete();
    const ars = await db.collection('courseAdjustmentRequests').where('courseId', '==', cid).get();
    for (const d of ars.docs) await d.ref.delete();
    const ss = await db.collection('courseSessions').where('courseId', '==', cid).get();
    for (const d of ss.docs) await d.ref.delete();
    const trs = await db.collection('transferRecords').where('courseId', '==', cid).get();
    for (const d of trs.docs) await d.ref.delete();
    const txs = await db.collection('transactions').where('relatedId', '==', cid).get();
    for (const d of txs.docs) await d.ref.delete();
    await db.collection('courses').doc(cid).delete();
  }
  // 清今日結帳暫存檔裡這次測試新增的加減項（保留其他既有加減項，只濾掉本次 note 含測試會員名的項目）
  const dateStr = today.format('YYYY-MM-DD');
  const stSnap = await db.collection('dailySettlements').where('gymId', '==', gymId).where('date', '==', dateStr).limit(1).get();
  if (!stSnap.empty) {
    const doc = stSnap.docs[0];
    const ded = doc.data().deductions || [];
    const filtered = ded.filter(d => !(d.note || '').includes('【E2E】保證金測試會員'));
    await doc.ref.update({ deductions: filtered, updatedAt: new Date() });
  }
  for (const mid of cleanup.members) await db.collection('members').doc(mid).delete();
  console.log('清理完成');

  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
