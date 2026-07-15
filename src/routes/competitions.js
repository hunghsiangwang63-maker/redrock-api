/**
 * 比賽報名路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission , requireManagerOrStation } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { getDb, COLLECTIONS } = require('../config/firebase');
const competitionService = require('../services/competitionService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ══════════════════════════════════════════════════════
// 賽事管理（工作人員）
// ══════════════════════════════════════════════════════

// ── POST /competitions - 建立賽事 ──────────────────────────────────
router.post('/',
  authenticate, checkPermission('competitions.manage'),
  [
    body('name').notEmpty().withMessage('請輸入賽事名稱'),
    body('scoringSystem').isIn(competitionService.SCORING_SYSTEMS).withMessage('請選擇計分系統'),
    body('divisions').isArray({ min: 1 }).withMessage('請至少設定一個組別'),
  ],
  validate,
  async (req, res) => {
    try {
      const competition = await competitionService.createCompetition({ ...req.body, staffId: req.staff.id });
      res.status(201).json({ competition, message: '賽事已建立' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /competitions/sweep-expired-payments - 手動觸發逾期剔除（super_admin，供測試/補跑）──
router.post('/sweep-expired-payments', authenticate, async (req, res) => {
  try {
    if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
    const r = await competitionService.sweepExpiredCompetitionPayments();
    res.json({ success: true, ...r });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /competitions/:id - 修改賽事 ───────────────────────────────
router.put('/:id', authenticate, checkPermission('competitions.manage'), async (req, res) => {
  try {
    const competition = await competitionService.updateCompetition(req.params.id, req.body);
    res.json({ competition, message: '賽事已更新' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── DELETE /competitions/:id - 刪除比賽 ──
router.delete('/:id',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.COMPETITIONS).doc(req.params.id).delete();
      res.json({ success: true, message: '比賽已刪除' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── GET /competitions - 賽事列表（會員端僅看開放中，員工端可看全部）──
router.get('/', authenticateAny, async (req, res) => {
  try {
    const status = req.member ? 'open' : req.query.status;
    const competitions = await competitionService.getCompetitions(status);
    res.json({ competitions });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /competitions/:id - 賽事詳情 ───────────────────────────────
router.get('/:id', authenticateAny, async (req, res) => {
  try {
    const competition = await competitionService.getCompetition(req.params.id);
    res.json({ competition });
  } catch (err) {
    if (err.code) return res.status(404).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /competitions/:id/registrations - 報名名單（工作人員）──────
router.get('/:id/registrations', authenticate, checkPermission('competitions.manage'), async (req, res) => {
  try {
    const registrations = await competitionService.getCompetitionRegistrations(req.params.id);
    res.json({ registrations });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /competitions/registrations/:id/retry-webhook - 手動重新推送 ──
router.post('/registrations/:id/retry-webhook', authenticate, checkPermission('competitions.manage'), async (req, res) => {
  try {
    const result = await competitionService.retryWebhook(req.params.id);
    res.json({ registration: result, message: result.webhookStatus === 'sent' ? '已成功推送至計分系統' : `推送狀態：${result.webhookStatus}` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /competitions/:id/sync-scoring - 管理員開始與計分系統對接（建賽事+推送全部正取名單）──
router.post('/:id/sync-scoring', authenticate, checkPermission('competitions.manage'), async (req, res) => {
  try {
    const result = await competitionService.startScoringSync(req.params.id);
    res.json({ ...result, message: `已開始對接：賽事已建立，推送 ${result.synced}/${result.totalConfirmed} 位正取選手${result.failed ? `（${result.failed} 筆失敗）` : ''}` });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ══════════════════════════════════════════════════════
// 報名（會員端）
// ══════════════════════════════════════════════════════

// ── POST /competitions/:id/register - 報名比賽 ─────────────────────
router.post('/:id/register',
  authenticateAny,
  [
    body('divisionId').notEmpty().withMessage('請選擇報名組別'),
    body('signatureData').notEmpty().withMessage('請完成簽名'),
  ],
  validate,
  async (req, res) => {
    try {
      const memberId = req.body.memberId || req.member?.id;
      if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });

      // 驗證：會員只能為自己或子會員報名
      const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 404 });
      if (deny) return res.status(deny.status).json(deny.body);

      // 取報名對象會員資料：生日權威（兒童費率）＋ 性別/手機/Email 自動帶入（會員資料缺漏由表單補填）
      let registrantBirthday = null;
      let registrantData = {};
      try {
        const _mDoc = await getDb().collection('members').doc(memberId).get();
        if (_mDoc.exists) {
          registrantData = _mDoc.data();
          registrantBirthday = registrantData.birthday || null;
        }
      } catch (e) {}
      const regGender = req.body.gender || registrantData.gender || null;
      const regBirthday = registrantBirthday || req.body.birthday || null;
      const regPhone = req.body.phone || registrantData.phone || req.member?.phone || null;
      const regEmail = req.body.email || registrantData.email || req.member?.email || null;

      const registration = await competitionService.registerForCompetition({
        competitionId: req.params.id,
        memberId,
        memberName: req.body.memberName || req.member?.name,
        isMinor: req.body.isMinor,
        birthday: regBirthday,
        gender: regGender,
        phone: regPhone,
        email: regEmail,
        divisionId: req.body.divisionId,
        customFieldValues: req.body.customFieldValues,
        signatureData: req.body.signatureData,
        guardianSignature: req.body.guardianSignature,
        parentEmail: req.body.parentEmail,
        parentName: req.body.parentName,
        parentPhone: req.body.parentPhone,
        parentRelation: req.body.parentRelation,
        // 保險用欄位
        idNumber: req.body.idNumber,
        emergencyContact: req.body.emergencyContact,
        emergencyRelation: req.body.emergencyRelation,
        emergencyPhone: req.body.emergencyPhone,
        // 比賽欄位
        height: req.body.height,
        armSpan: req.body.armSpan,
        isHonorary: req.body.isHonorary,
        // 付款
        paymentMethod: req.body.paymentMethod,
        paymentDate: req.body.paymentDate,
        bankName: req.body.bankName,
        bankLastFive: req.body.bankLastFive,
        ip: req.ip,
      });

      // 會員資料缺性別/生日 → 以本次報名補填回會員文件（下次自動帶入）
      try {
        const patch = {};
        if (!registrantData.gender && regGender) patch.gender = regGender;
        if (!registrantData.birthday && regBirthday) patch.birthday = regBirthday;
        if (Object.keys(patch).length) await getDb().collection('members').doc(memberId).update(patch);
      } catch (e) {}
      res.status(201).json({
        registration,
        message: registration.isComplete
          ? '報名成功'
          : '報名已送出，已寄送簽署連結給法定代理人，待其完成簽署後即報名完成',
      });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /competitions/registrations/member/:memberId - 會員自己的報名紀錄 ──
router.get('/registrations/member/:memberId', authenticateAny, async (req, res) => {
  try {
    // 會員只能查自己或子會員的
    const deny = await checkMemberOwnership(req.member, req.params.memberId, { onMissing: 403, message: '只能查看自己或子會員的報名紀錄' });
    if (deny) return res.status(deny.status).json(deny.body);
    const registrations = await competitionService.getMemberRegistrations(req.params.memberId);
    res.json({ registrations });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET/POST /competitions/waiver/parent/:token - 家長遠端簽署比賽聲明書 ──
router.get('/waiver/parent/:token', async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('competitionRegistrations')
      .where('parentSignToken', '==', req.params.token).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: 'INVALID_TOKEN', message: '連結無效或已過期' });

    const registration = snap.docs[0].data();
    if (registration.isComplete) return res.status(400).json({ error: 'ALREADY_SIGNED', message: '已完成簽署' });

    const competition = await competitionService.getCompetition(registration.competitionId);
    res.json({
      memberName: registration.memberName,
      competitionName: registration.competitionName,
      waiverContent: competition.waiverContent,
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/waiver/parent/:token',
  [body('signatureData').notEmpty().withMessage('請完成簽名')],
  validate,
  async (req, res) => {
    try {
      const result = await competitionService.signParentCompetitionWaiver(req.params.token, req.body.signatureData, req.ip);
      res.json({ ...result, message: '簽署完成，報名已確認' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /competitions/:id/registrations/download - 下載名單 CSV ──
router.get('/:id/registrations/download',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
        .where('competitionId', '==', req.params.id)
        .get();
      const rows = snap.docs.map(d => d.data()).sort((a, b) => {
        const ta = a.registeredAt?._seconds || 0;
        const tb = b.registeredAt?._seconds || 0;
        return ta - tb;
      });

      const headers = [
        '序號','姓名','性別','生日','手機','Email',
        '身分證/護照','緊急聯絡人','緊急聯絡人關係','緊急聯絡人手機',
        '身高','臂展','組別','榮譽參賽','報名費',
        '付款狀態','匯款銀行','匯款/繳款日期','匯款末五碼',
        '簽署狀態','是否候補','備註','報名時間'
      ];

      const csvRows = [headers.join(',')];
      rows.forEach((r, i) => {
        const paid = r.paymentStatus === 'confirmed' ? '已確認' : r.paymentStatus === 'refunded' ? '已退費' : '待確認';
        const signed = r.isComplete ? '已完成' : r.parentRequired ? '待法定代理人簽名' : '未完成';
        const cols = [
          i + 1,
          `"${r.memberName || ''}"`,
          r.gender || '',
          r.birthday || '',
          r.phone || '',
          r.email || '',
          `"${r.idNumber || ''}"`,
          `"${r.emergencyContact || ''}"`,
          `"${r.emergencyRelation || ''}"`,
          r.emergencyPhone || '',
          r.height || '',
          r.armSpan || '',
          `"${r.divisionName || ''}"`,
          r.isHonorary ? '是' : '否',
          r.registrationFee || '',
          paid,
          r.paymentMethod === 'cash' ? '臨櫃繳款' : `"${r.bankName || ''}"`,
          r.paymentDate || '',
          r.paymentMethod === 'cash' ? '' : (r.bankLastFive || ''),
          signed,
          r.status === 'waitlist' ? '是' : '否',
          `"${(r.customFieldValues?.notes || '').replace(/"/g, '""')}"`,
          r.registeredAt?._seconds ? new Date(r.registeredAt._seconds * 1000).toLocaleString('zh-TW') : '',
        ];
        csvRows.push(cols.join(','));
      });

      const csv = '\uFEFF' + csvRows.join('\n'); // BOM for Excel UTF-8
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="competition_registrations_${req.params.id}.csv"`);
      res.send(csv);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/cancel - 會員取消報名（立即釋出名額）──
router.post('/registrations/:regId/cancel',
  authenticateAny,
  async (req, res) => {
    try {
      const db = getDb();
      const regDoc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).get();
      if (!regDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名記錄' });
      const reg = regDoc.data();

      // 確認是本人取消（member token）
      if (req.member && req.member.id !== reg.memberId)
        return res.status(403).json({ error: 'FORBIDDEN', message: '無權限取消此報名' });
      if (reg.status === 'cancelled')
        return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });

      // 已繳費(confirmed)的取消才算「申請退費」→ 標記 refundRequested + 存退費帳號、建待辦通知管理員；
      // 未繳費(pending)是純「取消報名」→ 無款可退，不標記退費、不通知（避免會員以為在等退費、櫃檯卻看不到）
      const isPaidReg = reg.paymentStatus === 'confirmed';
      // 權威把關：已繳費取消（＝退費申請）必須帶退費銀行代碼＋帳號，否則櫃檯無從匯款
      if (isPaidReg) {
        const bankCode = String(req.body.refundBankCode || '').trim();
        const account = String(req.body.refundAccount || '').trim();
        if (!bankCode || !account) {
          return res.status(400).json({ error: 'MISSING_REFUND_ACCOUNT', message: '申請退費需填寫退費銀行代碼與帳號' });
        }
      }
      await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).update({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: req.body.reason || '會員申請取消',
        refundRequested: isPaidReg,
        refundBankName: isPaidReg ? (req.body.refundBankName || null) : null,
        refundBankCode: isPaidReg ? (req.body.refundBankCode || null) : null,
        refundAccount: isPaidReg ? (req.body.refundAccount || null) : null,
        refundAccountName: isPaidReg ? (req.body.refundAccountName || null) : null,
        updatedAt: new Date(),
      });

      // 若釋出的是正取名額：① 計分系統移除該選手 ② 遞補下一位候補（遞補者完成簽署會自動推送計分系統）
      if (reg.status === 'confirmed') {
        try {
          const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data();
          const { isCompScoring, removeCompAthlete } = require('../services/competitionSyncService');
          if (isCompScoring(comp)) await removeCompAthlete(comp, req.params.regId);
        } catch (e) { console.error('[計分系統] 取消同步失敗', e.message); }
        try { await competitionService.promoteNextWaitlist(reg.competitionId, reg.divisionId); }
        catch (e) { console.error('比賽候補遞補失敗:', e.message); }
      }

      // 已收款的取消＝退費待處理 → 站內通知管理員（同館 gym_manager + super_admin；寄失敗不阻斷）
      if (reg.paymentStatus === 'confirmed') {
        try {
          const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data();
          const { notifyRoleInGym } = require('../services/notificationService');
          const payload = {
            gymId: comp?.gymId || 'gym-hsinchu',
            type: 'competition_refund_request',
            title: '比賽取消報名・退費待處理',
            body: `${reg.memberName} 取消「${reg.competitionName || comp?.name || ''}」報名（已收 NT$${reg.paidAmount || reg.registrationFee || ''}），退費帳號已留存，請至待辦處理。`,
            referenceId: req.params.regId, referenceType: 'competitionRegistration',
          };
          await notifyRoleInGym({ ...payload, role: 'gym_manager' });
          await notifyRoleInGym({ ...payload, role: 'super_admin' });
        } catch (e) { console.error('比賽退費通知失敗', e.message); }
      }
      res.json({ success: true, message: isPaidReg
        ? '報名已取消，名額已釋出。退費將於比賽結束後一週內統一處理。'
        : '報名已取消，名額已釋出。（尚未繳費，無需退費）' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);


router.post('/registrations/:regId/confirm-payment',
  authenticate,
  async (req, res) => {
    try {
      const db = getDb();
      const regRef = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
      const regDoc = await regRef.get();
      if (!regDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = regDoc.data();
      // 收款確認權限：臨櫃現金→值班 operator/館別電腦 或管理員；轉帳→僅管理員（與課程收款規則一致）
      const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
      const isStationMode = ['operator', 'station'].includes(req.staff?.type);
      if (reg.paymentMethod === 'cash') {
        if (!isManager && !isStationMode) return res.status(403).json({ error: 'MANAGER_OR_STATION_REQUIRED', message: '現金收款確認限值班人員或管理員' });
      } else if (!isManager) {
        return res.status(403).json({ error: 'MANAGER_REQUIRED', message: '轉帳收款確認限管理員' });
      }
      if (reg.paymentStatus === 'confirmed') return res.json({ success: true, message: '已確認收款' }); // 冪等：避免重複記帳/重複加減項
      await regRef.update({
          paymentStatus: 'confirmed',
          ...(req.body.staffNote != null && String(req.body.staffNote).trim() ? { staffNote: String(req.body.staffNote).trim() } : {}),
          paidAmount: req.body.amount || null,
          paidAt: new Date(),
          paidConfirmedBy: req.staff.id,
          paidConfirmedByName: req.staff.name,
          updatedAt: new Date(),
        });
      // 臨櫃現金 → 金額寫入賽事館別當日結帳加減項（＋現金補入，note＝人名＋活動名）
      if (reg.paymentMethod === 'cash') {
        try {
          const compDoc = await db.collection(COLLECTIONS.COMPETITIONS || 'competitions').doc(reg.competitionId).get();
          await require('../services/settlementService').addCashAdjustment({
            gymId: compDoc.data()?.gymId,
            amount: Number(req.body.amount) || reg.registrationFee || 0,
            note: `${reg.memberName || ''} ${reg.competitionName || ''}`.trim(),
          });
        } catch (e) { console.error('比賽現金寫入結帳加減項失敗', e.message); }
      }
      // 記營收（預收，認列在比賽前一天）
      try { await competitionService.recordCompetitionRevenue({ db, regId: req.params.regId, sign: 1, staffId: req.staff.id, staffName: req.staff.name }); }
      catch (e) { console.error('比賽記帳失敗', e.message); }
      res.json({ success: true, message: '已確認收款' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/reject-payment - 退回繳費資訊（報名者需重新填寫）──
// reason＝退回原因（必填，會員看得到＋Email 通知）；staffNote＝員工內部備註（選填，會員看不到）
router.post('/registrations/:regId/reject-payment',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'MISSING_REASON', message: '請填寫退回原因' });
      const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = doc.data();
      if (reg.paymentStatus === 'confirmed') return res.status(400).json({ error: 'ALREADY_CONFIRMED', message: '已確認收款，不可退回；如需處理請走退費' });
      const staffNote = String(req.body.staffNote || '').trim();
      await ref.update({
        paymentStatus: 'transfer_rejected',
        paymentRejectReason: reason,
        paymentRejectedAt: new Date(),
        ...(staffNote ? { staffNote } : {}),
        updatedAt: new Date(),
      });
      // Email 通知報名者（失敗不阻斷）
      try {
        const email = reg.email || (await db.collection('members').doc(reg.memberId).get()).data()?.email;
        if (email) {
          const emailService = require('../services/emailService');
          await emailService.sendEmail({
            to: email,
            subject: '【紅石攀岩】比賽報名繳費資訊未通過確認',
            html: `<p>您好，您報名「${reg.competitionName || '比賽'}」的繳費資訊未通過確認。</p><p>原因：${reason}</p><p>請登入會員系統，至「比賽報名 → 我的報名」重新填寫繳費資訊。</p>`,
          });
        }
      } catch (e) { console.error('比賽退回通知信失敗', e.message); }
      res.json({ success: true, message: '已退回，報名者需重新填寫繳費資訊' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/payment-info - 會員重新填寫繳費資訊（被退回後補正）──
router.post('/registrations/:regId/payment-info', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const reg = doc.data();
    const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能修改自己或子會員的報名' });
    if (deny) return res.status(deny.status).json(deny.body);
    if (!['transfer_rejected', 'pending'].includes(reg.paymentStatus)) {
      return res.status(400).json({ error: 'NOT_EDITABLE', message: '此報名的繳費狀態不可修改' });
    }
    const paymentMethod = req.body.paymentMethod;
    if (!['cash', 'transfer'].includes(paymentMethod)) return res.status(400).json({ error: 'INVALID_METHOD', message: '付款方式須為現金或轉帳' });
    const paymentDate = String(req.body.paymentDate || '').trim();
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    const maxDate = require('dayjs')(today).add(3, 'day').format('YYYY-MM-DD');
    if (!paymentDate) return res.status(400).json({ error: 'MISSING_PAYMENT_DATE', message: '請填寫繳費日期' });
    if (paymentDate < today || paymentDate > maxDate) return res.status(400).json({ error: 'INVALID_PAYMENT_DATE', message: '繳費日期須為 3 日內' });
    await ref.update({
      paymentMethod,
      paymentDate,
      bankName: paymentMethod === 'transfer' ? (String(req.body.bankName || '').trim() || null) : null,
      bankLastFive: paymentMethod === 'transfer' ? (String(req.body.bankLastFive || '').trim() || null) : null,
      paymentStatus: 'pending',
      paymentRejectReason: null,
      paymentRejectedAt: null,
      updatedAt: new Date(),
    });
    res.json({ success: true, message: '繳費資訊已更新，請等待館方確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /competitions/registrations/:regId/return-form - 管理員退回報名表給會員修改（保留名額、可修改重送）──
// reason 必填（會員看得到＋Email）；不釋出名額（會員修正後重送）。與「退回繳費」不同：這是整張報名表資料有誤。
router.post('/registrations/:regId/return-form',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'MISSING_REASON', message: '請填寫退回原因' });
      const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = doc.data();
      if (reg.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });
      if (reg.formReturned) return res.status(400).json({ error: 'ALREADY_RETURNED', message: '此報名已退回，正在等待會員修改' });
      const staffNote = String(req.body.staffNote || '').trim();
      await ref.update({
        formReturned: true,
        formReturnReason: reason,
        formReturnedAt: new Date(),
        formReturnedBy: req.staff.id,
        ...(staffNote ? { staffNote } : {}),
        updatedAt: new Date(),
      });
      try {
        const email = reg.email || (await db.collection('members').doc(reg.memberId).get()).data()?.email;
        if (email) {
          const emailService = require('../services/emailService');
          await emailService.sendEmail({
            to: email,
            subject: '【紅石攀岩】比賽報名表需修正',
            html: `<p>您好，您報名「${reg.competitionName || '比賽'}」的報名資料需要修正。</p><p>原因：${reason}</p><p>請登入會員系統，至「比賽報名 → 我的報名」點「修改報名資料」修正後重新送出。名額仍為您保留。</p>`,
          });
        }
      } catch (e) { console.error('比賽退回報名表通知信失敗', e.message); }
      res.json({ success: true, message: '已退回報名表，會員可修改後重送（名額保留）' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/reject-form - 管理員駁回取消此報名（釋出名額）──
// reason 必填。直接作廢：釋出名額、遞補候補、移除計分系統；已收款者標退費待處理。
router.post('/registrations/:regId/reject-form',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'MISSING_REASON', message: '請填寫駁回原因' });
      const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = doc.data();
      if (reg.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });
      const wasPaid = reg.paymentStatus === 'confirmed';
      await ref.update({
        status: 'cancelled',
        cancelReason: `管理員駁回：${reason}`,
        formRejected: true,
        formReturned: false,
        rejectedByStaff: req.staff.id,
        cancelledAt: new Date(),
        // 已收款者標退費待處理（走既有退費待辦 / 退費流程）
        refundRequested: wasPaid,
        updatedAt: new Date(),
      });
      // 釋出名額：正取 → 計分系統移除 + 遞補候補
      if (reg.status === 'confirmed') {
        try {
          const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data();
          const { isCompScoring, removeCompAthlete } = require('../services/competitionSyncService');
          if (isCompScoring(comp)) await removeCompAthlete(comp, req.params.regId);
        } catch (e) { console.error('[計分系統] 駁回移除失敗', e.message); }
        try { await competitionService.promoteNextWaitlist(reg.competitionId, reg.divisionId); }
        catch (e) { console.error('比賽駁回候補遞補失敗:', e.message); }
      }
      try {
        const email = reg.email || (await db.collection('members').doc(reg.memberId).get()).data()?.email;
        if (email) {
          const emailService = require('../services/emailService');
          await emailService.sendEmail({
            to: email,
            subject: '【紅石攀岩】比賽報名未通過',
            html: `<p>您好，您報名「${reg.competitionName || '比賽'}」未通過審核，已取消。</p><p>原因：${reason}</p>${wasPaid ? '<p>已收款項將另行退費處理。</p>' : ''}<p>如有疑問請洽館方。</p>`,
          });
        }
      } catch (e) { console.error('比賽駁回通知信失敗', e.message); }
      res.json({ success: true, message: wasPaid ? '已駁回並釋出名額；已收款項請至退費待辦處理' : '已駁回並釋出名額' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/update-form - 會員修改報名資料後重送（限被退回後）──
router.post('/registrations/:regId/update-form', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const reg = doc.data();
    const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能修改自己或子會員的報名' });
    if (deny) return res.status(deny.status).json(deny.body);
    if (!reg.formReturned) return res.status(400).json({ error: 'NOT_RETURNED', message: '此報名未被退回，無法修改' });
    if (reg.status === 'cancelled') return res.status(400).json({ error: 'ALREADY_CANCELLED', message: '此報名已取消' });

    const b = req.body;
    // 必填驗證（比照報名）
    if (b.gender !== 'male' && b.gender !== 'female') return res.status(400).json({ error: 'MISSING_GENDER', message: '請選擇性別' });
    if (!b.birthday) return res.status(400).json({ error: 'MISSING_BIRTHDAY', message: '請填寫生日' });
    if (!b.phone || !String(b.phone).trim()) return res.status(400).json({ error: 'MISSING_PHONE', message: '請填寫手機號碼' });
    if (!b.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email).trim())) return res.status(400).json({ error: 'MISSING_EMAIL', message: '請填寫有效的 Email' });

    const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data();
    // 組別（可改）：驗證存在；若改組且新組已滿正取 → 轉候補
    const newDivisionId = b.divisionId || reg.divisionId;
    const division = (comp.divisions || []).find(d => d.id === newDivisionId);
    if (!division) return res.status(400).json({ error: 'INVALID_DIVISION', message: '組別不正確' });
    let newStatus = reg.status, newWaitlistPos = reg.waitlistPosition;
    if (newDivisionId !== reg.divisionId) {
      const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
        .where('competitionId', '==', reg.competitionId).where('divisionId', '==', newDivisionId)
        .where('status', 'in', ['confirmed', 'waitlist']).get();
      const cCount = snap.docs.filter(d => d.data().status === 'confirmed').length;
      const wCount = snap.docs.filter(d => d.data().status === 'waitlist').length;
      const maxP = division.maxParticipants || 40, wMax = division.waitlistMax || 5;
      if (cCount >= maxP && wCount >= wMax) return res.status(400).json({ error: 'DIVISION_FULL', message: '欲改的組別已滿（含候補）' });
      newStatus = cCount >= maxP ? 'waitlist' : 'confirmed';
      newWaitlistPos = newStatus === 'waitlist' ? wCount + 1 : null;
    }
    // 後端權威重算費用（生日→兒童、早鳥）
    const fees = comp.fees || {};
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    const isEarly = comp.earlyBirdDeadline && today <= comp.earlyBirdDeadline;
    const age = b.birthday ? require('dayjs')().diff(require('dayjs')(b.birthday), 'year') : null;
    const isChild = age !== null && age < (fees.childAgeLimit || 15);
    const registrationFee = isChild
      ? (isEarly ? fees.childEarlyBird : fees.childRegular) || 950
      : (isEarly ? fees.adultEarlyBird : fees.adultRegular) || 1100;

    await ref.update({
      divisionId: newDivisionId, divisionName: division.name,
      status: newStatus, waitlistPosition: newWaitlistPos,
      gender: b.gender, birthday: b.birthday,
      phone: String(b.phone).trim(), email: String(b.email).trim(),
      idNumber: b.idNumber || reg.idNumber || null,
      emergencyContact: b.emergencyContact || null,
      emergencyRelation: b.emergencyRelation || null,
      emergencyPhone: b.emergencyPhone || null,
      height: b.height || null, armSpan: b.armSpan || null,
      isHonorary: !!b.isHonorary,
      registrationFee, isEarlyBird: !!isEarly,
      // 清除退回旗標
      formReturned: false, formReturnReason: null, formReturnedAt: null,
      updatedAt: new Date(),
    });
    res.json({ success: true, message: '報名資料已更新，請等待館方確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /competitions/registrations/:regId/refund - 退費 ──
router.post('/registrations/:regId/refund',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
        .doc(req.params.regId).update({
          paymentStatus: 'refunded',
          refundAmount: req.body.refundAmount || null,
          refundReason: req.body.reason || '',
          refundedAt: new Date(),
          refundedBy: req.staff.id,
          status: 'cancelled',
          updatedAt: new Date(),
        });
      // 記負向交易（退費，認列在比賽前一天）
      try { await competitionService.recordCompetitionRevenue({ db, regId: req.params.regId, sign: -1, refund: true, staffId: req.staff.id, staffName: req.staff.name }); }
      catch (e) { console.error('比賽退費記帳失敗', e.message); }
      res.json({ success: true, message: '退費已處理' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/guardian-sign - 補簽法定代理人同意書 ──
// 未成年報名（parentRequired 且未完成）由家長於 App 內補簽（本人/子女擁有權）→ 完成並推計分系統。
router.post('/registrations/:regId/guardian-sign', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名記錄' });
    const reg = doc.data();
    if (req.member && reg.memberId) {
      const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能為自己或子會員的報名補簽' });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    if (!reg.parentRequired) return res.status(400).json({ error: 'NOT_REQUIRED', message: '此報名不需法定代理人簽署' });
    if (reg.isComplete) return res.status(409).json({ error: 'ALREADY_SIGNED', message: '已完成簽署' });
    if (!req.body.signatureData) return res.status(400).json({ error: 'NO_SIGNATURE', message: '請提供法定代理人簽名' });
    const { uploadSignature } = require('../services/waiverService');
    const url = await uploadSignature(`competition_${req.params.regId}`, 'guardian', req.body.signatureData);
    const now = new Date();
    await doc.ref.update({
      guardianSignatureUrl: url, guardianSignedAt: now,
      parentName: req.body.parentName || reg.parentName || null,
      isComplete: true, updatedAt: now,
    });
    // 完成 → 推計分系統（失敗不阻斷）
    try { await competitionService.sendWebhook(req.params.regId); } catch (e) { console.error('補簽後推送失敗', e.message); }
    res.json({ success: true, message: '法定代理人簽署完成，報名已生效' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══ 比賽報到（會員出示 QR、員工掃描）══════════════════════════════
// 報到只驗「報名資格」：confirmed＋簽署完成＋比賽日當天＋未重複報到；
// 【不卡墜落測驗】（比賽入場豁免；風險已由參賽同意書涵蓋）。報到建 checkIns 紀錄（entryType: competition、0 元）。
const { v4: _uuidv4 } = require('uuid');

// POST /competitions/registrations/:regId/checkin-token - 會員取得報到 QR token（本人/子女）
router.post('/registrations/:regId/checkin-token', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名記錄' });
    const reg = doc.data();
    if (req.member) {
      const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能取得自己或子會員的報到 QR' });
      if (deny) return res.status(deny.status).json(deny.body);
    }
    if (reg.status === 'cancelled') return res.status(400).json({ error: 'CANCELLED', message: '此報名已取消' });
    let token = reg.checkinToken;
    if (!token) {
      token = _uuidv4();
      await doc.ref.update({ checkinToken: token, updatedAt: new Date() });
    }
    res.json({ token: `compchk:${token}`, checkedInAt: reg.checkedInAt || null });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// 以 token 撈報名＋賽事（共用）
const findRegByCheckinToken = async (db, raw) => {
  const token = String(raw || '').replace(/^compchk:/, '');
  if (!token) return null;
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('checkinToken', '==', token).limit(1).get();
  if (snap.empty) return null;
  const reg = { id: snap.docs[0].id, ...snap.docs[0].data() };
  const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data() || {};
  return { reg, comp };
};

// POST /competitions/checkin/scan - 員工掃報到 QR（預覽；值班/管理員）
router.post('/checkin/scan', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const hit = await findRegByCheckinToken(db, req.body.token);
    if (!hit) return res.status(404).json({ error: 'QR_NOT_FOUND', message: '無效的報到 QR' });
    const { reg, comp } = hit;
    res.json({
      registrationId: reg.id, memberName: reg.memberName,
      competitionName: reg.competitionName || comp.name, divisionName: reg.divisionName,
      eventDate: comp.eventDate, status: reg.status, isComplete: reg.isComplete,
      paymentStatus: reg.paymentStatus, registrationFee: reg.registrationFee,
      checkedInAt: reg.checkedInAt || null,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// POST /competitions/checkin/confirm - 確認報到（值班/管理員；不卡墜測）
router.post('/checkin/confirm', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const hit = await findRegByCheckinToken(db, req.body.token);
    if (!hit) return res.status(404).json({ error: 'QR_NOT_FOUND', message: '無效的報到 QR' });
    const { reg, comp } = hit;
    if (reg.status === 'cancelled') return res.status(400).json({ error: 'CANCELLED', message: '此報名已取消' });
    if (reg.status !== 'confirmed') return res.status(400).json({ error: 'NOT_CONFIRMED', message: '此報名非正取（候補請先遞補）' });
    if (!reg.isComplete) return res.status(400).json({ error: 'NOT_COMPLETE', message: '尚未完成簽署（未成年待法定代理人簽署）' });
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    if (comp.eventDate && comp.eventDate !== today) {
      return res.status(400).json({ error: 'NOT_EVENT_DAY', message: `比賽日為 ${comp.eventDate}，今日不可報到` });
    }
    if (reg.checkedInAt) return res.status(409).json({ error: 'ALREADY_CHECKED_IN', message: '此選手已完成報到' });
    const now = new Date();
    await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(reg.id).update({
      checkedInAt: now, checkedInBy: req.staff.id, checkedInByName: req.staff.name, updatedAt: now,
    });
    // 入場紀錄（0 元、entryType competition；供今日入場統計/稽核；不觸發墜測/waiver 關卡）
    const checkInId = _uuidv4();
    await db.collection('checkIns').doc(checkInId).set({
      id: checkInId, memberId: reg.memberId, memberName: reg.memberName,
      gymId: comp.gymId || req.staff.gymId || null,
      entryType: 'competition', amountPaid: 0, paymentMethod: null,
      isCompetitionCheckin: true, competitionId: reg.competitionId, registrationId: reg.id,
      checkedInAt: now, confirmedBy: req.staff.id, createdAt: now,
    });
    res.json({ success: true, message: `${reg.memberName} 報到完成（${reg.divisionName || ''}）`, checkInId });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
