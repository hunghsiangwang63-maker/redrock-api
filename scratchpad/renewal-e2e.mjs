// E2E: 定期票會員端續約（產生入場QR勾選、到期前14天）— 打 Railway 正式 API
import dayjs from '/Users/wanghongxiang/Downloads/redrock-api/node_modules/dayjs/dayjs.min.js';
const API = 'https://redrock-api-production.up.railway.app';
const GYM = 'gym-hsinchu';
let P = 0, F = 0;
const ok = (c, m) => { c ? P++ : F++; console.log((c ? '✅' : '❌') + ' ' + m); };
const j = async r => { const s = r.status; const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = { _raw: t }; } b._status = s; return b; };
const rq = (m, p, b, tok) => fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) }).then(j);
const post = (p, b, tok) => rq('POST', p, b, tok);
const get = (p, tok) => rq('GET', p, null, tok);
const put = (p, b, tok) => rq('PUT', p, b, tok);
const del = (p, tok) => rq('DELETE', p, null, tok);

const ver = (await get('/health')).version;
ok(ver === '1.62.0-pass-renewal-at-entry', `部署版本=${ver}`);
const TOK = (await post('/auth/staff/login', { email: 'admin@redrock.app', password: 'redrock123' })).token;
ok(!!TOK, 'admin 登入');
const MEMBER = 'member-001';

