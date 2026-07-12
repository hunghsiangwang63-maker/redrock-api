import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import bcrypt from '/Users/wanghongxiang/Downloads/redrock-api/node_modules/bcryptjs/index.js';
const saPath = execSync('ls ~/Downloads/redrock-dev-a35c1-firebase-adminsdk-*.json').toString().split('\n')[0];
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(saPath,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';

const MID = 'e2e-upe-minor';
const PHONE = '0900888777';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

async function cleanup() {
  await db.collection('members').doc(MID).delete().catch(()=>{});
  await db.collection('waivers').doc(MID).delete().catch(()=>{});
  const ft = await db.collection('fallTestSignatures').where('memberId','==',MID).get();
  for (const d of ft.docs) await d.ref.delete();
}

async function main() {
  await cleanup();
  // 建未成年會員（birthday 2012 → ~14歲），設密碼可登入
  await db.collection('members').doc(MID).set({
    id: MID, name:'【E2E】未成年', phone: PHONE, email:`e2e-upe@example.com`,
    birthday:'2012-01-01', isMinor:true, registeredBy:'self', emailVerified:true,
    passwordHash: bcrypt.hashSync('test1234', 10), createdAt: new Date(),
  });

  // 登入取 token
  const lr = await fetch(`${API}/auth/member/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ identifier: PHONE, password:'test1234' }) });
  const lj = await lr.json();
  ok(lr.ok && lj.token, `未成年登入 (${lr.status})`);
  const H = { 'Content-Type':'application/json', Authorization:`Bearer ${lj.token}` };

  // 1) 簽 waiver（帶家長 email）→ 此時墜測未簽 → 不應寄 email
  const wr = await fetch(`${API}/members/${MID}/waiver/sign`, { method:'POST', headers:H, body: JSON.stringify({ signatureData: SIG, parentEmail:'e2e-parent@example.com', parentName:'王大明', parentPhone:'0900111222', parentRelation:'父' }) });
  ok(wr.ok, `① 簽 waiver (${wr.status})`);
  let w = (await db.collection('waivers').doc(MID).get()).data();
  ok(w.parentRequired === true && !w.parentSignedAt, '   waiver parentRequired、家長未簽');
  ok(!w.parentEmailSentAt, '   墜測未簽 → 家長 email 尚未寄出');
  const token = w.parentSignToken;
  ok(!!token, '   waiver 產生 parentSignToken');

  // 2) 簽墜測同意書 → 兩份本人皆簽完 → 觸發統一 email
  const fr = await fetch(`${API}/fall-tests/sign`, { method:'POST', headers:H, body: JSON.stringify({ signatureData: SIG, watchPercent: 100, agreedParagraphs:['1'] }) });
  ok(fr.ok, `② 簽墜測同意書 (${fr.status})`);
  const ftSnap = await db.collection('fallTestSignatures').where('memberId','==',MID).get();
  const ftSig = ftSnap.docs[0]?.data();
  ok(ftSig?.parentRequired === true && !ftSig?.guardianSignedAt, '   墜測 parentRequired、家長未簽');
  w = (await db.collection('waivers').doc(MID).get()).data();
  ok(!!w.parentEmailSentAt, '   兩份簽完 → 家長統一 email 已寄（parentEmailSentAt）');

  // 3) GET 家長頁 token → 回傳 waiver + 墜測同意書內容 + pending
  const gr = await fetch(`${API}/auth/waiver/parent/${token}`);
  const gj = await gr.json();
  ok(gr.ok && gj.memberName === '【E2E】未成年', `③ GET 家長頁 (${gr.status})`);
  ok(gj.fallTest && gj.fallTest.pending === true, '   家長頁含墜測同意書、pending=true');

  // 4) POST 家長簽一次 → waiver + 墜測 皆完成
  const pr = await fetch(`${API}/auth/waiver/parent/${token}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ signatureData: SIG }) });
  ok(pr.ok, `④ 家長簽署 (${pr.status})`);
  w = (await db.collection('waivers').doc(MID).get()).data();
  ok(w.parentSignedAt && w.isComplete === true, '   waiver 家長已簽、isComplete');
  const ft2 = (await db.collection('fallTestSignatures').where('memberId','==',MID).get()).docs[0].data();
  ok(ft2.guardianSignedAt && ft2.guardianSignatureData, '   墜測同意書 guardianSignedAt + 簽名已回填（同一簽名套兩份）');
  ok(ft2.guardianName === '王大明', `   墜測 guardianName=家長名（${ft2.guardianName}）`);

  // 5) token 用完即廢
  const gr2 = await fetch(`${API}/auth/waiver/parent/${token}`);
  ok(gr2.status === 404 || gr2.status === 409, `⑤ token 用完失效 (${gr2.status})`);

  await cleanup();
  console.log('🧹 清理完成');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); await cleanup(); process.exit(1); });
