import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM='gym-e2e-test';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H=(t)=>({Authorization:`Bearer ${t}`});
const now=new Date();
(async()=>{
  const tok=await login();
  const ids={ci:[],tx:[],ps:[]};
  // checkIn1: 付費入場 300 現金
  let r=await db.collection('checkIns').add({memberId:'m',gymId:GYM,entryType:'single_ticket',entryFee:300,shoesPrice:0,chalkPrice:0,amountPaid:300,paymentMethod:'cash',isCancelled:false,checkedInAt:now}); ids.ci.push(r.id);
  // checkIn2: 免費入場+租借150、無付款方式(null) → 應歸現金
  r=await db.collection('checkIns').add({memberId:'m',gymId:GYM,entryType:'pass',shoesPrice:100,chalkPrice:50,amountPaid:150,paymentMethod:null,isCancelled:false,checkedInAt:now}); ids.ci.push(r.id);
  // 商品 500 轉帳
  r=await db.collection('productSales').add({gymId:GYM,totalAmount:500,paymentMethod:'transfer',soldAt:now}); ids.ps.push(r.id);
  // 課程 1000 LinePay（今日認列）
  r=await db.collection('transactions').add({gymId:GYM,type:'course',totalAmount:1000,paymentMethod:'linepay',paymentStatus:'completed',recognitionDate:now,paidAt:now}); ids.tx.push(r.id);
  // 定期票 2000 轉帳
  r=await db.collection('transactions').add({gymId:GYM,type:'pass',totalAmount:2000,paymentMethod:'transfer',paymentStatus:'completed',recognitionDate:now,paidAt:now,notes:'定期票購買：半年票'}); ids.tx.push(r.id);

  const j=await (await fetch(`${API}/daily-settlements/today?gymId=${GYM}`,{headers:H(tok)})).json();
  const i=j.settlement?.income||{}, p=j.settlement?.payment||{};
  console.log('  income:', JSON.stringify({entry:i.entry,shoeRental:i.shoeRental,product:i.product,course:i.course,pass:i.pass,total:i.total}));
  console.log('  payment:', JSON.stringify({cash:p.cash,linePay:p.linePay,jko:p.jko,taiwanPay:p.taiwanPay,transfer:p.transfer}));
  ok(i.total===3950, `今日收入 total=3950（實得 ${i.total}）`);
  ok(p.cash===450, `現金=450（入場300+免費租借150；實得 ${p.cash}）`);
  ok(p.linePay===1000, `LinePay=1000（課程；實得 ${p.linePay}）`);
  ok(p.transfer===2500, `轉帳=2500（商品500+定期票2000；實得 ${p.transfer}）`);
  const payTotal=(p.cash||0)+(p.linePay||0)+(p.jko||0)+(p.taiwanPay||0)+(p.transfer||0);
  ok(payTotal===i.total, `付款方式合計(${payTotal}) == 今日收入(${i.total}) ✓對齊`);

  // 清理
  for(const id of ids.ci) await db.collection('checkIns').doc(id).delete();
  for(const id of ids.ps) await db.collection('productSales').doc(id).delete();
  for(const id of ids.tx) await db.collection('transactions').doc(id).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
