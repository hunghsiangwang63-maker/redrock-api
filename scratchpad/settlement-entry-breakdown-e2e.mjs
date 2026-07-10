import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM = 'gym-e2e-test';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;

// 各情境入場（都在 gym-e2e-test、今日、未取消）
const scen = [
  { entryType:'single_ticket', entryFee:300 },                                   // 成人
  { entryType:'single_ticket', entryFee:300 },                                   // 成人（再一筆→600）
  { entryType:'student_free',  entryFee:250 },                                   // 學生
  { entryType:'child_free',    entryFee:150 },                                   // 兒童
  { entryType:'single_ticket', entryFee:240, legacyDiscount:true },             // 個別使用優惠券（舊折扣卡8折）
  { entryType:'single_ticket', entryFee:270, isTeamDiscount:true },             // 隊員折扣
  { entryType:'single_ticket', entryFee:216, isTeamDiscount:true, legacyDiscount:true }, // 隊員＋優惠券
  { entryType:'discount_card', entryFee:0 },                                     // 優惠折扣券卡入場（0 元→不顯示）
];

(async()=>{
  const token = await login();
  const now = new Date();
  const ids = [];
  for (let i=0;i<scen.length;i++){
    const id = `e2e-eb-${Date.now()}-${i}`;
    await db.collection('checkIns').doc(id).set({
      id, memberId:'member-001', memberName:'林怡君', gymId:GYM,
      isCancelled:false, checkedInAt:now, createdAt:now, amountPaid:scen[i].entryFee,
      paymentMethod:'cash', shoesPrice:0, ...scen[i],
    });
    ids.push(id);
  }
  console.log('注入', ids.length, '筆入場到', GYM);

  const r = await fetch(`${API}/daily-settlements/today?gymId=${GYM}`,{headers:{Authorization:`Bearer ${token}`}});
  const j = await r.json();
  ok(r.status===200 && !j.alreadySettled, `GET /today 200 且未結帳（${r.status} alreadySettled=${j.alreadySettled}）`);
  const items = j.settlement?.income?.entryItems || [];
  const map = Object.fromEntries(items.map(x=>[x.label,x.value]));
  console.log('  entryItems:', JSON.stringify(items));
  ok(map['成人']===600, `成人 = 600（實得 ${map['成人']}）`);
  ok(map['學生']===250, `學生 = 250（實得 ${map['學生']}）`);
  ok(map['兒童']===150, `兒童 = 150（實得 ${map['兒童']}）`);
  ok(map['個別使用優惠券']===240, `個別使用優惠券 = 240（實得 ${map['個別使用優惠券']}）`);
  ok(map['隊員折扣']===270, `隊員折扣 = 270（實得 ${map['隊員折扣']}）`);
  ok(map['隊員＋優惠券']===216, `隊員＋優惠券 = 216（實得 ${map['隊員＋優惠券']}）`);
  ok(!('優惠折扣券' in map), `0 元 discount_card 不顯示（優惠折扣券 應無，實得 ${map['優惠折扣券']}）`);
  // 排序
  const order = items.map(x=>x.label);
  const expOrder = ['成人','學生','兒童','個別使用優惠券','隊員折扣','隊員＋優惠券'];
  ok(JSON.stringify(order)===JSON.stringify(expOrder), `排序正確（實得 ${order.join('>')}）`);
  // 入場總額 = 各項加總
  ok(j.settlement?.income?.entry === 300+300+250+150+240+270+216+0, `income.entry 總額 = 1426（實得 ${j.settlement?.income?.entry}）`);

  // 清理
  for (const id of ids) await db.collection('checkIns').doc(id).delete();
  console.log('🧹 已清理', ids.length, '筆注入入場');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
