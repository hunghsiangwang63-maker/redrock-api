const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny, checkPermission, requireManagerOrStation } = require('../middleware/auth');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');

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

    res.status(201).json({ success: true, expectedFee, message: '申請已送出，請等待工作人員確認付款' });
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
    await db.collection('teamApplications').doc(req.params.id).update({
      paymentStatus: 'confirmed',
      status: 'active',
      paidAt: new Date(),
      paidConfirmedBy: req.staff.id,
      paidConfirmedByName: req.staff.name,
      updatedAt: new Date(),
    });
    res.json({ success: true, message: '已確認收款，隊員狀態已啟用' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /team/members/download - 下載名單 CSV ──
router.get('/members/download', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const year = parseInt(req.query.year) || dayjs().year();
    const snap = await db.collection('teamApplications').where('year', '==', year).get();
    const rows = snap.docs.map(d => d.data())
      .sort((a, b) => (a.createdAt?._seconds||0) - (b.createdAt?._seconds||0));

    const headers = [
      '序號','姓名','性別','生日','手機','Email','身分證字號','地址','LineID',
      '主要岩館','抱石最高級數','每週頻率','加入原因',
      '繳費金額','匯款日期','匯款末五碼','隊服尺寸',
      '付款狀態','隊員狀態','建議團練','許願活動','其他建議','申請時間'
    ];
    const csvRows = [headers.join(',')];
    rows.forEach((r, i) => {
      const paid = r.paymentStatus==='confirmed' ? '已確認' : '待確認';
      const status = r.status==='active' ? '正式隊員' : r.status==='cancelled' ? '已退隊' : '待審核';
      const cols = [
        i+1,
        `"${r.memberName||''}"`,
        r.memberGender||'',
        r.memberBirthday||'',
        r.memberPhone||'',
        r.memberEmail||'',
        `"${r.idNumber||''}"`,
        `"${(r.address||'').replace(/"/g,'""')}"`,
        r.lineId||'',
        r.primaryGym||'',
        r.currentGrade||'',
        r.weeklyFrequency||'',
        `"${(r.joinReasons||[]).join('、')}"`,
        r.paymentAmount||'',
        r.paymentDate||'',
        r.bankLastFive||'',
        r.jerseySize||'',
        paid, status,
        `"${(r.trainingContent||'').replace(/"/g,'""')}"`,
        `"${(r.wishActivities||'').replace(/"/g,'""')}"`,
        `"${(r.otherSuggestions||'').replace(/"/g,'""')}"`,
        r.createdAt?._seconds ? new Date(r.createdAt._seconds*1000).toLocaleString('zh-TW') : '',
      ];
      csvRows.push(cols.join(','));
    });

    const csv = '\uFEFF' + csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="team_members_${year}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
