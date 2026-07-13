// 拆分前後行為比對 smoke：唯讀呼叫 + 固定 fixture，輸出 JSON 供 diff
const { execSync } = require('child_process');
process.env.GOOGLE_APPLICATION_CREDENTIALS = execSync('ls ~/Downloads/redrock-dev-a35c1-firebase-adminsdk-*.json').toString().split('\n')[0];
const { initFirebase, getDb } = require('/Users/wanghongxiang/Downloads/redrock-api/src/config/firebase');
initFirebase();
const svc = require('/Users/wanghongxiang/Downloads/redrock-api/src/services/checkinService');
const db = getDb();
const MID = 'e2e-smoke-member';

(async () => {
  // fixture：會員（waiver+墜測 OK、成人）
  const now = new Date();
  await db.collection('members').doc(MID).set({ id: MID, name: '【E2E】smoke', phone: '0900444333', birthday: '1990-01-01', registeredBy: 'self', emailVerified: true, createdAt: now });
  await db.collection('waivers').doc(MID).set({ memberId: MID, isComplete: true, memberSignedAt: now });
  const ft = await db.collection('fallTests').add({ memberId: MID, result: 'passed', testedAt: now, createdAt: now });

  const member = (await db.collection('members').doc(MID).get()).data();
  const out = {};
  out.exports = Object.keys(svc).sort();
  out.memberType = svc.getMemberType(member);
  out.prices = svc.PRICES;
  out.computeAdult = await svc.computePaidEntryAmount('single_ticket', member, {});
  out.computeLegacy = await svc.computePaidEntryAmount('single_ticket', member, { legacyDiscountCard: true });
  out.computeChild = await svc.computePaidEntryAmount('child_free', { ...member, birthday: '2020-01-01' }, { legacyDiscountCard: true });
  out.checkWaiver = await svc.checkWaiver(MID);
  out.checkFallTest = await svc.checkFallTest(MID);
  out.hasSig = await svc.hasFallTestSignature(MID);
  out.gates = await svc.runEntryGates(MID, 'gym-hsinchu', {});
  out.verify = await svc.verifyEntry(MID, 'gym-hsinchu');
  out.passes = await svc.getValidPasses(MID, 'gym-hsinchu');
  out.vip = await svc.checkVip(MID);
  out.courseAccess = await svc.getCourseAccess(MID);
  out.tickets = await svc.getValidSingleEntryTickets(MID);
  out.todayStats = Object.keys(await svc.getTodayStats('gym-hsinchu')).sort();

  // 清理
  await db.collection('members').doc(MID).delete();
  await db.collection('waivers').doc(MID).delete();
  await ft.delete();
  // 穩定化（移除時間性欄位）
  const scrub = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/At$|expiresAt|_seconds|_nanoseconds|testedAt/i.test(k) ? undefined : v)));
  console.log(JSON.stringify(scrub(out), null, 1));
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL', e); process.exit(1); });
