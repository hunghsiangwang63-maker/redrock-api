const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny, checkPermission, requireManagerOrStation } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const XLSX = require('xlsx');
const teamMemberService = require('../services/teamMemberService');

// ── GET /team/fees - 取得目前年費設定（會員可讀） ──
router.get('/fees', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('teamFees').get();
    const fees = doc.exists ? doc.data() : {
      fullYearFee: 3000, midYearFee: 2000, lateYearFee: 1000,
      midYearCutoff: '03-15', lateYearCutoff: '09-15', jerseyDiscount: 300,
    };
    const todayMMDD = dayjs().format('MM-DD');
    let currentFee = fees.fullYearFee;
    let feeLabel = `全年隊費（NT$${fees.fullYearFee}）`;
    if (todayMMDD >= fees.lateYearCutoff) {
      currentFee = fees.lateYearFee;
      feeLabel = `${fees.lateYearCutoff.replace('-','/')} 後加入（NT$${fees.lateYearFee}）`;
    } else if (todayMMDD >= fees.midYearCutoff) {
      currentFee = fees.midYearFee;
      feeLabel = `${fees.midYearCutoff.replace('-','/')} 後加入（NT$${fees.midYearFee}）`;
    }
    res.json({ ...fees, currentFee, feeLabel });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /team/apply - 會員申請加入攀岩隊 ──
router.post('/apply', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.body.memberId;
    if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });

    const year = dayjs().year();

    // 檢查同年度是否已申請
    const existing = await db.collection('teamApplications')
      .where('memberId', '==', memberId).where('year', '==', year).limit(1).get();
    if (!existing.empty) return res.status(400).json({ code: 'ALREADY_APPLIED', message: `${year} 年度已申請過` });

    // 從設定取費用規則
    const feesDoc = await db.collection('systemSettings').doc('teamFees').get();
    const fees = feesDoc.exists ? feesDoc.data() : {
      fullYearFee: 3000, midYearFee: 2000, lateYearFee: 1000,
      midYearCutoff: '03-15', lateYearCutoff: '09-15', jerseyDiscount: 300,
    };
    const todayMMDD = dayjs().format('MM-DD');
    let expectedFee = fees.fullYearFee;
    if (todayMMDD >= fees.lateYearCutoff) expectedFee = fees.lateYearFee;
    else if (todayMMDD >= fees.midYearCutoff) expectedFee = fees.midYearFee;
    if (req.body.noJersey) expectedFee -= fees.jerseyDiscount;

    const {
      idNumber, address, primaryGym, lineId,
      joinReasons, trainingContent, wishActivities,
      currentGrade, weeklyFrequency,
      paymentAmount, paymentDate, bankLastFive,
      jerseySize, noJersey, otherSuggestions, agreedPrivacy,
    } = req.body;

    if (!agreedPrivacy) return res.status(400).json({ code: 'PRIVACY_NOT_AGREED', message: '請同意個資使用聲明' });
    if (!idNumber) return res.status(400).json({ code: 'MISSING_ID', message: '請填寫身分證字號' });

    const id = `team_${memberId}_${year}`;
    await db.collection('teamApplications').doc(id).set({
      id, memberId, year,
      memberName: req.member?.name || req.body.memberName || '',
      memberPhone: req.member?.phone || req.body.memberPhone || '',
      memberEmail: req.member?.email || req.body.memberEmail || '',
      memberGender: req.member?.gender || req.body.memberGender || '',
      memberBirthday: req.member?.birthday || req.body.memberBirthday || '',
      // 山協必填
      idNumber: idNumber || '',
      address: address || '',
      primaryGym: primaryGym || '',
      lineId: lineId || '',
      // 攀岩資訊
      joinReasons: joinReasons || [],
      trainingContent: trainingContent || '',
      wishActivities: wishActivities || '',
      currentGrade: currentGrade || '',
      weeklyFrequency: weeklyFrequency || '',
      // 付款
      paymentAmount: Number(paymentAmount) || 0,
      paymentDate: paymentDate || '',
      bankLastFive: bankLastFive || '',
      jerseySize: jerseySize || '',
      noJersey: !!noJersey,
      expectedFee,
      otherSuggestions: otherSuggestions || '',
      agreedPrivacy: true,
      // 狀態
      status: 'pending',      // pending | active | cancelled
      paymentStatus: 'pending', // pending | confirmed
      paidConfirmedBy: null,
      paidAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({ success: true, id, expectedFee, message: '申請已送出，請等待工作人員確認付款' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /team/members - 員工查看隊員名單（依年份） ──
router.get('/members', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const year = parseInt(req.query.year) || dayjs().year();
    const snap = await db.collection('teamApplications').where('year', '==', year).get();
    const members = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?._seconds||0) - (b.createdAt?._seconds||0));
    res.json({ members, year, total: members.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /team/my - 會員查自己的申請 ──
router.get('/my', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id;
    if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const snap = await db.collection('teamApplications').where('memberId', '==', memberId).get();
    const records = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => b.year - a.year);
    res.json({ records });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /team/applications/:id/confirm-payment - 確認收款 ──
router.post('/applications/:id/confirm-payment', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('teamApplications').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此攀岩隊入隊申請（可能已刪除）' });
    if (snap.data().paymentStatus === 'confirmed') return res.json({ success: true, message: '已確認收款' }); // 冪等
    await ref.update({
      paymentStatus: 'confirmed',
      status: 'active',
      paidAt: new Date(),
      paidConfirmedBy: req.staff.id,
      paidConfirmedByName: req.staff.name,
      updatedAt: new Date(),
    });
    // 開通會員實際折扣資格（依年度）
    const app = (await ref.get()).data();
    if (app?.memberId) {
      await teamMemberService.setTeamMember({
        memberId: app.memberId,
        since: `${app.year}-01-01`,
        until: `${app.year}-12-31`,
        staffId: req.staff.id,
      });
    }
    res.json({ success: true, message: '已確認收款，隊員資格已開通' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /team/members - 管理員手動新增隊員 ──
router.post('/members', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { memberId, paymentAmount, jerseySize, noJersey, status, primaryGym } = req.body;
    if (!memberId) return res.status(400).json({ code: 'MISSING_MEMBER', message: '請選擇會員' });
    const memberDoc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
    if (!memberDoc.exists) return res.status(404).json({ code: 'MEMBER_NOT_FOUND', message: '查無此會員' });
    const m = memberDoc.data();
    const year = parseInt(req.body.year) || dayjs().year();
    const id = `team_${memberId}_${year}`;
    const existing = await db.collection('teamApplications').doc(id).get();
    if (existing.exists) return res.status(400).json({ code: 'ALREADY_EXISTS', message: `${m.name} ${year} 年度已在名單中` });

    const finalStatus = status === 'pending' ? 'pending' : 'active';
    const paid = finalStatus === 'active';
    await db.collection('teamApplications').doc(id).set({
      id, memberId, year,
      memberName: m.name || '', memberPhone: m.phone || '', memberEmail: m.email || '',
      memberGender: m.gender || '', memberBirthday: m.birthday || '',
      primaryGym: primaryGym || '',
      paymentAmount: Number(paymentAmount) || 0,
      expectedFee: Number(paymentAmount) || 0,
      jerseySize: jerseySize || '', noJersey: !!noJersey,
      status: finalStatus,
      paymentStatus: paid ? 'confirmed' : 'pending',
      paidConfirmedBy: paid ? req.staff.id : null,
      paidConfirmedByName: paid ? req.staff.name : null,
      paidAt: paid ? new Date() : null,
      addedManuallyBy: req.staff.id,
      createdAt: new Date(), updatedAt: new Date(),
    });
    if (paid) {
      await teamMemberService.setTeamMember({ memberId, since: `${year}-01-01`, until: `${year}-12-31`, staffId: req.staff.id });
    }
    res.status(201).json({ success: true, message: `${m.name} 已加入 ${year} 年度隊員名單` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /team/applications/:id - 管理員編輯隊員資料 ──
router.put('/applications/:id', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('teamApplications').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const cur = snap.data();

    const allowed = ['memberName', 'memberPhone', 'primaryGym', 'paymentAmount', 'expectedFee', 'paymentDate', 'bankLastFive', 'jerseySize', 'noJersey', 'jerseyReceived', 'paymentStatus', 'status'];
    const updates = { updatedAt: new Date() };
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (updates.paymentAmount !== undefined) updates.paymentAmount = Number(updates.paymentAmount) || 0;
    if (updates.expectedFee !== undefined) updates.expectedFee = Number(updates.expectedFee) || 0;
    await ref.update(updates);

    // 同步折扣資格
    const finalStatus = updates.status || cur.status;
    if (cur.memberId) {
      if (finalStatus === 'active') {
        await teamMemberService.setTeamMember({ memberId: cur.memberId, since: `${cur.year}-01-01`, until: `${cur.year}-12-31`, staffId: req.staff.id });
      } else if (finalStatus === 'cancelled') {
        await teamMemberService.removeTeamMember({ memberId: cur.memberId, staffId: req.staff.id });
      }
    }
    res.json({ success: true, message: '已更新' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /team/applications/:id - 管理員刪除隊員 ──
router.delete('/applications/:id', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('teamApplications').doc(req.params.id);
    const snap = await ref.get();
    if (snap.exists && snap.data().memberId) {
      await teamMemberService.removeTeamMember({ memberId: snap.data().memberId, staffId: req.staff.id });
    }
    await ref.delete();
    res.json({ success: true, message: '已刪除' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /team/members/download - 下載名單 Excel(.xlsx) ──
router.get('/members/download', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const year = parseInt(req.query.year) || dayjs().year();
    const snap = await db.collection('teamApplications').where('year', '==', year).get();
    const rows = snap.docs.map(d => d.data())
      .sort((a, b) => (a.createdAt?._seconds||0) - (b.createdAt?._seconds||0));

    const data = rows.map((r, i) => ({
      '序號': i + 1,
      '姓名': r.memberName || '',
      '性別': r.memberGender || '',
      '生日': r.memberBirthday || '',
      '手機': r.memberPhone || '',
      'Email': r.memberEmail || '',
      '身分證字號': r.idNumber || '',
      '地址': r.address || '',
      'LineID': r.lineId || '',
      '主要岩館': r.primaryGym || '',
      '抱石最高級數': r.currentGrade || '',
      '每週頻率': r.weeklyFrequency || '',
      '加入原因': (r.joinReasons || []).join('、'),
      '應繳金額': r.expectedFee || '',
      '繳費金額': r.paymentAmount || '',
      '匯款日期': r.paymentDate || '',
      '匯款末五碼': r.bankLastFive || '',
      '隊服尺寸': r.noJersey ? '不拿隊服' : (r.jerseySize || ''),
      '付款狀態': r.paymentStatus === 'confirmed' ? '已確認' : '待確認',
      '隊員狀態': r.status === 'active' ? '正式隊員' : r.status === 'cancelled' ? '已退隊' : '待審核',
      '建議團練': r.trainingContent || '',
      '許願活動': r.wishActivities || '',
      '其他建議': r.otherSuggestions || '',
      '申請時間': r.createdAt?._seconds ? new Date(r.createdAt._seconds * 1000).toLocaleString('zh-TW') : '',
    }));

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.json_to_sheet(data));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${year}年度`);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="team_members_${year}.xlsx"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
