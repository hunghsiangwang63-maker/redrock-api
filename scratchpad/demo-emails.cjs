process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  require('os').homedir() + '/Documents/RedRock/憑證/' +
  require('fs').readdirSync(require('os').homedir() + '/Documents/RedRock/憑證/').find(f => f.includes('adminsdk'));
const { getDb, initFirebase } = require('../src/config/firebase');
initFirebase();
const db = getDb();
const courseService = require('../src/services/courseService');
const fs = require('fs');

const DEMO_EMAIL = 'chihchiu_chu@yahoo.com.tw';

(async () => {
  // ══════════════ 課程：施友芙 士林 9-1月 小蜘蛛人初級班週日A班 ══════════════
  console.log('=== 課程合約 Demo：施友芙 ===');
  const memberId = '26bb4105-25b8-43a5-a70b-ee6296214c91';
  const courseId = '53a7efdc-fc8d-4d8d-8229-9983bbbb0168';

  const memberSnap = await db.collection('members').doc(memberId).get();
  const member = memberSnap.data();
  console.log('會員:', member.name, member.email, member.birthday);

  const courseSnap = await db.collection('courses').doc(courseId).get();
  const course = { id: courseId, ...courseSnap.data() };
  console.log('課程:', course.name, course.gymId, course.startDate, '~', course.endDate);

  const category = await courseService.getCategoryOf(db, course.categoryId);
  const rules = courseService.resolveRules(course, category);
  console.log('退費費率: 開課前', rules.preStartFeeRate, '/ 開課後', rules.handlingFeeRate);

  const enrollSnap = await db.collection('courseEnrollments')
    .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
  const enrollments = enrollSnap.docs.map(d => d.data()).filter(e => e.status !== 'cancelled');
  const today = require('../src/utils/taiwanDate').taiwanToday();
  const futureSessions = enrollments.filter(e => !e.date || e.date >= today).map(e => ({ date: e.date, startTime: e.startTime, endTime: e.endTime, gymId: e.gymId }));
  console.log('有效報名場次數:', enrollments.length, '未來場次數:', futureSessions.length);

  const headerSnap = await db.collection('courseRegistrations')
    .where('courseId', '==', courseId).where('memberId', '==', memberId).get();
  const header = headerSnap.docs.map(d => d.data()).find(h => h.status !== 'cancelled');
  const fee = header?.fee ?? enrollments[0]?.enrollmentFee ?? 0;
  const paymentMethod = header?.paymentMethod || 'cash';
  console.log('fee:', fee, 'paymentMethod:', paymentMethod, 'installmentPlanId:', header?.installmentPlanId || '(無)');

  let coursePlan = null;
  if (header?.installmentPlanId) {
    const planSnap = await db.collection('installmentPlans').doc(header.installmentPlanId).get();
    if (planSnap.exists) coursePlan = planSnap.data();
  }

  const { issueCourseContract } = require('../src/services/courseContractService');
  const { pdfBuffer: coursePdf } = await issueCourseContract({
    memberId, memberName: member.name, isGuest: false,
    course, futureSessions: futureSessions.length ? futureSessions : [{ date: course.startDate, startTime: '', endTime: '' }],
    fee, paymentMethod, coursePlan,
    refundFeeRate: rules.handlingFeeRate, refundPreStartFeeRate: rules.preStartFeeRate,
    gymId: course.gymId,
    portraitSignature: null, guardianSignature: null,
    dryRun: true,
  });
  fs.writeFileSync('/tmp/demo-course-contract.pdf', coursePdf);
  console.log('課程合約 PDF bytes:', coursePdf.length, '→ /tmp/demo-course-contract.pdf');

  const { sendCourseContractPdf } = require('../src/services/emailService');
  await sendCourseContractPdf({ to: DEMO_EMAIL, memberName: member.name, courseName: course.name, pdfBuffer: coursePdf });
  console.log('✅ 課程合約 demo 信已寄送至', DEMO_EMAIL);

  // ══════════════ 定期票：林祺堂 90日定期票 ══════════════
  console.log('\n=== 定期票合約 Demo：林祺堂 ===');
  const passMemberId = '666ffc1c-bc54-4578-a5a8-01363e93aabb';
  const passId = 'b925c098-26ef-46a6-886a-c0b12f7d716d';

  const passMemberSnap = await db.collection('members').doc(passMemberId).get();
  const passMember = passMemberSnap.data();
  console.log('會員:', passMember.name, passMember.email, passMember.birthday);

  const passSnap = await db.collection('memberPasses').doc(passId).get();
  const pass = passSnap.data();
  console.log('票:', pass.passTypeName, pass.scope, pass.startDate, '~', pass.endDate);

  const { issuePassContract } = require('../src/services/passContractService');
  const { pdfBuffer: passPdf } = await issuePassContract({
    memberId: passMemberId, memberName: passMember.name,
    passTypeName: pass.passTypeName, scope: pass.scope, targetGymId: pass.targetGymId,
    startDate: pass.startDate, endDate: pass.endDate,
    fee: 3600, paymentMethod: 'cash', // 90日票原價，供 demo 展示（此票為舊系統移轉，無原始 fee 記錄）
    gymId: pass.gymId || 'gym-hsinchu',
    portraitSignature: null, guardianSignature: null,
    installments: null,
    dryRun: true,
  });
  fs.writeFileSync('/tmp/demo-pass-contract.pdf', passPdf);
  console.log('定期票合約 PDF bytes:', passPdf.length, '→ /tmp/demo-pass-contract.pdf');

  const { sendPassContractPdf } = require('../src/services/emailService');
  await sendPassContractPdf({ to: DEMO_EMAIL, memberName: passMember.name, passTypeName: pass.passTypeName, pdfBuffer: passPdf });
  console.log('✅ 定期票合約 demo 信已寄送至', DEMO_EMAIL);

  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
