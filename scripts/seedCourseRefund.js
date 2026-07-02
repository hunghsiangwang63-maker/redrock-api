/**
 * 員工練習用「待審核課程退費」seed
 * 建 課程 + 場次 + 報名(confirmed, 已付) + 退費申請(pending)，
 * 讓員工在待辦頁「需審核」直接點審核→核准/拒絕練習。欄位對齊後端實際建立/核准邏輯。
 *
 * 需先跑 seedTestMembers.js --commit（本腳本用測試會員「【練習】周銷售」當報名人）。
 *
 * 用法：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/seedCourseRefund.js
 *   寫入：...同上... --commit   （先清舊【練習】課程再重建，可重複執行）
 *   只清：...同上... --clean
 */
const { v4: uuidv4 } = require('uuid');
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const CLEAN_ONLY = args.includes('--clean');
const GYM = 'gym-hsinchu';
const COURSE_NAME = '【練習】初級攀岩入門班';
const dstr = (off) => new Date(Date.now() + 8 * 3600000 + off * 86400000).toISOString().slice(0, 10);

(async () => {
  const { initFirebase, getDb } = require('../src/config/firebase');
  initFirebase(); const db = getDb();

  async function clean() {
    const cs = await db.collection('courses').where('name', '==', COURSE_NAME).get();
    let n = 0;
    for (const c of cs.docs) {
      const cid = c.id;
      for (const col of ['courseSessions', 'courseEnrollments', 'courseAdjustmentRequests']) {
        const s = await db.collection(col).where('courseId', '==', cid).get();
        const b = db.batch(); s.forEach(x => b.delete(x.ref)); await b.commit();
      }
      await db.collection('courses').doc(cid).delete(); n++;
    }
    if (n) console.log(`🧹 已清除 ${n} 門【練習】課程及其場次/報名/退費申請`);
    else console.log('（無既有【練習】課程可清）');
  }

  console.log(`\n===== 待審核退費 seed ${CLEAN_ONLY ? '【只清理】' : COMMIT ? '【寫入】' : '（預覽）'} =====`);
  if (CLEAN_ONLY) { await clean(); process.exit(0); }

  // 找測試會員 周銷售
  const ms = await db.collection('members').where('name', '==', '【練習】周銷售').limit(1).get();
  if (ms.empty) { console.error('找不到測試會員「【練習】周銷售」，請先跑 seedTestMembers.js --commit'); process.exit(1); }
  const member = { id: ms.docs[0].id, ...ms.docs[0].data() };

  // 課程：開課前（startDate 未來 → 退費扣 5% 手續費）
  const courseId = uuidv4(), sessionId = uuidv4(), enrollmentId = uuidv4();
  const price = 5000, paidAmount = 5000;
  const startDate = dstr(10), endDate = dstr(70);
  const perSessionDeduction = 850, handlingFeeRate = 0.05;
  // 依後端邏輯：開課前 → refund = paid - ceil(paid*rate)
  const fee = Math.ceil(paidAmount * handlingFeeRate);
  const suggestedRefund = Math.max(0, paidAmount - fee);
  const refundNote = `開課前申請，扣除手續費 NT$${fee}（${Math.round(handlingFeeRate * 100)}%）`;
  const reqId = `crefund_practice_${courseId.slice(0, 8)}`;
  const now = new Date();

  const course = { id: courseId, name: COURSE_NAME, gymId: GYM, price, maxStudents: 12,
    startDate, endDate, perSessionDeduction, handlingFeeRate,
    unlimitedPracticeStart: startDate, unlimitedPracticeEnd: dstr(71), gymAccessDaysAfter: 1,
    status: 'active', createdBy: 'seed', createdAt: now, updatedAt: now };
  const session = { id: sessionId, courseId, gymId: GYM, courseName: COURSE_NAME,
    date: startDate, startTime: '19:00', endTime: '20:30', status: 'scheduled',
    enrolledCount: 1, maxStudents: 12, createdAt: now, updatedAt: now };
  const enrollment = { id: enrollmentId, memberId: member.id, memberName: member.name,
    courseId, courseName: COURSE_NAME, sessionId, gymId: GYM, date: startDate,
    status: 'confirmed', paidAmount, paymentStatus: 'confirmed', paymentConfirmed: true,
    createdAt: now, updatedAt: now };
  const request = { id: reqId, type: 'refund', enrollmentId, courseId, courseName: COURSE_NAME,
    gymId: GYM, memberId: member.id, memberName: member.name, paidAmount, suggestedRefund,
    refundNote, perSessionDeduction, handlingFeeRate, reason: '個人因素無法上課（練習測試）',
    status: 'pending', createdAt: now, updatedAt: now };

  console.log(`報名人：${member.name}（${member.phone}）`);
  console.log(`課程：${COURSE_NAME}｜開課日 ${startDate}（未開課）｜課程費 NT$${price}`);
  console.log(`退費申請：已付 NT$${paidAmount} → 建議退款 NT$${suggestedRefund}（${refundNote}）｜status=pending`);
  console.log('待辦頁「需審核」會出現此筆，點審核可核准（退款）或拒絕。');

  if (!COMMIT) { console.log('\n（預覽模式，未寫入。確認後加 --commit）'); process.exit(0); }

  await clean();
  const b = db.batch();
  b.set(db.collection('courses').doc(courseId), course);
  b.set(db.collection('courseSessions').doc(sessionId), session);
  b.set(db.collection('courseEnrollments').doc(enrollmentId), enrollment);
  b.set(db.collection('courseAdjustmentRequests').doc(reqId), request);
  await b.commit();
  console.log('\n✅ 已建立 課程＋場次＋報名＋待審核退費申請');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
