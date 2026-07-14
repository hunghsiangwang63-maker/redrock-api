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
        '付款狀態','匯款日期','匯款末五碼',
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
          r.paymentDate || '',
          r.bankLastFive || '',
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

      await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).update({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: req.body.reason || '會員申請取消',
        refundRequested: true,
        refundBankName: req.body.refundBankName || null,
        refundBankCode: req.body.refundBankCode || null,
        refundAccount: req.body.refundAccount || null,
        refundAccountName: req.body.refundAccountName || null,
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
      res.json({ success: true, message: '報名已取消，名額已釋出。退費將於比賽結束後一週內統一處理。' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);


router.post('/registrations/:regId/confirm-payment',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
        .doc(req.params.regId).update({
          paymentStatus: 'confirmed',
          paidAmount: req.body.amount || null,
          paidAt: new Date(),
          paidConfirmedBy: req.staff.id,
          paidConfirmedByName: req.staff.name,
          updatedAt: new Date(),
        });
      // 記營收（預收，認列在比賽前一天）
      try { await competitionService.recordCompetitionRevenue({ db, regId: req.params.regId, sign: 1, staffId: req.staff.id, staffName: req.staff.name }); }
      catch (e) { console.error('比賽記帳失敗', e.message); }
      res.json({ success: true, message: '已確認收款' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

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
