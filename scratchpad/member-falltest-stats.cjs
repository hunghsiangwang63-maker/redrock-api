const admin = require('firebase-admin');
const sa = require('/Users/wanghongxiang/Downloads/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const [mSnap, ftSnap, lftSnap] = await Promise.all([
    db.collection('members').get(),
    db.collection('fallTests').get(),
    db.collection('legacyFallTests').get(),
  ]);

  const isTestName = (n='') => /^【練習】|測試|^Test1$|^Who$/.test(n);

  // 分類會員
  const members = mSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const real = members.filter(m => !isTestName(m.name || ''));
  const mainReal = real.filter(m => !m.isChildAccount);
  const childReal = real.filter(m => m.isChildAccount);
  const testMembers = members.filter(m => isTestName(m.name || ''));

  // 每會員最新 passed 墜測 source
  const ftByMember = {};
  ftSnap.docs.forEach(d => {
    const x = d.data();
    if (x.result !== 'passed') return;
    const mid = x.memberId;
    const t = x.testedAt?._seconds || x.createdAt?._seconds || 0;
    if (!ftByMember[mid] || t > ftByMember[mid].t) ftByMember[mid] = { source: x.source || 'onsite', t };
  });

  // 有效主帳號的墜測狀態
  let claimed = 0, onsite = 0, none = 0;
  mainReal.forEach(m => {
    const ft = ftByMember[m.id];
    if (!ft) { none++; return; }
    if (ft.source === 'climbio-migrated') claimed++;
    else onsite++;
  });

  const withFt = claimed + onsite;

  // legacyFallTests 認領統計
  const lft = lftSnap.docs.map(d => d.data());
  const lftClaimed = lft.filter(x => x.claimed === true).length;

  console.log('===== 會員統計 =====');
  console.log('members 集合總數:', members.length);
  console.log('  測試 fixture:', testMembers.length, testMembers.map(m=>m.name).join('、'));
  console.log('  有效會員(非測試):', real.length, `（主帳號 ${mainReal.length}＋子會員 ${childReal.length}）`);
  console.log('  有效主帳號 Email 已驗證:', mainReal.filter(m=>m.emailVerified).length);
  console.log('  有效主帳號 是攀岩隊員:', mainReal.filter(m=>m.isTeamMember).length);

  console.log('\n===== 有效主帳號墜測狀態 (' + mainReal.length + ' 人) =====');
  console.log('  已通過墜測:', withFt, `(${(withFt/mainReal.length*100).toFixed(1)}%)`);
  console.log('    ├ Climbio 認領(免重測):', claimed);
  console.log('    └ 現場實測 passed:', onsite);
  console.log('  尚未通過墜測:', none);

  console.log('\n  【墜測認領比例】');
  console.log('    佔全部有效主帳號:', `${claimed}/${mainReal.length} = ${(claimed/mainReal.length*100).toFixed(1)}%`);
  console.log('    佔已通過墜測者:', `${claimed}/${withFt} = ${(claimed/withFt*100).toFixed(1)}%`);

  console.log('\n===== legacyFallTests 名單認領 =====');
  console.log('  名單總數:', lft.length, '｜已認領 claimed:', lftClaimed);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
