const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const credDir = '/Users/wanghongxiang/Documents/RedRock/憑證';
const credFile = fs.readdirSync(credDir).find(f => f.startsWith('redrock-dev-a35c1-firebase-adminsdk'));
admin.initializeApp({ credential: admin.credential.cert(path.join(credDir, credFile)) });
const db = admin.firestore();

const API = 'https://api.redrocktaiwan.com';
const now = () => admin.firestore.Timestamp.now();
const uid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

const cleanup = { members: [], courseEnrollments: [], memberPasses: [], checkIns: [] };

async function main() {
  console.log('--- 建立測試父會員 ---');
  const parentId = uid('e2e-parent');
  const parentPhone = '0900' + Math.floor(100000 + Math.random()*899999);
  const parentPw = await bcrypt.hash('testpass123', 10);
  await db.collection('members').doc(parentId).set({
    id: parentId, name: '【E2E】測試家長', phone: parentPhone, email: `e2e-parent-${Date.now()}@example.com`,
    passwordHash: parentPw, isChildAccount: false, registeredBy: 'migration', emailVerified: true,
    birthday: '1985-01-01', gender: 'female', createdAt: now(), updatedAt: now(),
  });
  cleanup.members.push(parentId);
  console.log('parentId=', parentId, 'phone=', parentPhone);

  console.log('--- 父會員登入取得真實 token ---');
  const loginRes = await axios.post(`${API}/auth/member/login`, { identifier: parentPhone, password: 'testpass123' });
  const parentToken = loginRes.data.token;
  console.log('登入成功, token 長度=', parentToken.length);

  console.log('--- 用父會員 token 建立子女（真實端點） ---');
  const childRes = await axios.post(`${API}/members/my/children`, {
    name: '【E2E】測試子女', birthday: '2015-06-15', gender: 'male',
  }, { headers: { Authorization: `Bearer ${parentToken}` } });
  const childId = childRes.data.member?.id || childRes.data.id;
  cleanup.members.push(childId);
  console.log('childId=', childId);

  console.log('--- 為子女附加模擬「課程/票券/紀錄」既有歷史資料 ---');
  const enrollId = uid('e2e-enroll');
  await db.collection('courseEnrollments').doc(enrollId).set({
    id: enrollId, memberId: childId, memberName: '【E2E】測試子女', courseId: 'e2e-fake-course',
    courseName: '【E2E】測試課程', status: 'confirmed', gymId: 'gym-hsinchu',
    date: '2026-01-01', createdAt: now(),
  });
  cleanup.courseEnrollments.push(enrollId);

  const passId = uid('e2e-pass');
  await db.collection('memberPasses').doc(passId).set({
    id: passId, memberId: childId, passTypeName: '【E2E】測試定期票',
    startDate: '2026-01-01', endDate: '2027-01-01', status: 'active', scope: 'shared', gymId: 'gym-hsinchu',
  });
  cleanup.memberPasses.push(passId);

  const checkinId = uid('e2e-checkin');
  await db.collection('checkIns').doc(checkinId).set({
    id: checkinId, memberId: childId, memberName: '【E2E】測試子女', gymId: 'gym-hsinchu',
    entryType: 'course_access', amountPaid: 0, checkedInAt: now(), isCancelled: false,
  });
  cleanup.checkIns.push(checkinId);
  console.log('已附加 courseEnrollment/memberPass/checkIn 三筆資料，皆掛在 childId=', childId);

  console.log('--- 升級前：確認父會員可查到子女（/my/children） ---');
  const preChildren = await axios.get(`${API}/members/my/children`, { headers: { Authorization: `Bearer ${parentToken}` } });
  console.log('升級前 children 清單包含目標子女?', preChildren.data.children.some(c => c.id === childId));

  console.log('--- 執行升級 ---');
  const newPhone = '0911' + Math.floor(100000 + Math.random()*899999);
  const newEmail = `e2e-promoted-${Date.now()}@example.com`;
  const newPassword = 'newpass1234';
  const promoteRes = await axios.post(`${API}/members/my/children/${childId}/promote`, {
    phone: newPhone, email: newEmail, password: newPassword,
  }, { headers: { Authorization: `Bearer ${parentToken}` } });
  console.log('升級回應:', promoteRes.data);

  console.log('--- 驗證1：Firestore 上子女文件的欄位是否正確 ---');
  const childDoc = await db.collection('members').doc(childId).get();
  const cd = childDoc.data();
  console.log({
    phone: cd.phone, email: cd.email, isChildAccount: cd.isChildAccount,
    parentMemberId: cd.parentMemberId, coParentIds: cd.coParentIds,
    formerParentMemberId: cd.formerParentMemberId, promotedByMemberId: cd.promotedByMemberId,
  });
  const check1 = cd.phone === newPhone && cd.email === newEmail && cd.isChildAccount === false
    && cd.parentMemberId === null && cd.coParentIds === undefined && cd.formerParentMemberId === parentId;
  console.log(check1 ? '✅ 欄位正確（電話/Email/isChildAccount/parentMemberId清空/coParentIds移除/formerParentMemberId留痕）' : '❌ 欄位不符預期');

  console.log('--- 驗證2：升級後的成員可用新電話+密碼獨立登入 ---');
  const newLoginRes = await axios.post(`${API}/auth/member/login`, { identifier: newPhone, password: newPassword });
  const newToken = newLoginRes.data.token;
  console.log('✅ 新登入成功, member=', newLoginRes.data.member?.name);

  console.log('--- 驗證3：用新 token 查詢「我的課程/票券/紀錄」，確認舊資料完整帶過去 ---');
  const [enrollCheck, passCheck, historyCheck] = await Promise.all([
    axios.get(`${API}/courses/member/${childId}/enrollments`, { headers: { Authorization: `Bearer ${newToken}` } }).catch(e => ({ error: e.response?.data })),
    axios.get(`${API}/passes/member/${childId}`, { headers: { Authorization: `Bearer ${newToken}` } }).catch(e => ({ error: e.response?.data })),
    axios.get(`${API}/checkin/history?memberId=${childId}`, { headers: { Authorization: `Bearer ${newToken}` } }).catch(e => ({ error: e.response?.data })),
  ]);
  const foundEnroll = (enrollCheck.data?.enrollments || enrollCheck.data || []).some?.(e => e.id === enrollId || e.courseId === 'e2e-fake-course');
  const foundPass = (passCheck.data?.passes || passCheck.data || []).some?.(p => p.id === passId);
  console.log('課程紀錄查得到?', foundEnroll, JSON.stringify(enrollCheck.data).slice(0,200));
  console.log('定期票查得到?', foundPass, JSON.stringify(passCheck.data).slice(0,200));
  console.log('入場紀錄查詢結果:', JSON.stringify(historyCheck.data || historyCheck.error).slice(0,300));

  console.log('--- 驗證4：升級後，前家長的 /my/children 不再看得到此人（關係已切斷） ---');
  const postChildren = await axios.get(`${API}/members/my/children`, { headers: { Authorization: `Bearer ${parentToken}` } });
  const stillThere = postChildren.data.children.some(c => c.id === childId);
  console.log(stillThere ? '❌ 仍出現在家長清單中（未切斷）' : '✅ 已從家長清單消失（關係已切斷）');

  console.log('--- 驗證5：前家長已無法再代操作此人（擁有權檢查應拒絕） ---');
  try {
    await axios.post(`${API}/members/my/skip-self-entry`, { targetMemberId: childId }, { headers: { Authorization: `Bearer ${parentToken}` } });
    console.log('⚠️ 此端點可能不存在或行為不同，非本次驗證重點，略過');
  } catch (e) {
    console.log('（略過非核心端點測試，改用課程報名 ownership 檢查更直接，見下）');
  }
  // 直接測試 checkMemberOwnership 常見用法：家長試圖幫「已獨立」的人請假查詢（會走 checkMemberOwnership）
  try {
    const r = await axios.get(`${API}/course-adjustments/member/${childId}`, { headers: { Authorization: `Bearer ${parentToken}` } });
    console.log('❌ 前家長仍可查詢已獨立會員的課程異動紀錄（未真正切斷）:', r.status);
  } catch (e) {
    if (e.response?.status === 403) console.log('✅ 前家長查詢已獨立會員資料被拒絕 (403)，關係確實已切斷');
    else console.log('查詢結果非預期:', e.response?.status, e.response?.data);
  }

  console.log('\n=== 測試完成，開始清理 ===');
}

main().then(async () => {
  console.log('清理測試資料...');
  for (const id of cleanup.members) { await db.collection('members').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.courseEnrollments) { await db.collection('courseEnrollments').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.memberPasses) { await db.collection('memberPasses').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.checkIns) { await db.collection('checkIns').doc(id).delete().catch(()=>{}); }
  console.log('清理完成。殘留檢查...');
  for (const id of cleanup.members) {
    const d = await db.collection('members').doc(id).get();
    console.log(id, '殘留?', d.exists);
  }
  process.exit(0);
}).catch(async (e) => {
  console.error('測試失敗:', e.response?.data || e.message);
  console.log('嘗試清理已建立的資料...');
  for (const id of cleanup.members) { await db.collection('members').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.courseEnrollments) { await db.collection('courseEnrollments').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.memberPasses) { await db.collection('memberPasses').doc(id).delete().catch(()=>{}); }
  for (const id of cleanup.checkIns) { await db.collection('checkIns').doc(id).delete().catch(()=>{}); }
  process.exit(1);
});
