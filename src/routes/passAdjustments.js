/**
 * 定期票異動管理路由（編輯/展延/退費/轉讓/年假批次展延）
 */
const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAny, requireManagerOrStation } = require('../middleware/auth');
const passAdjustmentService = require('../services/passAdjustmentService');
const { getStorage, getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

// ── GET /pass-adjustments/reasons - 取得可選事由清單 ────────────────
router.get('/reasons', authenticateAny, (req, res) => {
  res.json({ reasons: passAdjustmentService.REQUEST_REASONS });
});

// ── POST /pass-adjustments/evidence - 上傳證明文件 ──────────────────
router.post('/evidence', authenticateAny, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請選擇檔案' });
    // 只允許圖片/PDF；副檔名與 contentType 由 MIME 白名單決定（不採信使用者檔名，避免上傳 .html/.exe 等公開檔案）
    const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
    const ext = MIME_EXT[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'UNSUPPORTED_TYPE', message: '僅支援 JPG / PNG / WEBP / PDF' });
    const bucket = getStorage().bucket();
    const fileName = `pass-requests/evidence_${uuidv4()}.${ext}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, { contentType: req.file.mimetype });
    // 物件保持私有，回傳長效簽名 URL（比照 transfers 截圖；需簽章不可猜，非公開）
    const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'UPLOAD_FAILED', message: err.message });
  }
});

// ── GET /pass-adjustments/history/:passId - 查詢某張票的異動歷史 ─────
router.get('/history/:passId', authenticateAny, async (req, res) => {
  try {
    const history = await passAdjustmentService.getPassAdjustmentHistory(req.params.passId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── PUT /pass-adjustments/:passId/edit - 員工直接編輯（僅管理員/館別電腦）──
router.put('/:passId/edit',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const pass = await passAdjustmentService.editPass({
        passId: req.params.passId,
        updates: req.body,
        reason: req.body.reason,
        operatorId: req.staff.id,
        operatorName: req.staff.name,
      });
      res.json({ pass, message: '定期票已更新' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ══════════════════════════════════════════════════════
// 會員申請（展延/退費/轉讓）
// ══════════════════════════════════════════════════════

router.post('/requests',
  authenticateAny,
  [
    body('passId').notEmpty().withMessage('缺少定期票ID'),
    body('type').isIn(['extension', 'refund', 'transfer']).withMessage('type 必須為 extension、refund 或 transfer'),
    body('reasonKey').notEmpty().withMessage('請選擇事由'),
    body('evidenceUrl').notEmpty().withMessage('請上傳證明文件'),
  ],
  validate,
  async (req, res) => {
    try {
      // 會員 token 一律用自己的 id，避免帶他人 memberId+passId 繞過擁有權檢查（IDOR）
      const memberId = req.member ? req.member.id : req.body.memberId;
      if (!memberId) return res.status(400).json({ error: 'MISSING_MEMBER' });
      const request = await passAdjustmentService.createPassRequest({
        passId: req.body.passId, memberId,
        type: req.body.type, reasonKey: req.body.reasonKey,
        reasonDetail: req.body.reasonDetail, evidenceUrl: req.body.evidenceUrl,
        transferToPhone: req.body.transferToPhone,
        transferToMemberId: req.body.transferToMemberId,
        suspendStart: req.body.suspendStart, suspendEnd: req.body.suspendEnd,
      });
      res.status(201).json({ request, message: '申請已送出，請等待審核' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.get('/requests/member/:memberId', authenticateAny, async (req, res) => {
  try {
    if (req.member && req.member.id !== req.params.memberId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '只能查看自己的申請' });
    }
    const requests = await passAdjustmentService.getMemberPassRequests(req.params.memberId);
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── GET /pass-adjustments/requests - 所有申請（員工審核用，僅管理員/館別電腦）──
router.get('/requests', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const requests = await passAdjustmentService.getAllPassRequests(req.query.status);
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /pass-adjustments/requests/:id/approve - 核准申請（僅管理員/館別電腦）──
router.post('/requests/:id/approve',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      // 申請可能在 passRequests（展延/退費/轉讓）或 passAdjustments（課程練習期遞延），兩處都找
      let reqRef = db.collection(COLLECTIONS.PASS_REQUESTS).doc(req.params.id);
      let reqDoc = await reqRef.get();
      if (!reqDoc.exists) {
        reqRef = db.collection(COLLECTIONS.PASS_ADJUSTMENTS).doc(req.params.id);
        reqDoc = await reqRef.get();
      }
      if (!reqDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
      const request = reqDoc.data();

      // 課程練習期遞延特殊處理
      if (request.type === 'course_practice_deferral') {
        if (request.status !== 'pending') return res.status(400).json({ code: 'ALREADY_PROCESSED', message: '此申請已處理' });
        await db.collection(COLLECTIONS.MEMBER_PASSES).doc(request.passId).update({ endDate: request.proposedEndDate, updatedAt: new Date() });
        await reqRef.update({
          status: 'approved', approvedBy: req.staff.id, approvedByName: req.staff.name, approvedAt: new Date(), updatedAt: new Date(),
        });
        await passAdjustmentService.logAdjustment({
          passId: request.passId, type: 'course_practice_deferral',
          beforeData: { endDate: request.currentEndDate },
          afterData: { endDate: request.proposedEndDate, remainingDays: request.remainingDays },
          reason: request.reason, operatorId: req.staff.id, operatorName: req.staff.name,
          operatorType: 'staff', memberName: request.memberName, memberId: request.memberId,
        });
        return res.json({ success: true, message: `定期票已遞延至 ${request.proposedEndDate}` });
      }

      const result = await passAdjustmentService.approvePassRequest({
        requestId: req.params.id,
        operatorId: req.staff.id, operatorName: req.staff.name,
        extensionMonths: req.body.extensionMonths,
        hasInvoice: req.body.hasInvoice,
      });
      res.json({ ...result, message: '申請已核准' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /pass-adjustments/requests/:id/reject - 拒絕申請（僅管理員/館別電腦）──
router.post('/requests/:id/reject',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const result = await passAdjustmentService.rejectPassRequest({
        requestId: req.params.id,
        operatorId: req.staff.id,
        rejectReason: req.body.rejectReason,
      });
      res.json({ ...result, message: '申請已拒絕' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ══════════════════════════════════════════════════════
// 年假批次展延（僅管理員/館別電腦）
// ══════════════════════════════════════════════════════

router.post('/holiday-batch',
  authenticate, requireManagerOrStation,
  [body('holidayRanges').isArray({ min: 1 }).withMessage('請至少設定一個場館的假期區間')],
  validate,
  async (req, res) => {
    try {
      const result = await passAdjustmentService.runHolidayBatchExtension({
        holidayRanges: req.body.holidayRanges,
        operatorId: req.staff.id, operatorName: req.staff.name,
      });
      res.json({ ...result, message: `已為 ${result.extendedCount} 張定期票展延（共檢查 ${result.totalPasses} 張有效票）` });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /pass-adjustments/holiday-history - 年假批次展延歷史 ────────
router.get('/holiday-history',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      const snap = await db.collection(COLLECTIONS.PASS_ADJUSTMENTS)
        .where('type', '==', 'holiday_batch')
        .get();
      const records = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const aT = a.createdAt?._seconds || a.createdAt?.seconds || 0;
          const bT = b.createdAt?._seconds || b.createdAt?.seconds || 0;
          return bT - aT;
        });
      // 依 operatorId + createdAt 分組，代表同一次批次操作
      const groups = {};
      for (const r of records) {
        const key = `${r.operatorId}_${r.createdAt?._seconds || r.createdAt?.seconds || 0}`;
        if (!groups[key]) groups[key] = { key, operatorName: r.operatorName, createdAt: r.createdAt, items: [] };
        groups[key].items.push(r);
      }
      res.json({ history: Object.values(groups).sort((a, b) => {
        const aT = a.createdAt?._seconds || a.createdAt?.seconds || 0;
        const bT = b.createdAt?._seconds || b.createdAt?.seconds || 0;
        return bT - aT;
      })});
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;

// ── GET /pass-adjustments/analytics - 票券統計（管理員/值班）──
// 含全館會員卡片個資（姓名/手機/卡號）→ 限值班 operator 或 gym_manager/super_admin（與 UI tab gate 一致）
router.get('/analytics', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const today = taiwanToday();

    const [passSnap, discountSnap, blackSnap, ticketSnap, bonusSnap] = await Promise.all([
      db.collection(COLLECTIONS.MEMBER_PASSES).get(),
      db.collection('discountCards').get(),
      db.collection('legacyBlackCards').get(),
      db.collection('singleEntryTickets').get(),
      db.collection('memberBonuses').get(),
    ]);

    // 定期票
    const passes = passSnap.docs.map(d => d.data());
    const passStats = {
      total: passes.length,
      active: passes.filter(p => p.status === 'active' && p.endDate >= today).length,
      expired: passes.filter(p => p.endDate < today).length,
      cancelled: passes.filter(p => p.status === 'cancelled').length,
      byType: {},
    };
    passes.forEach(p => {
      const t = p.passTypeName || '未知';
      if (!passStats.byType[t]) passStats.byType[t] = { active:0, expired:0, cancelled:0 };
      if (p.status === 'cancelled') passStats.byType[t].cancelled++;
      else if (p.endDate < today) passStats.byType[t].expired++;
      else passStats.byType[t].active++;
    });

    // 卡片統計共用工具（卡上以 isActive/expiresAt 判定，非 status 欄位）
    const nowMs = Date.now();
    const tsMs = (ts) => ts?._seconds != null ? ts._seconds * 1000
      : (typeof ts?.toDate === 'function' ? ts.toDate().getTime() : null);
    const isExpired = (c) => { const ms = tsMs(c.expiresAt); return ms != null && ms < nowMs; };
    const isActiveCard = (c) => c.isActive === true && (c.remainingCredits || 0) > 0 && !isExpired(c);
    // 已發行次數：僅原始卡（移轉子卡的 originalCredits 會重複計算），預設格數 fallback
    const issuedOf = (arr, fallback) => arr
      .filter(c => c.source !== 'transferred')
      .reduce((s, c) => s + (c.originalCredits ?? fallback), 0);
    const cardStats = (arr, fallback) => {
      const total = arr.length;
      const totalCreditsIssued = issuedOf(arr, fallback);
      const totalCreditsRemaining = arr.reduce((s, c) => s + (c.remainingCredits || 0), 0);
      return {
        total,
        active: arr.filter(isActiveCard).length,
        fullyUsed: arr.filter(c => (c.remainingCredits || 0) === 0).length,
        expired: arr.filter(isExpired).length,
        totalCreditsIssued,
        totalCreditsUsed: Math.max(0, totalCreditsIssued - totalCreditsRemaining),
        totalCreditsRemaining,
      };
    };

    // 優惠卡（discountCards：ownerMemberId、預設 10 格）
    const discounts = discountSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const discountStats = cardStats(discounts, 10);

    // 黑卡（legacyBlackCards：memberId、預設 12 格、原始卡 expiresAt 可為 null=無期限）
    const blacks = blackSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blackStats = cardStats(blacks, 12);

    // 單日券
    const tickets = ticketSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ticketStats = {
      total: tickets.length,
      valid: tickets.filter(t => t.status === 'valid').length,
      used: tickets.filter(t => t.status === 'used').length,
      expired: tickets.filter(t => t.status === 'expired').length,
      pending: tickets.filter(t => t.status === 'pending').length,
    };

    // 紅利
    const bonuses = bonusSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const bonusStats = {
      total: bonuses.length,
      active: bonuses.filter(b => b.remainingDays > 0).length,
      totalDaysIssued: bonuses.reduce((s,b) => s + (b.totalDays||0), 0),
      totalDaysUsed: bonuses.reduce((s,b) => s + ((b.totalDays||0)-(b.remainingDays||0)), 0),
      totalDaysRemaining: bonuses.reduce((s,b) => s + (b.remainingDays||0), 0),
    };

    res.json({ passStats, discountStats, blackStats, ticketStats, bonusStats, generatedAt: new Date() });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /pass-adjustments/analytics/download - 下載詳細資料 CSV（管理員/值班）──
// 下載含會員姓名/手機/卡號 → 同上限管理員/值班（防個人 full/part 未值班帳號直打 API 撈全館個資）
router.get('/analytics/download', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { type } = req.query; // passes | discounts | blacks | tickets | bonuses
    const today = taiwanToday();

    let rows = [], headers = [], csvRows = [];

    if (type === 'passes' || !type) {
      const snap = await db.collection(COLLECTIONS.MEMBER_PASSES).get();
      headers = ['序號','會員姓名','票種','狀態','開始日','到期日','館別','備註'];
      rows = snap.docs.map((d,i) => {
        const p = d.data();
        const status = p.status==='cancelled'?'已取消':p.endDate<today?'已過期':p.status==='active'?'有效':'其他';
        return [i+1, `"${p.memberName||''}"`, `"${p.passTypeName||''}"`, status, p.startDate||'', p.endDate||'', p.gymId||'', `"${p.note||''}"`].join(',');
      });
    } else if (type === 'discounts' || type === 'blacks') {
      // 優惠卡存於 discountCards（ownerMemberId），黑卡存於 legacyBlackCards（memberId）。
      // 卡上未存姓名/電話 → 依 memberId 解析；卡號存於 barcode。
      const isBlack = type === 'blacks';
      const snap = await db.collection(isBlack ? 'legacyBlackCards' : 'discountCards').get();
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const idOf = (c) => isBlack ? c.memberId : c.ownerMemberId;

      const uniqIds = [...new Set(docs.map(idOf).filter(Boolean))];
      const nameMap = {};
      for (let i = 0; i < uniqIds.length; i += 50) {
        await Promise.all(uniqIds.slice(i, i + 50).map(async id => {
          const md = await db.collection(COLLECTIONS.MEMBERS).doc(id).get();
          if (md.exists) { const m = md.data(); nameMap[id] = { name: m.name || '', phone: m.phone || '' }; }
        }));
      }

      const tsMs = (ts) => ts?._seconds != null ? ts._seconds * 1000
        : (typeof ts?.toDate === 'function' ? ts.toDate().getTime() : (ts ? new Date(ts).getTime() : null));
      const fmtDate = (ts) => { const ms = tsMs(ts); return ms ? new Date(ms + 8 * 3600000).toISOString().slice(0, 10) : ''; };
      const gymLabel = (g) => g === 'gym-hsinchu' ? '新竹館' : g === 'gym-shilin' ? '士林館' : (g || '');
      const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const nowMs = Date.now();

      headers = ['序號','會員姓名','手機','卡號','狀態','剩餘格數','原始格數','已用格數',
        ...(isBlack ? [] : ['紅利已送']), '到期日','綁定日','館別'];
      rows = docs.map((c, i) => {
        const nm = nameMap[idOf(c)] || {};
        const remaining = c.remainingCredits ?? 0;
        const original = c.originalCredits ?? (isBlack ? 12 : 10);
        const expMs = tsMs(c.expiresAt);
        const status = remaining <= 0 ? '已用完'
          : (expMs != null && expMs < nowMs) ? '已過期'
          : c.isActive === false ? '已停用' : '有效';
        return [
          i + 1, csv(nm.name), csv(nm.phone), csv(c.barcode || ''), status,
          remaining, original, Math.max(0, original - remaining),
          ...(isBlack ? [] : [c.bonusTriggered ? '是' : '否']),
          expMs != null ? fmtDate(c.expiresAt) : '無期限',
          fmtDate(c.boundAt || c.purchasedAt), gymLabel(c.gymId),
        ].join(',');
      });
    } else if (type === 'tickets') {
      const snap = await db.collection('singleEntryTickets').get();
      headers = ['序號','會員姓名','狀態','有效期限','使用日期','核發人','核發館別'];
      rows = snap.docs.map((d,i) => {
        const t = d.data();
        return [i+1, `"${t.memberName||''}"`, t.status||'', t.expiryDate||'', t.usedAt?._seconds?new Date(t.usedAt._seconds*1000).toLocaleDateString('zh-TW'):'', `"${t.issuedByName||''}"`, t.gymId||''].join(',');
      });
    } else if (type === 'bonuses') {
      const snap = await db.collection('memberBonuses').get();
      headers = ['序號','會員姓名','剩餘天數','總天數','到期日'];
      rows = snap.docs.map((d,i) => {
        const b = d.data();
        return [i+1, `"${b.memberName||''}"`, b.remainingDays||0, b.totalDays||0, b.expiryDate||''].join(',');
      });
    }

    csvRows = ['\uFEFF' + headers.join(','), ...rows];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pass_analytics_${type||'all'}_${today}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
