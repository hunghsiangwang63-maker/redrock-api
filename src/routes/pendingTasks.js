const { taiwanToday } = require('../utils/taiwanDate');
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
    const today = taiwanToday();

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
          link: '/staff/pending-tasks',   // 審核走本頁「審核」鈕開 CourseAdjustmentReviewModal，此連結僅比照 pass_adjustment 停留原頁（無「票券頁 courseRequests」分頁，舊連結為死連結）
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

    // 比賽退費待處理（會員取消報名且已收過款 → 需人工匯退款；員工按「退費已處理」後消失）
    try {
      const snap = await db.collection('competitionRegistrations')
        .where('refundRequested', '==', true).get();
      snap.forEach(d => {
        const r = d.data();
        if (r.status !== 'cancelled' || r.paymentStatus !== 'confirmed') return; // 未收款取消不需退；已退費(refunded)自然排除
        tasks.push({
          id: `compRefund_${d.id}`, type: 'competition_refund', targetId: d.id,
          title: '比賽退費待處理',
          desc: `${r.memberName} — ${r.competitionName || ''}（已收 NT$${r.paidAmount || r.registrationFee || ''}；退費帳號 ${r.refundBankCode || ''}-${r.refundAccount || ''}）`,
          date: r.cancelledAt?._seconds ? new Date(r.cancelledAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: r.cancelledAt?._seconds || 0,
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
          link: '/staff/vip',
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
        const ticketsIssued = r.ticketsIssued || 0;
        // 單一參加者且與聯絡人不同（家長代子女/他人報名）→ 顯示真正參加者名，避免只看到代訂的聯絡人名字
        const singleParticipant = (r.participants || []).length === 1 ? r.participants[0]?.name : null;
        const displayName = singleParticipant && singleParticipant !== r.contactName
          ? `${singleParticipant}（${r.contactName}代訂）` : r.contactName;
        tasks.push({
          id: `exp_${d.id}`, type: 'experience', targetId: d.id,
          title: confirmed
            ? (ticketsIssued > 0 ? '體驗預約（已確認）（已發放入場券）' : '體驗預約（已確認）')
            : '體驗課程預約申請',
          desc: `${displayName} — ${r.bookingDate} ${r.bookingTime || ''} · ${r.numParticipants}人 NT$${r.totalFee}`,
          date: r.bookingDate || (r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toISOString().slice(0,10) : today),
          createdAt: r.createdAt?._seconds || 0,
          gymId: r.gymId, memberName: displayName,
          confirmed, ticketsIssued,
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
    //     連動訂單已取消（駁回/取消/退費）者不列入待收款——避免作廢報名的轉帳單殘留在待辦。
    try {
      const ORDER_COLL = { course:'courseEnrollments', experience:'experienceBookings', competition:'competitionRegistrations', rental:'equipmentRentals', team_member:'teamApplications' };
      let ref = db.collection('transferRecords').where('status', '==', 'pending');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      for (const d of snap.docs) {
        const t = d.data();
        let orderDoc = null;
        if (t.orderType && t.refId && ORDER_COLL[t.orderType]) {
          try {
            orderDoc = (await db.collection(ORDER_COLL[t.orderType]).doc(t.refId).get()).data();
            if (orderDoc && (orderDoc.status === 'cancelled' || orderDoc.paymentStatus === 'refunded')) continue; // 訂單已取消/退費 → 跳過
          } catch (e) {}
        }
        const isCash = t.paymentMethod === 'cash';
        // transferRecords.memberName 因防偽造安全機制固定是登入會員本人（付款人／家長）——
        // 家長代子女報名時實際報名對象是子女，顯示應以訂單文件（orderDoc）自己的 memberName 為準
        // （courseEnrollments/competitionRegistrations/equipmentRentals/teamApplications 皆已改為優先存報名對象本人姓名）。
        const displayMemberName = orderDoc?.memberName || t.memberName;
        // 比賽報名有申請友館優惠 → 直接帶出選了哪個友館，待辦列表/確認彈窗都能一眼看到，不用另外點進報名詳情
        const partnerGym = (t.orderType === 'competition' && orderDoc?.isPartnerGymDiscount) ? (orderDoc.partnerGym || '友館') : null;
        const partnerGymPending = partnerGym ? !!orderDoc.partnerGymPending : false;
        // 會員自己填寫的備註——各訂單型別欄位名不同，非 transferRecords 本身的欄位，須從 orderDoc 取：
        // course→enrollNote/healthNote/referralSource（合併顯示）、experience→notes、competition→memberNote、
        // rental/team_member 目前無會員自填備註欄位。
        let memberWrittenNote = null;
        if (orderDoc) {
          if (t.orderType === 'course') {
            memberWrittenNote = [
              orderDoc.enrollNote ? `備註：${orderDoc.enrollNote}` : null,
              orderDoc.healthNote ? `健康備註：${orderDoc.healthNote}` : null,
              orderDoc.referralSource ? `如何得知：${orderDoc.referralSource}` : null,
            ].filter(Boolean).join('｜') || null;
          } else if (t.orderType === 'experience') {
            memberWrittenNote = orderDoc.notes || null;
          } else if (t.orderType === 'competition') {
            memberWrittenNote = orderDoc.memberNote || null;
          }
        }
        tasks.push({
          id: `transfer_${d.id}`, type: 'transfer_confirm', targetId: d.id,
          title: isCash ? '現金待收款' : '轉帳待確認收款',
          method: t.paymentMethod || 'transfer',   // cash→值班確認；transfer→管理員確認
          desc: `${displayMemberName || ''} — ${t.orderName || t.courseName || ''}${t.bankLastFive ? `（末五碼 ${t.bankLastFive}）` : ''}`,
          date: t.paymentDate || (t.createdAt?._seconds ? new Date(t.createdAt._seconds*1000).toISOString().slice(0,10) : today),
          createdAt: t.createdAt?._seconds || 0,
          gymId: t.gymId, memberName: displayMemberName, amount: t.amount,
          partnerGym, partnerGymPending,
          link: '/staff/pending-tasks',
          record: { id: d.id, ...t, memberName: displayMemberName, payerName: t.memberName, partnerGym, partnerGymPending, notes: memberWrittenNote },
        });
      }
    } catch(e) { console.error('transfer_confirm tasks error:', e.message); }

    // 10. 單次入場券待審核（票券審核）——同一批次（batchId，一次發放多張）合併成一筆待辦，
    // 避免一次發 12 張灌爆待辦清單；批次以 batchId 當 targetId，前端據此走批次審核/拒絕端點。
    try {
      let ref = db.collection('singleEntryTickets').where('status', '==', 'pending_approval');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      const singles = [];
      const batches = new Map();
      snap.forEach(d => {
        const t = { id: d.id, ...d.data() };
        if (t.batchId) {
          if (!batches.has(t.batchId)) batches.set(t.batchId, []);
          batches.get(t.batchId).push(t);
        } else {
          singles.push(t);
        }
      });
      singles.forEach(t => {
        tasks.push({
          id: `ticket_${t.id}`, type: 'ticket_approval', targetId: t.id,
          title: '單次入場券待審核',
          desc: `${t.memberName || ''}${t.soldByStaffName ? `（${t.soldByStaffName} 發放）` : ''}`,
          date: t.issuedAt?._seconds ? new Date(t.issuedAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: t.createdAt?._seconds || t.issuedAt?._seconds || 0,
          gymId: t.gymId, memberName: t.memberName,
          link: '/staff/passes?tab=tickets',
          record: { ...t, id: t.id },
        });
      });
      batches.forEach((list, batchId) => {
        const first = list[0];
        tasks.push({
          id: `ticket_batch_${batchId}`, type: 'ticket_approval', targetId: batchId,
          title: `單次入場券待審核（×${list.length}）`,
          desc: `${first.memberName || ''} — 共 ${list.length} 張${first.soldByStaffName ? `（${first.soldByStaffName} 發放）` : ''}`,
          date: first.issuedAt?._seconds ? new Date(first.issuedAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: first.createdAt?._seconds || first.issuedAt?._seconds || 0,
          gymId: first.gymId, memberName: first.memberName,
          link: '/staff/passes?tab=tickets',
          record: { ...first, id: first.id, isBatch: true, batchId, quantity: list.length, ticketIds: list.map(x => x.id) },
        });
      });
    } catch(e) {}

    // 11. 墜落測驗排測 - 待安排（會員自助排測 → 站台現場測驗）
    try {
      let ref = db.collection('fallTestBookings').where('status', '==', 'pending');
      if (gymId) ref = ref.where('gymId', '==', gymId);
      const snap = await ref.get();
      snap.forEach(d => {
        const b = d.data();
        tasks.push({
          id: `falltest_${d.id}`, type: 'fall_test_pending', targetId: d.id,
          title: '墜落測驗待安排',
          desc: `${b.memberName || ''}`,
          date: b.createdAt?._seconds ? new Date(b.createdAt._seconds*1000).toISOString().slice(0,10) : today,
          createdAt: b.createdAt?._seconds || 0,
          gymId: b.gymId, memberName: b.memberName, memberId: b.memberId,
          link: '/staff/pending-tasks',
          record: { id: d.id, ...b },
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
    // 課程（Phase 3：改讀 courseRegistrations header，一次報名天生一筆，不用再依查詢順序猜哪筆代表整組——
    // 原本直接查 courseEnrollments 用「查到的第一筆」判斷 _needsCollect，Firestore 未下 orderBy、
    // 順序不保證是扛費用的那筆，理論上可能誤判成「不用收款」而漏進待辦。header 一筆一組，無此疑慮。）
    try {
      const snap = await db.collection('courseRegistrations').where('createdAt', '>=', sevenDaysAgo).get();
      snap.docs.forEach(d => {
        const h = d.data();
        if (!['confirmed','waitlist'].includes(h.status)) return;
        if (gymId && h.gymId && h.gymId !== gymId) return;
        // 查看導向：待收款中→待辦頁；已確認/免費（後台處理、名單帶入）→ 課程頁看名單
        const _needsCollect = (h.fee || 0) > 0 && h.paymentStatus !== 'confirmed';
        registrations.push({ id:`reg_course_${d.id}`, regType:'course', memberName:h.memberName||'', name:h.courseName||'', detail: h.sessionCount ? `共${h.sessionCount}堂` : '', createdAt: secOf(h.createdAt), dateStr: dayOf(h.createdAt), gymId:h.gymId, link: _needsCollect ? '/staff/pending-tasks' : (h.courseId ? `/staff/courses?course=${h.courseId}` : '/staff/courses') });
      });
    } catch(e) {}
    // 比賽
    try {
      const snap = await db.collection('competitionRegistrations').where('registeredAt', '>=', sevenDaysAgo).get();
      snap.docs.forEach(d => {
        const r = d.data();
        if (!['confirmed','waitlist'].includes(r.status)) return;
        registrations.push({ id:`reg_comp_${d.id}`, regType:'competition', memberName:r.memberName||'', name:r.competitionName||'', detail:r.divisionName||'', createdAt: secOf(r.registeredAt), dateStr: dayOf(r.registeredAt), gymId:null, link: r.competitionId ? `/staff/competitions?comp=${r.competitionId}` : '/staff/competitions' });
      });
    } catch(e) {}
    // 體驗
    try {
      const snap = await db.collection('experienceBookings').where('createdAt', '>=', sevenDaysAgo).get();
      snap.docs.forEach(d => {
        const b = d.data();
        if (gymId && b.gymId && b.gymId !== gymId) return;
        const singleParticipant = (b.participants || []).length === 1 ? b.participants[0]?.name : null;
        const displayName = singleParticipant && singleParticipant !== b.contactName
          ? `${singleParticipant}（${b.contactName}代訂）` : (b.contactName || '');
        registrations.push({ id:`reg_exp_${d.id}`, regType:'experience', memberName:displayName, name:b.courseName || b.courseType||'體驗課程', detail:`${b.bookingDate||''}${b.numParticipants?` · ${b.numParticipants}人`:''}`.trim(), createdAt: secOf(b.createdAt), dateStr: dayOf(b.createdAt), gymId:b.gymId, link:`/staff/experience?booking=${d.id}` });
      });
    } catch(e) {}
    registrations.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ tasks, total: tasks.length, registrations, registrationCount: registrations.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /pending-tasks/returned - 退回追蹤：管理者/值班退回的申請或繳費，追蹤到結案 ──
// 結案＝已確認收款(paymentStatus=confirmed) 或 已取消(status=cancelled) → 不再列出。
// 子狀態：待會員補正(仍 transfer_rejected 或 formReturned) / 已補正待確認(補正後回 pending/pending_confirm)。
router.get('/returned', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
    const SRC = [
      { coll: 'courseEnrollments',        type: 'course',      label: '課程報名',   name: o => o.courseName },
      { coll: 'experienceBookings',       type: 'experience',  label: '體驗預約',   name: o => o.courseName || o.courseType },
      { coll: 'competitionRegistrations', type: 'competition', label: '比賽報名',   name: o => o.competitionName },
      { coll: 'equipmentRentals',         type: 'rental',      label: '裝備租借',   name: o => o.itemName || o.equipmentName },
      { coll: 'teamApplications',         type: 'team_member', label: '入隊申請',   name: o => `${o.year || ''} 年度攀岩隊` },
    ];
    const secOf = ts => ts?._seconds || (ts?.toDate ? Math.floor(ts.toDate().getTime() / 1000) : 0);
    const items = [];
    for (const s of SRC) {
      // 聯集：目前 transfer_rejected（繳費退回·含改版前無旗標者）＋ wasReturned（補正後仍追蹤）＋ formReturned（報名表退回）
      const docMap = new Map();
      const qs = [
        db.collection(s.coll).where('paymentStatus', '==', 'transfer_rejected'),
        db.collection(s.coll).where('wasReturned', '==', true),
      ];
      if (s.type === 'competition') qs.push(db.collection(s.coll).where('formReturned', '==', true));
      for (const q of qs) {
        try { const snap = await q.get(); snap.docs.forEach(d => docMap.set(d.id, d)); } catch (e) {}
      }
      docMap.forEach(d => {
        const o = d.data();
        if (gymId && o.gymId && o.gymId !== gymId) return;
        const rt = o.lastReturnType || (o.formReturned ? 'form' : 'payment');
        // 結案（不列）：取消一律結案；報名表退回→formReturned 清除即結案；繳費退回→已確認收款即結案
        const closed = o.status === 'cancelled'
          || (rt === 'form' ? !o.formReturned : o.paymentStatus === 'confirmed');
        if (closed) return;
        // 子狀態：報名表退回只有「待會員補正」；繳費退回 transfer_rejected=待補正、否則已補正待確認
        const stillReturned = rt === 'form' ? o.formReturned === true : o.paymentStatus === 'transfer_rejected';
        items.push({
          orderType: s.type, orderId: d.id, label: s.label,
          orderName: s.name(o) || s.label,
          memberId: o.memberId || null,
          memberName: o.memberName || o.contactName || '',
          returnType: rt, // payment=繳費退回 / form=報名表退回
          reason: o.lastReturnReason || o.paymentRejectReason || o.formReturnReason || '',
          returnByName: o.lastReturnByName || '',
          returnAtSec: secOf(o.lastReturnAt) || secOf(o.paymentRejectedAt) || secOf(o.formReturnedAt) || 0,
          subStatus: stillReturned ? 'awaiting_member' : 'resubmitted',   // 待會員補正 / 已補正待確認
          gymId: o.gymId || null,
          // 會員填寫資料（供核對）
          memberData: {
            bankLastFive: o.bankLastFive || null, bankName: o.bankName || null, paymentDate: o.paymentDate || null,
            paymentMethod: o.paymentMethod || null, amount: o.registrationFee || o.amount || o.enrollmentFee || null,
            divisionName: o.divisionName || null, gender: o.gender || null, phone: o.phone || null, email: o.email || null,
            idNumber: o.idNumber || null, emergencyContact: o.emergencyContact || null, emergencyPhone: o.emergencyPhone || null,
          },
        });
      });
    }
    items.sort((a, b) => (b.returnAtSec || 0) - (a.returnAtSec || 0));
    res.json({ items, total: items.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
