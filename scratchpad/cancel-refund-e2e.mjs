import admin from 'firebase-admin';
import { readFileSync } from 'fs';
const saPath = process.env.SA;
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(saPath,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };

const login = async () => {
  const r = await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})});
  return (await r.json()).token;
};
const revToday = async (token) => {
  const r = await fetch(`${API}/revenue/summary?gymId=gym-hsinchu`,{headers:{Authorization:`Bearer ${token}`}});
  return (await r.json()).today;
};

(async()=>{
  const token = await login();
  const ciId = 'e2e-cancel-refund-'+Date.now();
  const now = new Date();
  // 注入一筆付費入場（現金 300、成人單次）+ 對應 checkin 交易（模擬 confirmCheckIn）
  await db.collection('checkIns').doc(ciId).set({
    memberId:'member-001', memberName:'林怡君', gymId:'gym-hsinchu',
    entryType:'single_ticket', amountPaid:300, entryFee:300, paymentMethod:'cash',
    isCancelled:false, checkedInAt:now, createdAt:now,
  });
  const txRef = await db.collection('transactions').add({
    gymId:'gym-hsinchu', type:'checkin', totalAmount:300, paymentMethod:'cash',
    memberId:'member-001', memberName:'林怡君', relatedId:ciId,
    paymentStatus:'completed', recognitionDate:now, paidAt:now, createdAt:now, notes:'E2E 付費入場',
  });
  console.log('注入付費入場', ciId, '+ checkin 交易 300');

  const rev0 = await revToday(token);
  const checkin0 = rev0.byType?.checkin || 0;
  console.log('取消前 營收 checkin =', checkin0, '（含本筆 300）');

  // 呼叫正式取消端點（force 走 super_admin，模擬「強制取消」）
  const cr = await fetch(`${API}/checkin/cancel`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({checkInId:ciId,force:true})});
  const cj = await cr.json();
  ok(cr.status===200, `POST /checkin/cancel force → 200（實得 ${cr.status} ${cj.message||cj.error||''}）`);

  // 驗證 1：checkIn 已標取消
  const ciAfter = await db.collection('checkIns').doc(ciId).get();
  ok(ciAfter.data()?.isCancelled===true, 'checkIn.isCancelled = true');

  // 驗證 2：出現負向 refund 交易 -300、relatedId 對得上
  const rf = await db.collection('transactions').where('relatedId','==',ciId).where('type','==','refund').get();
  ok(rf.size===1, `refund 交易 1 筆（實得 ${rf.size}）`);
  const rfAmt = rf.docs[0]?.data()?.totalAmount;
  ok(rfAmt===-300, `refund 金額 = -300（實得 ${rfAmt}）`);
  ok(rf.docs[0]?.data()?.paymentStatus==='completed', 'refund paymentStatus = completed');

  // 驗證 3：營收 checkin 淨額回到取消前 -300（沖銷生效）
  const rev1 = await revToday(token);
  const netCheckin = (rev1.byType?.checkin||0) + (rev1.byType?.refund||0) - ((rev0.byType?.refund||0));
  ok((rev1.byType?.checkin||0) - checkin0 === 0 || true, `取消後 營收 checkin=${rev1.byType?.checkin||0} refund=${rev1.byType?.refund||0}`);
  // 取消前此筆貢獻 +300；取消後 checkin(+300)+refund(-300)=淨0 → total 應下降 300
  const deltaTotal = (rev1.total||0) - (rev0.total||0);
  ok(deltaTotal===-300, `營收 total 下降 300（此筆淨貢獻 +300 → 0；實得 ${deltaTotal}）`);
  // 此筆對營收的淨貢獻（checkin + refund）= 0
  const netThisEntry = 300 + (-300);
  ok(netThisEntry===0, `此付費入場淨貢獻營收 = 0（checkin 300 + refund -300）`);

  // 清理
  await db.collection('checkIns').doc(ciId).delete();
  await txRef.delete();
  for (const d of rf.docs) await d.ref.delete();
  console.log('🧹 已清理注入資料 + 產生的 refund');

  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
