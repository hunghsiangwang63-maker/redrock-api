/**
 * 比賽報名路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { authenticate, authenticateAny, checkPermission , requireManagerOrStation, requireManager } = require('../middleware/auth');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { getDb, COLLECTIONS } = require('../config/firebase');
const competitionService = require('../services/competitionService');
const emailService = require('../services/emailService');

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

// ── GET /competitions/:id/quote - 報名前費用預覽（後端權威，與 registerForCompetition 同一份計算函式）──
// 供會員報名表在送出前就顯示正確金額（含隊員9折/友館折擇優），避免顯示原價、送出才打折的誤解。
router.get('/:id/quote', authenticateAny, async (req, res) => {
  try {
    const memberId = req.query.memberId || req.member?.id;
    if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });
    const deny = await checkMemberOwnership(req.member, memberId, { onMissing: 404 });
    if (deny) return res.status(deny.status).json(deny.body);

    const competition = await competitionService.getCompetition(req.params.id);
    let birthday = req.query.birthday || null;
    if (!birthday) {
      const mDoc = await getDb().collection('members').doc(memberId).get();
      birthday = mDoc.exists ? (mDoc.data().birthday || null) : null;
    }
    const quote = await competitionService.computeCompetitionFee({
      competition, birthday, memberId, partnerGymId: req.query.partnerGymId || null,
    });
    res.json({ quote });
  } catch (err) {
    if (err.code) return res.status(404).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /competitions/:id/registrations - 報名名單（工作人員）──────
// 報名名單每筆的「已開立發票」狀態 join（依 registrationId 批次查，比照課程學員報表 members.js
// 同款邏輯——優先真實列印版 invoices，缺才退回過渡期 §9 手動記帳版 invoiceRecords，兩邊都有以真實
// 列印版為準）。供「🧾 開立發票」固定按鍵在名單上直接反白顯示狀態＋號碼。
const attachInvoiceStatus = async (db, registrations) => {
  const ids = [...new Set(registrations.map(r => r.id).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  const invoiceMap = {};
  // 名單筆數多時（多批次查詢）原本逐批依序 await，一批批排隊會讓等待時間隨報名人數線性拉長；
  // 每批的兩個查詢彼此獨立、批次之間也彼此獨立，全部一次平行送出即可（Firestore 對併發讀取無此限制）。
  const results = await Promise.all(chunks.map(chunk => Promise.all([
    db.collection('invoices').where('refId', 'in', chunk).get(),
    db.collection('invoiceRecords').where('refId', 'in', chunk).get(),
  ])));
  results.forEach(([realSnap, legacySnap]) => {
    legacySnap.docs.forEach(d => {
      const v = d.data();
      if (v.sourceType !== 'competition' || v.status === 'voided') return;
      invoiceMap[v.refId] = { invoiceNo: v.invoiceNo || '', amount: Number(v.amount) || 0 };
    });
    realSnap.docs.forEach(d => {
      const v = d.data();
      if (v.sourceType !== 'competition' || v.status !== 'issued') return;
      invoiceMap[v.refId] = { invoiceNo: v.invoiceNo || '', amount: Number(v.amount) || 0 };
    });
  });
  registrations.forEach(r => {
    const info = invoiceMap[r.id];
    if (info) { r.invoiceNo = info.invoiceNo; r.invoicedAmount = info.amount; }
  });
};

router.get('/:id/registrations', authenticate, checkPermission('competitions.manage'), async (req, res) => {
  try {
    const registrations = await competitionService.getCompetitionRegistrations(req.params.id);
    // 附加「實收金額」（管理員編修 > 匯款確認金額-保費 > 應繳費用-保費），供名單/開發票 modal 顯示與預填
    registrations.forEach(r => { r.receivedAmount = competitionService.computeNetReceivedAmount(r); });
    await attachInvoiceStatus(getDb(), registrations);
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

// ⚠️ TEMP-DIAG-2026-08-18：計分系統(redrock-comp)效能排查用唯讀診斷端點，量測完即移除，不留存
router.get('/_temp/comp-doc-sizes', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const { getCompDb } = require('../config/compFirebase');
    const compDb = getCompDb();
    if (!compDb) return res.status(503).json({ error: 'COMP_DB_UNAVAILABLE' });
    const snap = await compDb.collection('competitions').get();
    const results = [];
    for (const d of snap.docs) {
      const compData = d.data();
      const compSize = Buffer.byteLength(JSON.stringify(compData), 'utf8');
      let scoresSize = 0, scoresExists = false;
      try {
        const scoresDoc = await compDb.collection('competitions').doc(d.id).collection('data').doc('scores').get();
        if (scoresDoc.exists) { scoresExists = true; scoresSize = Buffer.byteLength(JSON.stringify(scoresDoc.data()), 'utf8'); }
      } catch (e) {}
      let scoresFieldBreakdown = {};
      try {
        const scoresDoc = await compDb.collection('competitions').doc(d.id).collection('data').doc('scores').get();
        if (scoresDoc.exists) {
          const sd = scoresDoc.data();
          Object.entries(sd).forEach(([k, v]) => {
            const size = Buffer.byteLength(JSON.stringify(v), 'utf8');
            const entry = { size };
            if (v && typeof v === 'object') {
              const subKeys = Object.keys(v);
              entry.subKeyCount = subKeys.length;
              if (subKeys.length) entry.avgSubEntrySize = Math.round(size / subKeys.length);
              entry.allSubKeys = subKeys; // TEMP-DIAG：看實際 key 長怎樣，判斷是不是測試殘留
              // 再往下一層看一個樣本
              const sample = v[subKeys[0]];
              if (sample && typeof sample === 'object') entry.sampleSubKeys = Object.keys(sample).slice(0, 20);
            }
            scoresFieldBreakdown[k] = entry;
          });
        }
      } catch (e) {}
      results.push({
        id: d.id, name: compData.eventName || '', compSize, scoresExists, scoresSize,
        athleteCount: compData.athletes ? Object.keys(compData.athletes).length : 0,
        athleteIds: compData.athletes ? Object.keys(compData.athletes) : [],
        isActive: compData.isActive, createdAt: compData.createdAt,
        scoresFieldBreakdown,
      });
    }
    res.json({ competitions: results });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ══════════════════════════════════════════════════════
// 公開報名（免登入、訪客，先轉帳；IP 限流見 index.js）
// ══════════════════════════════════════════════════════

// ── GET /competitions/public/:id - 賽事詳情（免登入，供公開報名頁顯示）───
router.get('/public/:id', async (req, res) => {
  try {
    const competition = await competitionService.getCompetition(req.params.id);
    if (competition.status !== 'open') return res.status(404).json({ error: 'NOT_OPEN', message: '此賽事目前未開放報名' });
    let partnerGyms = [];
    try {
      const pgDoc = await getDb().collection('systemSettings').doc('partnerGyms').get();
      partnerGyms = pgDoc.exists && Array.isArray(pgDoc.data().gyms) ? pgDoc.data().gyms.map(g => ({ id: g.id, name: g.name })) : [];
    } catch (e) {}
    res.json({
      competition: {
        id: competition.id, name: competition.name, description: competition.description || '',
        gymId: competition.gymId, eventDate: competition.eventDate,
        registrationStart: competition.registrationStart, registrationEnd: competition.registrationEnd,
        earlyBirdDeadline: competition.earlyBirdDeadline || null,
        divisions: (competition.divisions || []).map(d => ({ id: d.id, name: d.name, maxParticipants: d.maxParticipants || 40 })),
        customFields: competition.customFields || [],
        fees: competition.fees || {},
        waiverContent: competition.waiverContent || { zh: '', en: '' },
        paymentDeadlineDays: competition.paymentDeadlineDays || 3,
      },
      partnerGyms,
    });
  } catch (err) {
    if (err.code) return res.status(404).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /competitions/public/:id/register - 訪客報名比賽 ─────────
// 不建帳號（memberId 用不會碰撞的 guest_<uuid> 佔位字串，避免與其他訪客誤判重複報名/名額計算漂移）；
// 一律轉帳，未成年一律要求本人+法定代理人皆線上完成簽名（不落回 email 遠端補簽分支）。
router.post('/public/:id/register',
  [
    body('divisionId').notEmpty().withMessage('請選擇報名組別'),
    body('signatureData').notEmpty().withMessage('請完成簽名'),
  ],
  validate,
  async (req, res) => {
    try {
      const { guestName, gender, birthday, phone, email } = req.body;
      if (!guestName || !String(guestName).trim()) return res.status(400).json({ error: 'MISSING_CONTACT', message: '請填寫姓名' });
      if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'MISSING_PHONE', message: '請填寫手機號碼' });
      if (!String(req.body.bankLastFive || '').trim()) return res.status(400).json({ error: 'MISSING_BANK_LAST_FIVE', message: '請填寫匯款帳號末五碼' });
      if (!String(req.body.paymentDate || '').trim()) return res.status(400).json({ error: 'MISSING_PAYMENT_DATE', message: '請填寫轉帳日期' });

      const competition = await competitionService.getCompetition(req.params.id);
      // 未成年（依生日、比賽當天為基準）一律要求法定代理人已線上簽名——不像登入版可以落回「寄 email 給家長之後補簽」
      const ageInfo = competitionService.computeCompetitionAgeInfo(birthday, competition);
      if (ageInfo.isMinor && !req.body.guardianSignature) {
        return res.status(400).json({ error: 'GUARDIAN_SIGNATURE_REQUIRED', message: '未滿 18 歲需法定代理人簽名' });
      }

      const memberId = `guest_${uuidv4()}`;
      const registration = await competitionService.registerForCompetition({
        competitionId: req.params.id,
        memberId,
        memberName: String(guestName).trim(),
        isGuest: true,
        birthday, gender, phone: String(phone).trim(), email,
        divisionId: req.body.divisionId,
        customFieldValues: req.body.customFieldValues,
        signatureData: req.body.signatureData,
        guardianSignature: req.body.guardianSignature,
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
        memberNote: req.body.memberNote,
        partnerGymId: req.body.partnerGymId,
        // 付款（訪客一律轉帳）
        paymentMethod: 'transfer',
        paymentDate: req.body.paymentDate,
        bankName: req.body.bankName,
        bankLastFive: req.body.bankLastFive,
        ip: req.ip,
      });

      try {
        const _rn = require('../services/registrationNotify');
        const compDoc = await getDb().collection('competitions').doc(req.params.id).get();
        const comp = compDoc.exists ? compDoc.data() : {};
        _rn.notifyRegReceived({
          to: registration.email, memberId, memberName: registration.memberName || '',
          typeLabel: '比賽', itemName: comp.name || '比賽', gymId: comp.gymId,
          fee: registration.registrationFee || 0, paymentMethod: 'transfer', massage: false,
        });
      } catch (e) { console.error('[Email] 訪客比賽報名通知', e.message); }

      res.status(201).json({
        registration,
        message: '報名成功！請於期限內完成匯款，之後若在 app.redrocktaiwan.com 註冊會員（用同一支電話），此報名會自動歸入您的帳號。',
      });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

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

      // 🧪 模擬報名：短路，不建真實報名（不佔名額）
      if (registrantData?.isSimulation) return res.json(await require('../services/simulationService').handleSimulatedRegistration(getDb(), { type: 'competition', member: { ...registrantData, id: memberId, email: regEmail }, targetId: req.params.id, payload: req.body }));

      if (req.body.paymentMethod === 'transfer') {
        if (!String(req.body.bankLastFive || '').trim()) return res.status(400).json({ error: 'MISSING_BANK_LAST_FIVE', message: '請填寫匯款帳號末五碼' });
        if (!String(req.body.paymentDate || '').trim()) return res.status(400).json({ error: 'MISSING_PAYMENT_DATE', message: '請填寫轉帳日期' });
      }
      const registration = await competitionService.registerForCompetition({
        competitionId: req.params.id,
        memberId,
        memberName: req.body.memberName || req.member?.name,
        isMinor: req.body.isMinor, // 僅供前端相容傳入；後端會用 birthday+比賽當天權威重算並覆寫，不採用此值
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
        memberNote: req.body.memberNote,
        partnerGymId: req.body.partnerGymId,
        paidAmount: req.body.paidAmount,
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
      // 報名收到通知信（比賽；非同步、失敗不阻斷）
      try {
        const _rn = require('../services/registrationNotify');
        const compDoc = await getDb().collection('competitions').doc(req.params.id).get();
        const comp = compDoc.exists ? compDoc.data() : {};
        _rn.notifyRegReceived({
          to: registration.email, memberId, memberName: registration.memberName || '',
          typeLabel: '比賽', itemName: comp.name || '比賽', gymId: comp.gymId,
          fee: registration.registrationFee || 0,
          paymentMethod: registration.paymentMethod || req.body.paymentMethod, massage: false,
        });
      } catch (e) { console.error('[Email] 比賽報名通知', e.message); }

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
        '身高','臂展','組別','榮譽參賽','友館折扣','報名費',
        '付款狀態','匯款銀行','匯款/繳款日期','匯款末五碼',
        '簽署狀態','是否候補','備註','員工備註','報名時間'
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
          `"${r.isPartnerGymDiscount ? `${r.partnerGym || '友館'}${r.partnerGymPending ? '(待核對)' : ''}` : ''}"`,
          r.registrationFee || '',
          paid,
          r.paymentMethod === 'cash' ? '臨櫃繳款' : `"${r.bankName || ''}"`,
          r.paymentDate || '',
          r.paymentMethod === 'cash' ? '' : (r.bankLastFive || ''),
          signed,
          r.status === 'waitlist' ? '是' : '否',
          `"${(r.memberNote || r.customFieldValues?.notes || '').replace(/"/g, '""')}"`,
          `"${(r.staffNote || '').replace(/"/g, '""')}"`,
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

// ── GET /competitions/:id/insurance-roster/download - 簽到表暨保險名冊（xlsx｜pdf，?format= 指定，預設 xlsx）──
// 正取（confirmed）報名，依組別→姓名排序，成人/未成年分開（isMinor，18歲門檻）；未成年含參賽者+法定代理人簽名。
router.get('/:id/insurance-roster/download',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const { buildCompetitionInsuranceRosterData } = require('../services/competitionInsuranceRosterService');
      const data = await buildCompetitionInsuranceRosterData(req.params.id);
      const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
      const filenameBase = `insurance_roster_${req.params.id}`;
      if (format === 'pdf') {
        const { buildCompetitionInsurancePdfBuffer } = require('../utils/competitionInsurancePdf');
        const buf = await buildCompetitionInsurancePdfBuffer(data);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
        res.send(buf);
      } else {
        const { buildCompetitionInsuranceXlsxBuffer } = require('../utils/competitionInsuranceXlsx');
        const buf = await buildCompetitionInsuranceXlsxBuffer(data);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
        res.send(buf);
      }
    } catch (err) {
      if (err.code) return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
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
      // 作廢連動的待確認轉帳單（避免取消後仍殘留在待收款）
      try {
        const trs = await db.collection('transferRecords').where('refId', '==', req.params.regId).get();
        const b = db.batch();
        trs.docs.forEach(t => { if (t.data().status === 'pending') b.update(t.ref, { status: 'cancelled', updatedAt: new Date() }); });
        await b.commit();
      } catch (e) { console.error('取消作廢轉帳單失敗', e.message); }

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
      // 比賽確認收款通知信（非同步、失敗不阻斷）
      try {
        const compDoc2 = await db.collection(COLLECTIONS.COMPETITIONS || 'competitions').doc(reg.competitionId).get();
        const comp2 = compDoc2.exists ? compDoc2.data() : {};
        require('../services/registrationNotify').notifyRegConfirmed({
          to: reg.email, memberId: reg.memberId, memberName: reg.name || reg.memberName || '',
          typeLabel: '比賽', itemName: comp2.name || reg.competitionName || '比賽', gymId: comp2.gymId, massage: false,
        });
      } catch (e) { console.error('[Email] 比賽確認通知', e.message); }
      res.json({ success: true, message: '已確認收款' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /competitions/registrations/:regId/verify-partner-gym - 友館折扣人工核對（值班/管理員）──
// approved:true → 清 pending（核對通過、維持折後價）；false → 移除友館折扣、重算費用（隊員擇優/否則原價）。
router.post('/registrations/:regId/verify-partner-gym',
  authenticate,
  async (req, res) => {
    try {
      const db = getDb();
      const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
      const isStationMode = ['operator', 'station'].includes(req.staff?.type);
      if (!isManager && !isStationMode) return res.status(403).json({ error: 'MANAGER_OR_STATION_REQUIRED', message: '友館折扣核對限值班人員或管理員' });
      const ref = db.collection('competitionRegistrations').doc(req.params.regId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = doc.data();
      if (!reg.isPartnerGymDiscount) return res.status(400).json({ error: 'NO_PARTNER_DISCOUNT', message: '此報名未使用友館折扣' });

      if (req.body.approved) {
        await ref.update({ partnerGymPending: false, partnerGymVerifiedBy: req.staff.id, partnerGymVerifiedAt: new Date(), updatedAt: new Date() });
        return res.json({ success: true, message: '友館折扣已核准' });
      }
      // 駁回：移除友館折扣、重算費用（隊員擇優，否則原價）——呼叫單一真相函式，partnerGymId 傳 null 即排除友館候選
      const comp = (await db.collection('competitions').doc(reg.competitionId).get()).data() || {};
      const quote = await competitionService.computeCompetitionFee({
        competition: comp, birthday: reg.birthday, memberId: reg.memberId, partnerGymId: null,
      });
      await ref.update({
        isPartnerGymDiscount: false, partnerGym: null, partnerGymPending: false,
        partnerGymRejectedBy: req.staff.id, partnerGymRejectedAt: new Date(),
        registrationFee: quote.registrationFee, isTeamDiscount: quote.teamDiscountApplied, updatedAt: new Date(),
      });
      res.json({ success: true, message: '友館折扣已取消，費用改回', registrationFee: quote.registrationFee });
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
        wasReturned: true, lastReturnType: 'payment', lastReturnReason: reason,
        lastReturnByName: req.staff?.name || '', lastReturnAt: new Date(),
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
    if (paymentMethod === 'transfer' && !String(req.body.bankLastFive || '').trim()) return res.status(400).json({ error: 'MISSING_BANK_LAST_FIVE', message: '請填寫匯款帳號末五碼' });
    if (paymentDate < today || paymentDate > maxDate) return res.status(400).json({ error: 'INVALID_PAYMENT_DATE', message: '繳費日期須為 3 日內' });
    await ref.update({
      paymentMethod,
      paymentDate,
      bankName: paymentMethod === 'transfer' ? (String(req.body.bankName || '').trim() || null) : null,
      bankLastFive: paymentMethod === 'transfer' ? (String(req.body.bankLastFive || '').trim() || null) : null,
      memberPaidAmount: req.body.paidAmount ? Number(req.body.paidAmount) : null, // 會員自填實際匯款金額
      paymentStatus: 'pending',
      paymentRejectReason: null,
      paymentRejectedAt: null,
      updatedAt: new Date(),
    });
    res.json({ success: true, message: '繳費資訊已更新，請等待館方確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /competitions/registrations/:regId/dismiss-rejection - 會員手動關閉「已駁回」首頁通知 ──
// 「知道了」按鈕；獨立於 10 天時間窗自動消失（見 members.js /my/alerts），任一條件成立即消失。
router.post('/registrations/:regId/dismiss-rejection', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const reg = doc.data();
    const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能關閉自己或子會員的通知' });
    if (deny) return res.status(deny.status).json(deny.body);
    await ref.update({ rejectedAlertDismissed: true, updatedAt: new Date() });
    res.json({ success: true });
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
        wasReturned: true, lastReturnType: 'form', lastReturnReason: reason,
        lastReturnByName: req.staff?.name || '', lastReturnAt: new Date(),
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
      // 作廢連動的待確認轉帳單（避免駁回後仍殘留在待收款）
      try {
        const trs = await db.collection('transferRecords').where('refId', '==', req.params.regId).get();
        const b = db.batch();
        trs.docs.forEach(t => { if (t.data().status === 'pending') b.update(t.ref, { status: 'cancelled', updatedAt: new Date() }); });
        await b.commit();
      } catch (e) { console.error('駁回作廢轉帳單失敗', e.message); }
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
    // 後端權威重算費用——單一真相函式（生日→兒童、早鳥、隊員9折/友館折擇優皆在其中，
    // 與 registerForCompetition／quote 端點共用一份邏輯，避免各處各自複製一份日後漏同步）。
    // 友館沿用原報名選定的 reg.partnerGymId（此表單不可改友館，核對狀態不變）。
    const quote = await competitionService.computeCompetitionFee({
      competition: comp, birthday: b.birthday, memberId: reg.memberId, partnerGymId: reg.partnerGymId || null,
    });
    const isEarly = quote.isEarlyBird;
    const isChild = quote.isChild;
    const isMinorNow = quote.isMinor;
    const registrationFee = quote.registrationFee;
    const insuranceFee = quote.insuranceFee;
    const feTeamDiscount = quote.teamDiscountApplied;
    const fePartner = quote.partnerGymApplied;
    const fePartnerName = fePartner ? quote.partnerGymName : (reg.partnerGym || null);

    // 繳費資訊（退回修改一併可改；已確認收款者不動；末五碼+日期必填）
    let paymentUpdate = {};
    if (reg.paymentStatus !== 'confirmed' && b.paymentMethod) {
      const pm = b.paymentMethod;
      if (!['cash', 'transfer'].includes(pm)) return res.status(400).json({ error: 'INVALID_METHOD', message: '付款方式須為現金或轉帳' });
      const pDate = String(b.paymentDate || '').trim();
      if (!pDate) return res.status(400).json({ error: 'MISSING_PAYMENT_DATE', message: '請填寫繳費日期' });
      if (pm === 'transfer' && !String(b.bankLastFive || '').trim()) return res.status(400).json({ error: 'MISSING_BANK_LAST_FIVE', message: '請填寫匯款帳號末五碼' });
      paymentUpdate = {
        paymentMethod: pm,
        paymentDate: pDate,
        bankName: pm === 'transfer' ? (String(b.bankName || '').trim() || null) : null,
        bankLastFive: pm === 'transfer' ? String(b.bankLastFive).trim() : null,
        paymentStatus: 'pending',
        paymentRejectReason: null, paymentRejectedAt: null,
      };
    }

    await ref.update({
      ...paymentUpdate,
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
      memberNote: b.memberNote || null,
      registrationFee, isEarlyBird: !!isEarly, isTeamDiscount: feTeamDiscount,
      isPartnerGymDiscount: fePartner, partnerGym: fePartner ? fePartnerName : null,
      partnerGymPending: fePartner ? (reg.partnerGymPending !== false) : false,
      insuranceFee, isChild: !!isChild,
      receivedAmountOverride: null, // 生日/身分可能改變（成人⇄兒童）→ 清除手動覆蓋，回歸依新保費自動計算
      // 生日可能被改成使報名對象變成/不再是未成年（以比賽當天為基準重算）；
      // 若變成未成年而先前沒有法代簽名，isComplete 標 false（擋計分系統推送，等家長簽署），不擋這次表單修改本身
      isMinor: isMinorNow, parentRequired: isMinorNow,
      isComplete: !isMinorNow || !!reg.guardianSignatureUrl,
      // 清除退回旗標
      formReturned: false, formReturnReason: null, formReturnedAt: null,
      updatedAt: new Date(),
    });
    res.json({ success: true, message: '報名資料已更新，請等待館方確認' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /competitions/registrations/:regId/reregister - 逾期取消後用原資料重新報名（免重填、免重簽）──
router.post('/registrations/:regId/reregister', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const reg = doc.data();
    const deny = await checkMemberOwnership(req.member, reg.memberId, { onMissing: 403, message: '只能操作自己或子會員的報名' });
    if (deny) return res.status(deny.status).json(deny.body);
    if (!(reg.status === 'cancelled' && reg.cancelReason === 'payment_expired')) {
      return res.status(400).json({ error: 'NOT_EXPIRED', message: '此報名非逾期取消，無法重新報名' });
    }
    const comp = (await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get()).data();
    if (!comp) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到賽事' });
    if (comp.status !== 'open') return res.status(400).json({ error: 'REGISTRATION_CLOSED', message: '此賽事目前未開放報名' });
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    if (comp.registrationEnd && today > comp.registrationEnd) return res.status(400).json({ error: 'REGISTRATION_ENDED', message: '報名期限已截止' });
    const division = (comp.divisions || []).find(d => d.id === reg.divisionId);
    if (!division) return res.status(400).json({ error: 'INVALID_DIVISION', message: '原組別已不存在，請重新報名' });
    // 費用重算（單一真相函式，沿用原生日；早鳥/兒童/隊員9折/友館折擇優皆在其中）
    const dayjs = require('dayjs');
    const quote = await competitionService.computeCompetitionFee({
      competition: comp, birthday: reg.birthday, memberId: reg.memberId, partnerGymId: reg.partnerGymId || null,
    });
    const isEarly = quote.isEarlyBird;
    const isChild = quote.isChild;
    const isMinorNow = quote.isMinor;
    const registrationFee = quote.registrationFee;
    const insuranceFee = quote.insuranceFee;
    const rrTeamDiscount = quote.teamDiscountApplied;
    const rrPartner = quote.partnerGymApplied;
    const rrPartnerName = rrPartner ? quote.partnerGymName : (reg.partnerGym || null);
    const N = comp.paymentDeadlineDays || 3;
    const now = new Date();
    let finalStatus, waitlistPosition = null;
    await db.runTransaction(async (tx) => {
      // 去重：不可已有其他有效報名
      const dupTx = await tx.get(db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).where('competitionId', '==', reg.competitionId).where('memberId', '==', reg.memberId));
      if (dupTx.docs.some(d => d.id !== req.params.regId && d.data().status !== 'cancelled')) throw { code: 'ALREADY_REGISTERED', message: '您已有此賽事的有效報名' };
      // 容量
      const snap = await tx.get(db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).where('competitionId', '==', reg.competitionId).where('divisionId', '==', reg.divisionId).where('status', 'in', ['confirmed', 'waitlist']));
      const cCount = snap.docs.filter(d => d.data().status === 'confirmed').length;
      const wCount = snap.docs.filter(d => d.data().status === 'waitlist').length;
      const maxP = division.maxParticipants || 40, wMax = division.waitlistMax || 5;
      if (cCount >= maxP && wCount >= wMax) throw { code: 'DIVISION_FULL', message: '組別已滿（含候補），無法重新報名' };
      const willWaitlist = cCount >= maxP;
      finalStatus = willWaitlist ? 'waitlist' : 'confirmed';
      waitlistPosition = willWaitlist ? wCount + 1 : null;
      const update = {
        status: finalStatus, waitlistPosition,
        paymentStatus: 'pending', registrationFee, isEarlyBird: !!isEarly, isTeamDiscount: rrTeamDiscount,
        isPartnerGymDiscount: rrPartner, partnerGym: rrPartner ? rrPartnerName : null, partnerGymPending: rrPartner,
        insuranceFee, isChild: !!isChild, receivedAmountOverride: null,
        // 重報時間點可能已跨過 18/childAgeLimit 歲生日（沿用原生日、以比賽當天重算）
        isMinor: isMinorNow, parentRequired: isMinorNow,
        isComplete: !isMinorNow || !!reg.guardianSignatureUrl,
        cancelReason: null, paymentExpiredAt: null, cancelledAt: null,
        bankLastFive: null, bankName: null, paymentDate: null,   // 需重新繳費
        reregisteredAt: now, updatedAt: now,
        paymentDeadline: (!willWaitlist && registrationFee > 0) ? dayjs(now).add(N, 'day').toDate() : null,
      };
      tx.update(ref, update);
    });
    // 正取且已完成簽署 → 重新推送計分系統
    if (finalStatus === 'confirmed' && reg.isComplete) { try { await competitionService.sendWebhook(req.params.regId); } catch (e) {} }
    res.json({ success: true, status: finalStatus, waitlistPosition, message: finalStatus === 'waitlist' ? '已重新報名（候補）' : '已重新報名，請於繳款期限內完成繳費' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /competitions/registrations/:regId/refund - 退費 ──
router.post('/registrations/:regId/refund',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const regRef = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations').doc(req.params.regId);
      const regDoc = await regRef.get();
      if (!regDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名記錄' });
      await regRef.update({
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
      // 退費 → 自動連動作廢已開立發票（§4.1.3 同款，比照課程退費/入場/商品/租借；2026-08-10 定案：
      // 僅該館已開啟「發票列印」才會做，關閉時維持此功能上線前的原本行為）
      let invoiceVoided = false;
      try {
        const { isInvoicePrintingEnabled, voidRealInvoiceIfIssued } = require('./invoices');
        if (await isInvoicePrintingEnabled(db, regDoc.data().gymId)) {
          const invoiceService = require('../services/invoiceService');
          try {
            const legacyInv = await invoiceService.getActiveInvoice(db, 'competition', req.params.regId);
            if (legacyInv) { await invoiceService.voidInvoice(db, legacyInv.id, req.staff.id, req.staff.name, '比賽退費自動作廢'); invoiceVoided = true; }
          } catch (e) { console.error('[比賽退費連動作廢-手動記帳發票]', e.message); }
          try {
            const realInv = await voidRealInvoiceIfIssued(db, { sourceType: 'competition', refId: req.params.regId }, req.staff.id, req.staff.name, '比賽退費自動作廢');
            if (realInv) invoiceVoided = true;
          } catch (e) { console.error('[比賽退費連動作廢-真實發票]', e.message); }
        }
      } catch (e) { console.error('[比賽退費連動作廢]', e.message); }
      res.json({ success: true, invoiceVoided, message: `退費已處理${invoiceVoided ? '，發票已自動作廢' : ''}` });
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
      registrationId: reg.id, memberId: reg.memberId, memberName: reg.memberName,
      competitionId: reg.competitionId, competitionName: reg.competitionName || comp.name, divisionName: reg.divisionName,
      eventDate: comp.eventDate, gymId: comp.gymId || null, status: reg.status, isComplete: reg.isComplete,
      paymentStatus: reg.paymentStatus, paymentMethod: reg.paymentMethod || null, registrationFee: reg.registrationFee, insuranceFee: reg.insuranceFee ?? null,
      // 實收金額（供開立發票 modal 使用）：管理員編修 > 匯款確認金額-保費 > 會員自報金額-保費 > 應繳費用-保費
      receivedAmount: competitionService.computeNetReceivedAmount(reg),
      checkedInAt: reg.checkedInAt || null,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /competitions/registrations/:regId/received-amount - 直接編修「實收金額」（管理員）──
// 覆蓋後優先於自動計算（匯款確認金額－保費）；供查看名單/開發票 modal 共用。
router.put('/registrations/:regId/received-amount', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const raw = req.body.amount;
    const amount = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
    if (amount !== null && (isNaN(amount) || amount < 0)) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: '實收金額需為 0 或正數' });
    }
    const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此報名紀錄' });
    await ref.update({ receivedAmountOverride: amount, receivedAmountEditedBy: req.staff.id, receivedAmountEditedAt: new Date(), updatedAt: new Date() });
    res.json({ success: true, receivedAmountOverride: amount });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /registrations/:regId/admin-update - 館方人工更正報名資料（目前支援組別/榮譽參賽）
// 供已確認/已收款的報名事後需要修正組別、或標記為榮譽參賽時使用（非會員自助流程，不影響
// 費用/收款狀態，也不透過退回修改那套流程）。異動後系統自動寄信通知會員。
router.post('/registrations/:regId/admin-update',
  authenticate, checkPermission('competitions.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
      const reg = doc.data();
      const compDoc = await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get();
      const comp = compDoc.data();
      if (!comp) return res.status(404).json({ error: 'COMPETITION_NOT_FOUND', message: '找不到對應賽事' });

      const updates = { updatedAt: new Date() };
      const oldDivisionName = reg.divisionName;
      let newDivisionName = reg.divisionName;
      if (req.body.divisionId && req.body.divisionId !== reg.divisionId) {
        const division = (comp.divisions || []).find(d => d.id === req.body.divisionId);
        if (!division) return res.status(400).json({ error: 'INVALID_DIVISION', message: '組別不正確' });
        updates.divisionId = division.id;
        updates.divisionName = division.name;
        newDivisionName = division.name;
      }
      if (req.body.isHonorary !== undefined) updates.isHonorary = !!req.body.isHonorary;

      await ref.update(updates);

      // 異動通知信（系統自動寄；寄信失敗不影響資料已更新成功）
      if (reg.email) {
        emailService.sendCompetitionRegistrationModified(reg.email, {
          memberName: reg.memberName, competitionName: comp.name,
          oldDivisionName, newDivisionName,
          isHonorary: updates.isHonorary !== undefined ? updates.isHonorary : reg.isHonorary,
        }).catch(() => {});
      }

      res.json({ success: true, message: '報名資料已更新，已寄送異動通知' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── 比賽報名開立發票（預先建立，待日後發票機串接）─────────────────────
// 與課程學員發票共用 invoiceService（sourceType:'competition'，refId=registrationId）：
// 同一報名同時最多一張已開立發票，須先作廢才能重新開立。
router.get('/registrations/:regId/invoices', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('invoiceRecords')
      .where('sourceType', '==', 'competition').where('refId', '==', req.params.regId).get();
    const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.issuedAt?._seconds || 0) - (a.issuedAt?._seconds || 0));
    res.json({ invoices });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// 2026-08-17 放寬值班站台可開（原僅管理員，與入場/補租/租借三個發票流程對齊；金額實收覆蓋
// PUT /registrations/:regId/received-amount 仍維持 requireManager，未一併放寬）。
router.post('/registrations/:regId/invoices', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const regDoc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(req.params.regId).get();
    if (!regDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到報名' });
    const reg = regDoc.data();
    const compDoc = await db.collection(COLLECTIONS.COMPETITIONS).doc(reg.competitionId).get();
    const comp = compDoc.exists ? compDoc.data() : {};
    const { itemName, amount, taxId, note, issuedAt, track, number } = req.body;
    await require('./invoices').checkInvoiceIssuanceTiming(db, 'competition', req.params.regId); // 須賽事前3天起才能開票
    const invoiceService = require('../services/invoiceService');
    const record = await invoiceService.createInvoice(db, {
      sourceType: 'competition', refId: req.params.regId,
      memberId: reg.memberId, memberName: reg.memberName || '',
      itemName: itemName || `${reg.competitionName || comp.name || '比賽'}報名費`,
      amount, taxId, note, gymId: comp.gymId || null, issuedAt, track, number,
      staffId: req.staff.id, staffName: req.staff.name || '',
      meta: { registrationId: req.params.regId, competitionId: reg.competitionId, competitionName: reg.competitionName || comp.name || '', divisionName: reg.divisionName || '' },
    });
    res.json({ success: true, invoice: record });
  } catch (err) {
    const map = { INVALID_AMOUNT: 400, MISSING_FIELDS: 400, ALREADY_INVOICED: 400, INVALID_TRACK: 400, INVALID_NUMBER: 400, INVALID_TAX_ID: 400, INVOICE_TOO_EARLY: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// 2026-08-17 放寬值班站台可作廢（原僅管理員）
router.post('/invoices/:id/void', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const invoiceService = require('../services/invoiceService');
    await invoiceService.voidInvoice(db, req.params.id, req.staff.id, req.staff.name, req.body.voidReason);
    res.json({ success: true });
  } catch (err) {
    const map = { NOT_FOUND: 404, ALREADY_VOIDED: 400 };
    if (err.code && map[err.code]) return res.status(map[err.code]).json({ error: err.code, message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
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
