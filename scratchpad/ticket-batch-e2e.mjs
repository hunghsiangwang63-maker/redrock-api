import admin from 'firebase-admin';
import { readFileSync } from 'fs';

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA, 'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`  ${c ? '✅' : '❌'} ${m}`); };

const login = async () => (await (await fetch(`${API}/auth/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@redrock.app', password: 'redrock123' }) })).json()).token;

const call = async (method, path, token, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

(async () => {
  const token = await login();
  ok(!!token, 'super_admin login OK');

  const phone = '0900' + Math.floor(100000 + Math.random() * 899999);
  const memberRes = await call('POST', '/members', token, {
    name: '【E2E】票券批次測試', phone, gender: 'male', birthday: '1995-01-01',
    memberType: 'general', gymId: 'gym-hsinchu',
  });
  ok(memberRes.status === 201, `member created (${memberRes.status})`);
  const memberId = memberRes.data.member.id;

  // 發放 5 張
  const issueRes = await call('POST', '/passes/single-entry', token, { memberId, notes: 'E2E批次測試', quantity: 5 });
  ok(issueRes.status === 201, `issue quantity=5 (${issueRes.status}): ${issueRes.data.message}`);
  const tickets = issueRes.data.tickets || [];
  ok(tickets.length === 5, `returned 5 tickets, got ${tickets.length}`);
  const batchId = tickets[0]?.batchId;
  ok(!!batchId && tickets.every(t => t.batchId === batchId), 'all 5 tickets share same batchId');

  // pending-tasks 合併成一筆
  const tasksRes = await call('GET', `/pending-tasks`, token);
  const ticketTasks = (tasksRes.data.tasks || []).filter(t => t.type === 'ticket_approval' && t.record?.batchId === batchId);
  ok(ticketTasks.length === 1, `pending-tasks grouped into exactly 1 task, got ${ticketTasks.length}`);
  const task = ticketTasks[0];
  ok(task?.record?.quantity === 5, `task.record.quantity === 5, got ${task?.record?.quantity}`);
  ok(task?.record?.isBatch === true, 'task.record.isBatch === true');
  ok(task?.title?.includes('×5'), `task.title shows ×5: "${task?.title}"`);

  // quantity=1 預設，不應有 batchId
  const singleRes = await call('POST', '/passes/single-entry', token, { memberId, notes: 'E2E單張測試' });
  ok(singleRes.status === 201, `single issue (default qty) (${singleRes.status})`);
  ok(singleRes.data.tickets?.length === 1, 'single issue returns 1 ticket');
  ok(!singleRes.data.tickets?.[0]?.batchId, 'single ticket has no batchId');

  // quantity=13 應擋
  const overRes = await call('POST', '/passes/single-entry', token, { memberId, notes: 'E2E超量測試', quantity: 13 });
  ok(overRes.status === 400, `quantity=13 rejected (${overRes.status})`);

  // 批次核准
  const approveRes = await call('POST', `/passes/single-entry/batch/${batchId}/approve`, token);
  ok(approveRes.status === 200, `batch approve (${approveRes.status}): ${approveRes.data.message}`);
  ok(approveRes.data.approvedCount === 5, `approvedCount === 5, got ${approveRes.data.approvedCount}`);

  const snap = await db.collection('singleEntryTickets').where('batchId', '==', batchId).get();
  let activeCount = 0; snap.forEach(d => { if (d.data().status === 'active') activeCount++; });
  ok(activeCount === 5, `all 5 tickets now active in Firestore, got ${activeCount}`);

  // 批次拒絕
  const issueRes2 = await call('POST', '/passes/single-entry', token, { memberId, notes: 'E2E批次拒絕測試', quantity: 3 });
  const batchId2 = issueRes2.data.tickets?.[0]?.batchId;
  const rejectRes = await call('POST', `/passes/single-entry/batch/${batchId2}/reject`, token, { reason: 'E2E測試拒絕' });
  ok(rejectRes.status === 200, `batch reject (${rejectRes.status}): ${rejectRes.data.message}`);
  ok(rejectRes.data.rejectedCount === 3, `rejectedCount === 3, got ${rejectRes.data.rejectedCount}`);

  const snap2 = await db.collection('singleEntryTickets').where('batchId', '==', batchId2).get();
  let cancelledCount = 0; snap2.forEach(d => { if (d.data().status === 'cancelled') cancelledCount++; });
  ok(cancelledCount === 3, `all 3 tickets in batch2 now cancelled, got ${cancelledCount}`);

  // cleanup
  const allTicketsSnap = await db.collection('singleEntryTickets').where('memberId', '==', memberId).get();
  const batch = db.batch();
  allTicketsSnap.forEach(d => batch.delete(d.ref));
  await batch.commit();
  await db.collection('members').doc(memberId).delete();
  console.log(`  🧹 cleanup: deleted ${allTicketsSnap.size} tickets + 1 member`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(1); });
