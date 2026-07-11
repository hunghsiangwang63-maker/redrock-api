import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import XLSX from 'xlsx';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM = 'gym-e2e-test';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;

const scen = [
  { entryType:'single_ticket', entryFee:300 },
  { entryType:'single_ticket', entryFee:300 },
  { entryType:'student_free',  entryFee:250 },
  { entryType:'child_free',    entryFee:150 },
  { entryType:'single_ticket', entryFee:240, legacyDiscount:true },
  { entryType:'single_ticket', entryFee:270, isTeamDiscount:true },
  { entryType:'single_ticket', entryFee:216, isTeamDiscount:true, legacyDiscount:true },
  { entryType:'discount_card', entryFee:0 },   // 0 元 → 不應出現
];

(async()=>{
  const token = await login();
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const ids = [];
  for (let i=0;i<scen.length;i++){
    const id = `e2e-mx-${Date.now()}-${i}`;
    await db.collection('checkIns').doc(id).set({ id, memberId:'member-001', memberName:'林怡君', gymId:GYM, isCancelled:false, checkedInAt:now, createdAt:now, amountPaid:scen[i].entryFee, paymentMethod:'cash', shoesPrice:0, ...scen[i] });
    ids.push(id);
  }
  console.log('注入', ids.length, '筆入場到', GYM, '月份', month);

  const r = await fetch(`${API}/daily-settlements/monthly-export?month=${month}&gymId=${GYM}`,{headers:{Authorization:`Bearer ${token}`}});
  ok(r.status===200, `monthly-export → 200（${r.status}）`);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
  // 找「入場費」列：col0==='入場費'，col1=分類，其餘=每日值
  const entryRows = rows.filter(row => row[0] === '入場費');
  const found = {};
  entryRows.forEach(row => { const label = row[1]; const sum = row.slice(3).reduce((a,v)=>a+(Number(v)||0),0); found[label] = sum; });
  console.log('  入場費列:', JSON.stringify(found));
  ok(found['成人']===600, `成人 = 600（${found['成人']}）`);
  ok(found['學生']===250, `學生 = 250（${found['學生']}）`);
  ok(found['兒童']===150, `兒童 = 150（${found['兒童']}）`);
  ok(found['個別使用優惠券']===240, `個別使用優惠券 = 240（${found['個別使用優惠券']}）`);
  ok(found['隊員折扣']===270, `隊員折扣 = 270（${found['隊員折扣']}）`);
  ok(found['隊員＋優惠券']===216, `隊員＋優惠券 = 216（${found['隊員＋優惠券']}）`);
  ok(!('優惠折扣券' in found) && !('優惠卡入場' in found), `0 元 discount_card 不出現列`);
  // 分類列順序符合 ENTRY_ORDER
  const order = entryRows.map(r=>r[1]);
  const exp = ['成人','學生','兒童','個別使用優惠券','隊員折扣','隊員＋優惠券'];
  ok(JSON.stringify(order)===JSON.stringify(exp), `列順序正確（${order.join('>')}）`);

  for (const id of ids) await db.collection('checkIns').doc(id).delete();
  console.log('🧹 已清理', ids.length, '筆');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
