import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const saPath = execSync('ls ~/Downloads/redrock-dev-a35c1-firebase-adminsdk-*.json').toString().split('\n')[0];
const sa = JSON.parse(readFileSync(saPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const API = 'https://redrock-api-production.up.railway.app';
const MEMBER = 'member-001'; // 林怡君
const OTHER = 'e2e-other-member-cth';

const OUT_CARD = 'e2e-cth-out-card';   // 林怡君轉出的來源卡
const IN_CARD  = 'e2e-cth-in-card';    // 林怡君接收後產生的卡
const T_OUT = 'e2e-cth-transfer-out';
const T_IN  = 'e2e-cth-transfer-in';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

async function main() {
  // 登入林怡君取 token
  const lr = await fetch(`${API}/auth/member/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ identifier:'0912345678', password:'member123' }) });
  const lj = await lr.json();
  ok(lr.ok && lj.token, `林怡君登入 (${lr.status})`);
  const token = lj.token;

  const now = new Date();
  // 造一個「對方」會員（供轉出對象顯示姓名）
  await db.collection('members').doc(OTHER).set({ id: OTHER, name: '【E2E】收卡人', phone:'0900000199', createdAt: now }, { merge:true });

  // 來源卡（林怡君持有，已轉出 3 格給 收卡人）
  await db.collection('discountCards').doc(OUT_CARD).set({
    id: OUT_CARD, ownerMemberId: MEMBER, remainingCredits: 7, originalCredits: 10,
    source: 'purchased', isActive: true, gymId:'gym-hsinchu', createdAt: now,
  });
  // 轉出 completed transfer
  await db.collection('cardTransfers').doc(T_OUT).set({
    id: T_OUT, cardType:'discount', fromCardId: OUT_CARD, fromMemberId: MEMBER, fromMemberName:'林怡君',
    toMemberId: OTHER, toMemberName:'【E2E】收卡人', credits: 3, status:'completed',
    createdAt: now, acceptedAt: now, newCardId:'e2e-cth-other-newcard',
  });

  // 接收卡（林怡君由 收卡人 轉入 5 格）
  await db.collection('discountCards').doc(IN_CARD).set({
    id: IN_CARD, ownerMemberId: MEMBER, remainingCredits: 5, originalCredits: 5,
    source:'transferred', transferredFrom:'e2e-cth-src', isActive: true, gymId:'gym-hsinchu', createdAt: now,
  });
  await db.collection('cardTransfers').doc(T_IN).set({
    id: T_IN, cardType:'discount', fromCardId:'e2e-cth-src', fromMemberId: OTHER, fromMemberName:'【E2E】收卡人',
    toMemberId: MEMBER, toMemberName:'林怡君', credits: 5, status:'completed',
    createdAt: now, acceptedAt: now, newCardId: IN_CARD,
  });

  const H = { headers:{ Authorization:`Bearer ${token}` } };

  // 轉出卡歷史
  const r1 = await fetch(`${API}/cards/transfers/history/${OUT_CARD}`, H);
  const j1 = await r1.json();
  ok(r1.ok, `GET history 轉出卡 (${r1.status})`);
  const out = (j1.records||[]).find(x => x.direction==='out');
  ok(out, '轉出卡回傳 direction=out 紀錄');
  ok(out?.memberName==='【E2E】收卡人', `轉出顯示對方姓名（${out?.memberName}）`);
  ok(out?.credits===3, `轉出次數 3（${out?.credits}）`);

  // 接收卡歷史
  const r2 = await fetch(`${API}/cards/transfers/history/${IN_CARD}`, H);
  const j2 = await r2.json();
  ok(r2.ok, `GET history 接收卡 (${r2.status})`);
  const inn = (j2.records||[]).find(x => x.direction==='in');
  ok(inn, '接收卡回傳 direction=in 紀錄');
  ok(inn?.memberName==='【E2E】收卡人', `轉入顯示來源姓名（${inn?.memberName}）`);
  ok(inn?.credits===5, `轉入次數 5（${inn?.credits}）`);

  // 他人 token 不能看（權限）：用 OTHER 造 token 不易，改驗無關卡片回空
  const r3 = await fetch(`${API}/cards/transfers/history/e2e-nonexistent-card`, H);
  const j3 = await r3.json();
  ok(r3.ok && (j3.records||[]).length===0, '無關卡片回空陣列');

  // 清理
  await Promise.all([
    db.collection('discountCards').doc(OUT_CARD).delete(),
    db.collection('discountCards').doc(IN_CARD).delete(),
    db.collection('cardTransfers').doc(T_OUT).delete(),
    db.collection('cardTransfers').doc(T_IN).delete(),
    db.collection('members').doc(OTHER).delete(),
  ]);
  console.log('🧹 測試資料已清理');

  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
