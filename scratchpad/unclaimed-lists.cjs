const admin = require('firebase-admin');
const sa = require('/Users/wanghongxiang/Downloads/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10); // 台灣今天

const GYM = { 'gym-hsinchu':'新竹', 'gym-shilin':'士林' };

(async () => {
  const [tmSnap, lpSnap] = await Promise.all([
    db.collection('legacyTeamMembers').get(),
    db.collection('legacyPasses').get(),
  ]);

  const tm = tmSnap.docs.map(d=>d.data());
  const lp = lpSnap.docs.map(d=>d.data());

  const tmUn = tm.filter(x => x.claimed !== true);
  console.log(`===== 攀岩隊員未認領 (${tmUn.length}/${tm.length}) =====`);
  const byGym = {};
  tmUn.forEach(x => { const g = GYM[x.gymId] || x.gymId || '?'; (byGym[g]=byGym[g]||[]).push(x); });
  Object.keys(byGym).sort().forEach(g => {
    console.log(`\n【${g}館】${byGym[g].length} 位`);
    byGym[g].sort((a,b)=>(a.name||'').localeCompare(b.name||'','zh')).forEach(x =>
      console.log(`  ${x.name}  ${x.phone||'(無電話)'}`));
  });

  const lpUn = lp.filter(x => x.claimed !== true);
  console.log(`\n\n===== 定期票(90日)未認領 (${lpUn.length}/${lp.length}) =====`);
  lpUn.sort((a,b)=>String(a.endDate||'').localeCompare(String(b.endDate||''))).forEach(x => {
    const end = String(x.endDate||'').slice(0,10);
    const expired = end && end < today ? '  ⚠️已過期(系統不發)' : '';
    console.log(`  ${x.name}  ${x.phone||''}  ${GYM[x.gymId]||x.gymId}  到期 ${end}${expired}`);
  });

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