const inst = { enabled: true, periods: [{ percent: 40, dueOffsetDays: 0 }, { percent: 40, dueOffsetDays: 30 }, { percent: 20, dueOffsetDays: 60 }] };
let typeId, passId;
const cancels = [];
try {
  // 建票種：半年票 7600、續約9折(6840)、3期 40/40/20
  const t = await post('/passes/types', { name: '【練習】續約E2E票', scope: 'shared', price: 7600, durationMonths: 6, renewalDiscount: { mode: 'percent', value: 10 }, installment: inst, isActive: true }, TOK);
  typeId = t.passType?.id; ok(!!typeId, `建票種 ${typeId}`);

  // 發一張定期票給林怡君（deferPayment 不記營收），再 PUT endDate=今+5天（進續約窗）
  const today = dayjs().format('YYYY-MM-DD');
  const cp = await post('/passes', { memberId: MEMBER, passTypeId: typeId, startDate: today, deferPayment: true, paymentPlan: 'full' }, TOK);
  passId = cp.pass?.id; ok(!!passId, `發定期票 ${passId}`);
  const curEnd = dayjs().add(5, 'day').format('YYYY-MM-DD');
  await put(`/passes/${passId}`, { endDate: curEnd }, TOK);
  const expectedNewEnd = dayjs(curEnd).add(6, 'month').format('YYYY-MM-DD');
  ok(true, `票到期日設 ${curEnd}（續約後應為 ${expectedNewEnd}）`);

  // ── Test A：一次付清續約 ──
  console.log('\n── A 一次付清續約 ──');
  const qa = await post('/checkin/qr/create', { memberId: MEMBER, gymId: GYM, entryType: 'pass', passId, renewPassId: passId, renewPaymentPlan: 'full', paymentMethod: 'cash' }, TOK);
  ok(!!qa.qrToken, `qr/create（含 renewPassId）status=${qa._status}` + (qa._status !== 200 && qa._status !== 201 ? ` ${JSON.stringify(qa)}` : ''));
  if (qa.qrToken) {
    const sa = await post('/checkin/qr/scan', { qrToken: qa.qrToken }, TOK);
    ok(sa.renewal?.dueNow === 6840, `scan 續約應收 dueNow=${sa.renewal?.dueNow}（期望6840）`);
    ok(sa.renewal?.newEndDate === expectedNewEnd, `scan 新到期日=${sa.renewal?.newEndDate}（期望${expectedNewEnd}）`);
    ok(sa.totalAmount === 6840, `scan totalAmount=${sa.totalAmount}（期望6840，免費入場+續約）`);
    const ca = await post('/checkin/qr/confirm', { qrToken: qa.qrToken }, TOK);
    ok(ca.checkIn?.id, `confirm status=${ca._status}`);
    if (ca.checkIn?.id) cancels.push(ca.checkIn.id);
    const pAfter = (await get(`/passes/member/${MEMBER}`, TOK)).passes?.find(x => x.id === passId);
    ok(pAfter?.endDate === expectedNewEnd, `confirm 後票期延長=${pAfter?.endDate}（期望${expectedNewEnd}）`);
    ok(ca.checkIn?.renewalAmount === 6840, `checkIn.renewalAmount=${ca.checkIn?.renewalAmount}（期望6840）`);
    // 取消 → 票期還原
    const xa = await post('/checkin/cancel', { checkInId: ca.checkIn.id }, TOK);
    ok(xa._status === 200, `cancel status=${xa._status}`);
    const pRev = (await get(`/passes/member/${MEMBER}`, TOK)).passes?.find(x => x.id === passId);
    ok(pRev?.endDate === curEnd, `cancel 後票期還原=${pRev?.endDate}（期望${curEnd}）`);
    if (xa._status === 200) cancels.pop();
  }

  // ── Test B：分期續約（折扣集中最後一期）──
  console.log('\n── B 分期續約（3期，折扣集中末期）──');
  const qb = await post('/checkin/qr/create', { memberId: MEMBER, gymId: GYM, entryType: 'pass', passId, renewPassId: passId, renewPaymentPlan: 'installment', paymentMethod: 'cash' }, TOK);
  ok(!!qb.qrToken, `qr/create（分期）status=${qb._status}`);
  if (qb.qrToken) {
    const sb = await post('/checkin/qr/scan', { qrToken: qb.qrToken }, TOK);
    ok(sb.renewal?.plan === 'installment' && sb.renewal?.dueNow === 3040, `scan 分期首期 dueNow=${sb.renewal?.dueNow}（期望3040）`);
    const cb = await post('/checkin/qr/confirm', { qrToken: qb.qrToken }, TOK);
    ok(cb.checkIn?.id, `confirm status=${cb._status}`);
    if (cb.checkIn?.id) cancels.push(cb.checkIn.id);
    ok(cb.checkIn?.renewalPlanId, `checkIn 帶 renewalPlanId=${cb.checkIn?.renewalPlanId}`);
    const plans = (await get(`/installments/member/${MEMBER}`, TOK)).plans || [];
    const plan = plans.find(x => x.id === cb.checkIn?.renewalPlanId);
    const amts = (plan?.installments || plan?.periods || []).map(x => x.amount);
    ok(JSON.stringify(amts) === JSON.stringify([3040, 3040, 760]), `分期各期=${JSON.stringify(amts)}（期望[3040,3040,760]，折扣760集中末期）`);
    const pB = (await get(`/passes/member/${MEMBER}`, TOK)).passes?.find(x => x.id === passId);
    ok(pB?.endDate === expectedNewEnd, `分期續約後票期延長=${pB?.endDate}`);
    // 取消 → 票期還原 + 計畫作廢
    const xb = await post('/checkin/cancel', { checkInId: cb.checkIn.id }, TOK);
    ok(xb._status === 200, `cancel status=${xb._status}`);
    const pBrev = (await get(`/passes/member/${MEMBER}`, TOK)).passes?.find(x => x.id === passId);
    ok(pBrev?.endDate === curEnd, `cancel 後票期還原=${pBrev?.endDate}`);
    if (xb._status === 200) cancels.pop();
  }

  // ── Test C：未到續約窗（到期>14天）擋下 ──
  console.log('\n── C 未到續約窗擋下 ──');
  await put(`/passes/${passId}`, { endDate: dayjs().add(30, 'day').format('YYYY-MM-DD') }, TOK);
  const qc = await post('/checkin/qr/create', { memberId: MEMBER, gymId: GYM, entryType: 'pass', passId, renewPassId: passId, renewPaymentPlan: 'full', paymentMethod: 'cash' }, TOK);
  ok(qc._status === 400 && qc.code === 'RENEW_NOT_OPEN', `到期30天 renewPassId → ${qc.code}（期望 RENEW_NOT_OPEN）`);
} finally {
  console.log('\n── 清理 ──');
  for (const id of cancels) { const r = await post('/checkin/cancel', { checkInId: id, force: true }, TOK); console.log(`  cancel ${id}: ${r._status}`); }
  if (passId) console.log(`  del pass: ${(await del(`/passes/${passId}`, TOK))._status}`);
  if (typeId) console.log(`  del type: ${(await del(`/passes/types/${typeId}`, TOK))._status}`);
}
console.log(`\n===== ${P} 綠 / ${F} 紅 =====`);
process.exit(F ? 1 : 0);
