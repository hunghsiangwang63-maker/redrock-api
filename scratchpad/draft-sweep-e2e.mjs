import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import dayjs from 'dayjs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;

(async()=>{
  const token = await login();
  const now = new Date();
  const d0 = dayjs().format('YYYY-MM-DD');           // 今天
  const d2 = dayjs().subtract(2,'day').format('YYYY-MM-DD');  // 今天−2（保留）
  const d5 = dayjs().subtract(5,'day').format('YYYY-MM-DD');  // 今天−5（draft 應刪、settled 保留）
  const docs = [
    { id:'e2e-draft-d0', date:d0, status:'draft',   keep:true  },
    { id:'e2e-draft-d2', date:d2, status:'draft',   keep:true  },
    { id:'e2e-draft-d5', date:d5, status:'draft',   keep:false },  // 唯一應刪
    { id:'e2e-settled-d5', date:d5, status:'settled', keep:true },  // 舊 settled 永不刪
  ];
  for (const x of docs) await db.collection('dailySettlements').doc(x.id).set({ id:x.id, gymId:'gym-e2e-test', date:x.date, status:x.status, createdAt:now });
  console.log('注入 4 筆：draft d0/d2/d5 + settled d5（cutoff=今天−3=', dayjs().subtract(3,'day').format('YYYY-MM-DD'),'）');

  const r = await fetch(`${API}/daily-settlements/sweep-stale-drafts`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});
  const j = await r.json();
  ok(r.status===200, `POST sweep-stale-drafts → 200（${r.status}）`);
  console.log('  回傳:', JSON.stringify(j), '（deleted 含全庫其他逾期 draft，故 >=1）');
  ok(typeof j.deleted === 'number' && j.deleted >= 1, `deleted >= 1（實得 ${j.deleted}）`);

  // 逐筆檢查存活
  for (const x of docs) {
    const exists = (await db.collection('dailySettlements').doc(x.id).get()).exists;
    ok(exists === x.keep, `${x.id}（${x.date}/${x.status}）${x.keep?'保留':'刪除'} → ${exists?'存在':'不存在'}`);
  }

  // 冪等：再跑一次，測試 doc 狀態不變（d5 draft 已刪）
  const r2 = await fetch(`${API}/daily-settlements/sweep-stale-drafts`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});
  ok(r2.status===200, `再跑一次 → 200（冪等）`);
  ok((await db.collection('dailySettlements').doc('e2e-settled-d5').get()).exists, `settled d5 二次後仍保留`);

  // 權限：非 super_admin 擋（用會員 token 打不到，改驗無 token → 401）
  const rNoAuth = await fetch(`${API}/daily-settlements/sweep-stale-drafts`,{method:'POST'});
  ok(rNoAuth.status===401 || rNoAuth.status===403, `無認證 → 401/403（實得 ${rNoAuth.status}）`);

  // 清理
  for (const x of docs) await db.collection('dailySettlements').doc(x.id).delete();
  console.log('🧹 已清理注入的測試 doc');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
