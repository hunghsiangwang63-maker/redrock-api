const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

// ── GET /pending-tasks - 彙整所有待處理事項 ──────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);

    const tasks = [];

    // 轉帳確認單一來源：凡有「待確認 transferRecords」的訂單，一律由轉帳確認段處理，
    // 其各自待辦任務(租借/比賽/體驗…)以 refId 排除，避免雙列。
    const transferRefIds = new Set();
    try {
      const trSnap = await db.collection('transferRecords').where('status', '==', 'pending').get();
      trSnap.forEach(d => { const r = d.data(); if (r.refId) transferRefIds.add(r.refId); });
    } catch(e) {}

    // 1. 器材租借 - 待確認
    try {
      let ref = db.collection('equipmentRentals').where('status', '==', 'pending');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      snap.forEach(d => {
        const r = d.data();
        if (transferRefIds.has(d.id)) return; // 已有轉帳待確認 → 走轉帳確認段
        tasks.push({
          id: `rental_${d.id}`, type: 'rental', targetId: d.id,
          title: `器材租借申請`,
          desc: `${r.memberName} — ${r.items?.map(i=>`${i.name}×${i.quantity}`).join('、')} (${r.rentalType==='weekend'?'週末':'七天'})`,
          date: r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.createdAt?._seconds || 0,
          gymId: r.gymId, memberName: r.memberName,
          link: '/staff/rentals',
          record: { id: d.id, ...r },
        });
      });
    } catch(e) {}

    // 2. 課程退費/暫停申請
    try {
      const snap = await db.collection('courseAdjustmentRequests').where('status', '==', 'pending').get();
      snap.forEach(d => {
        const r = d.data();
        if (gymId && r.gymId && r.gymId !== gymId) return;
        tasks.push({
          id: `courseAdj_${d.id}`, type: 'course_adjustment', targetId: d.id,
          title: r.type === 'refund' ? '課程退費申請' : '課程暫停申請',
          desc: `${r.memberName} — ${r.courseName || ''}`,
          date: r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.createdAt?._seconds || 0,
          gymId: r.gymId, memberName: r.memberName,
          link: '/staff/passes?tab=courseRequests',
          record: { id: d.id, ...r },
        });
      });
    } catch(e) {}

    // 3. 票券展延/退費申請
    try {
      const snap = await db.collection('passRequests').where('status', '==', 'pending').get();
      snap.forEach(d => {
        const r = d.data();
        if (gymId && r.gymId && r.gymId !== gymId) return;
        tasks.push({
          id: `passAdj_${d.id}`, type: 'pass_adjustment', targetId: d.id,
          title: r.type === 'extension' ? '定期票展延申請'
               : r.type === 'refund' ? '定期票退費申請'
               : r.type === 'transfer' ? '票券轉讓申請'
               : r.type === 'course_practice_deferral' ? '課程練習期遞延申請' : '票券調整申請',
          desc: `${r.memberName} — ${r.reasonLabel || r.reason || ''}`,
          date: r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.createdAt?._seconds || 0,
          gymId: r.gymId, memberName: r.memberName,
          link: '/staff/pending-tasks',
          record: { id: d.id, ...r },
        });
      });
    } catch(e) {}

    // 4. 比賽報名待收款
    try {
      const snap = await db.collection('competitionRegistrations')
        .where('paymentStatus', '==', 'pending')
        .where('status', '==', 'confirmed').get();
      snap.forEach(d => {
        const r = d.data();
        if (transferRefIds.has(d.id)) return; // 已有轉帳待確認 → 走轉帳確認段
        tasks.push({
          id: `compReg_${d.id}`, type: 'competition_payment', targetId: d.id,
          title: '比賽報名待收款',
          desc: `${r.memberName} — ${r.competitionName || ''} NT$${r.registrationFee || ''}`,
          date: r.registeredAt?._seconds ? new Date(r.registeredAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.registeredAt?._seconds || 0,
          gymId: null, memberName: r.memberName,
          link: '/staff/competitions',
          record: { id: d.id, ...r },
        });
      });
    } catch(e) {}

    // 5. 攀岩隊申請待確認
    try {
      const snap = await db.collection('teamMembers').where('status', '==', 'pending').get();
      snap.forEach(d => {
        const r = d.data();
        if (transferRefIds.has(d.id)) return; // 已有轉帳待確認 → 走轉帳確認段
        tasks.push({
          id: `team_${d.id}`, type: 'team_member', targetId: d.id,
          title: '攀岩隊入隊申請',
          desc: `${r.memberName} — NT$${r.paymentAmount || ''} 待確認付款`,
          date: r.appliedAt?._seconds ? new Date(r.appliedAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.appliedAt?._seconds || 0,
          gymId: null, memberName: r.memberName,
          link: '/staff/team',
        });
      });
    } catch(e) {}

    // 6. 器材租借今日取件/今日歸還
    try {
      let ref2 = db.collection('equipmentRentals').where('status', '==', 'confirmed');
      if (gymId) ref2 = ref2.where('gymId', '==', gymId);
      const snap2 = await ref2.get();
      snap2.forEach(d => {
        const r = d.data();
        // 從訂單確認起一直顯示到取件日（含當日）
        if (r.pickupDate && r.pickupDate >= today) {
          tasks.push({
            id: `rental_pickup_${d.id}`, type: 'rental_pickup', targetId: d.id,
            title: r.pickupDate === today ? '器材今日取件' : '器材待取件',
            desc: `${r.memberName} — ${r.items?.map(i=>`${i.name}×${i.quantity}`).join('、')} · 取件 ${r.pickupDate}`,
            date: r.pickupDate, createdAt: Date.now()/1000,
            gymId: r.gymId, memberName: r.memberName,
            link: '/staff/rentals',
          });
        }
      });
    } catch(e) {}

    try {
      let ref3 = db.collection('equipmentRentals').where('status', '==', 'active');
      if (gymId) ref3 = ref3.where('gymId', '==', gymId);
      const snap3 = await ref3.get();
      snap3.forEach(d => {
        const r = d.data();
        // 從取件後一直顯示到歸還日（含當日）
        if (r.returnDate && r.returnDate >= today) {
          tasks.push({
            id: `rental_return_${d.id}`, type: 'rental_return', targetId: d.id,
            title: r.returnDate === today ? '器材今日歸還' : '器材待歸還',
            desc: `${r.memberName} — ${r.items?.map(i=>`${i.name}×${i.quantity}`).join('、')} · 歸還 ${r.returnDate}`,
            date: r.returnDate, createdAt: Date.now()/1000,
            gymId: r.gymId, memberName: r.memberName,
            link: '/staff/rentals',
            record: { id: d.id, ...r },
          });
        }
      });
    } catch(e) {}

    // 7. 體驗課程預約：待確認 + 已確認，從預約起一直顯示到體驗日（含當日）
    try {
      let ref = gymId ? db.collection('experienceBookings').where('gymId', '==', gymId) : db.collection('experienceBookings');
      const snap = await ref.get();
      snap.forEach(d => {
        const r = d.data();
        if (transferRefIds.has(d.id)) return; // 已有轉帳待確認 → 走轉帳確認段，避免雙列
        if (!['pending', 'confirmed'].includes(r.status)) return; // 只顯示待確認/已確認
        if (r.bookingDate && r.bookingDate < today) return;        // 過了體驗日不再顯示
        const confirmed = r.status === 'confirmed';
        tasks.push({
          id: `exp_${d.id}`, type: 'experience', targetId: d.id,
          title: confirmed ? '體驗預約（已確認）' : '體驗課程預約申請',
          desc: `${r.contactName} — ${r.bookingDate} ${r.bookingTime || ''} · ${r.numParticipants}人 NT$${r.totalFee}`,
          date: r.bookingDate || (r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toISOString().slice(0,10) : today),
          createdAt: r.createdAt?._seconds || 0,
          gymId: r.gymId, memberName: r.contactName,
          confirmed,
          link: '/staff/experience',
          record: { id: d.id, ...r },
        });
      });
    } catch(e) {}

    // 排序：同一天內最新在前
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    // 8+9. 轉帳待確認統一改由 transferRecords 處理（見下方 9b）；
    //      舊的 courseEnrollments(transfer_payment) / experienceBookings(experience_transfer) 區塊已移除。

    // 9b. 轉帳待確認（transferRecords：截圖或填末五碼皆可，單一來源）
    try {
      let ref = db.collection('transferRecords').where('status', '==', 'pending');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      snap.docs.forEach(d => {
        const t = d.data();
        tasks.push({
          id: `transfer_${d.id}`, type: 'transfer_confirm', targetId: d.id,
          title: '轉帳待確認收款',
          desc: `${t.memberName || ''} — ${t.orderName || t.courseName || ''}${t.bankLastFive ? `（末五碼 ${t.bankLastFive}）` : ''}`,
          date: t.paymentDate || (t.createdAt?._seconds ? new Date(t.createdAt._seconds*1000).toISOString().slice(0,10) : today),
          createdAt: t.createdAt?._seconds || 0,
          gymId: t.gymId, memberName: t.memberName, amount: t.amount,
          link: '/staff/pending-tasks',
          record: { id: d.id, ...t },
        });
      });
    } catch(e) { console.error('transfer_confirm tasks error:', e.message); }

    // 10. 單次入場券待審核（票券審核）
    try {
      let ref = db.collection('singleEntryTickets').where('status', '==', 'pending_approval');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      snap.forEach(d => {
        const t = d.data();
        tasks.push({
          id: `ticket_${d.id}`, type: 'ticket_approval', targetId: d.id,
          title: '單次入場券待審核',
          desc: `${t.memberName || ''}${t.amount ? ` — NT$${t.amount}` : ''}`,
          date: t.issuedAt?._seconds ? new Date(t.issuedAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: t.createdAt?._seconds || t.issuedAt?._seconds || 0,
          gymId: t.gymId, memberName: t.memberName,
          link: '/staff/passes?tab=tickets',
        });
      });
    } catch(e) {}

    // 最終排序（最新在前）
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    // ── 新報名通知（近 7 天，分項：課程 / 比賽 / 體驗；資訊性，不計入待辦 badge）──
    const sevenDaysAgo = new Date(Date.now() - 7*86400000);
    const registrations = [];
    const secOf = ts => ts?._seconds || (ts?.toDate ? Math.floor(ts.toDate().getTime()/1000) : 0);
    const dayOf = ts => { const s = secOf(ts); return s ? new Date(s*1000 + 8*3600000).toISOString().slice(0,10) : today; };
    // 課程（依會員+課程去重，週課多堂只算一筆）
    try {
      const snap = await db.collection('courseEnrollments').where('createdAt', '>=', sevenDaysAgo).get();
      const seen = new Set();
      snap.docs.forEach(d => {
        const e = d.data();
        if (!['confirmed','waitlist'].includes(e.status) || e.isMakeup) return;
        if (gymId && e.gymId && e.gymId !== gymId) return;
        const key = `${e.memberId}_${e.courseId}`;
        if (seen.has(key)) return; seen.add(key);
        registrations.push({ id:`reg_course_${d.id}`, regType:'course', memberName:e.memberName||'', name:e.courseName||'', detail:e.date||'', createdAt: secOf(e.createdAt), dateStr: dayOf(e.createdAt), gymId:e.gymId, link:'/staff/courses' });
      });
    } catch(e) {}
    // 比賽
    try {
      const snap = await db.collection('competitionRegistrations').where('registeredAt', '>=', sevenDaysAgo).get();
      snap.docs.forEach(d => {
        const r = d.data();
        if (!['confirmed','waitlist'].includes(r.status)) return;
        registrations.push({ id:`reg_comp_${d.id}`, regType:'competition', memberName:r.memberName||'', name:r.competitionName||'', detail:r.divisionName||'', createdAt: secOf(r.registeredAt), dateStr: dayOf(r.registeredAt), gymId:null, link:'/staff/competitions' });
      });
    } catch(e) {}
    // 體驗
    try {
      const snap = await db.collection('experienceBookings').where('createdAt', '>=', sevenDaysAgo).get();
      snap.docs.forEach(d => {
        const b = d.data();
        if (gymId && b.gymId && b.gymId !== gymId) return;
        registrations.push({ id:`reg_exp_${d.id}`, regType:'experience', memberName:b.contactName||'', name:b.courseType||'體驗課程', detail:`${b.bookingDate||''}${b.numParticipants?` · ${b.numParticipants}人`:''}`.trim(), createdAt: secOf(b.createdAt), dateStr: dayOf(b.createdAt), gymId:b.gymId, link:'/staff/experience' });
      });
    } catch(e) {}
    registrations.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ tasks, total: tasks.length, registrations, registrationCount: registrations.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
