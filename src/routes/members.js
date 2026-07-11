const { taiwanToday } = require('../utils/taiwanDate');
const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, authenticateAny, checkPermission, requireSameGym, auditLog, requireManagerOrStation } = require('../middleware/auth');
const memberService = require('../services/memberService');
const waiverService = require('../services/waiverService');
const { checkMemberOwnership } = require('../utils/memberOwnership');
const { getDb, COLLECTIONS } = require('../config/firebase');
const dayjs = require('dayjs');
const XLSX = require('xlsx');
const { sanitizeSheet } = require('../utils/xlsxSafe');

// ── 驗證錯誤處理 ──────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  }
  next();
};

// ── GET /members - 搜尋/列出會員 ────────────────────────────────
router.get('/',
  authenticate,
  checkPermission('members.read'),
  async (req, res) => {
    try {
      const { q, gymId, type, status, limit } = req.query;
      const members = await memberService.searchMembers({
        query: q,
        gymId: req.staff.role === 'super_admin' ? gymId : req.staff.gymId,
        limit: Math.min(parseInt(limit) || 50, 200), // 上限 200，避免超大 limit 造成 DoS
      });
      res.json({ members, count: members.length });
    } catch (err) {
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /members/my/children - 會員查詢自己的子會員 ────────────────
router.get('/my/children', authenticateAny, async (req, res) => {
  try {
    const memberId = req.member?.id;
    if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const db = getDb();
    // 子會員判定以 parentMemberId 為準（唯一定義關係）；不再要求 isChildAccount:true，
    // 避免有 parentMemberId 但漏設旗標的子會員在家長「我的票券/課程」看不到、無法代操作。
    const snap = await db.collection(COLLECTIONS.MEMBERS)
      .where('parentMemberId', '==', memberId)
      .get();
    const children = snap.docs.map(d => {
      const { phone, email, ...rest } = d.data();
      return { id: d.id, ...rest };
    });
    res.json({ children });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /members/my/children - 會員自行新增子會員 ─────────────────
router.post('/my/children',
  authenticateAny,
  [
    body('name').trim().notEmpty().withMessage('請填寫子會員姓名'),
    body('birthday').notEmpty().withMessage('請填寫生日').isDate().withMessage('生日格式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const memberId = req.member?.id;
      if (!memberId) return res.status(401).json({ error: 'UNAUTHORIZED' });

      const parent = await memberService.getMember(memberId);
      if (!parent) return res.status(404).json({ error: 'PARENT_NOT_FOUND' });

      // 家庭成員僅限未滿 18 歲（滿 18 歲應註冊正式會員）
      if (req.body.birthday && dayjs().diff(dayjs(req.body.birthday), 'year') >= 18) {
        return res.status(400).json({ code: 'AGE_RESTRICTION', message: '家庭成員僅限未滿 18 歲，滿 18 歲請註冊正式會員' });
      }

      const db = getDb();
      const existing = await db.collection(COLLECTIONS.MEMBERS)
        .where('parentMemberId', '==', memberId)
        .where('isChildAccount', '==', true)
        .get();
      if (existing.size >= 5) {
        return res.status(400).json({ code: 'TOO_MANY_CHILDREN', message: '最多可新增 5 位家庭成員' });
      }

      const child = await memberService.createMember({
        name: req.body.name.trim(),
        birthday: req.body.birthday || null,
        gender: req.body.gender || null,
        phone: parent.phone,
        email: parent.email,
      }, null, {
        isChildAccount: true,
        parentMemberId: memberId,
      });

      res.status(201).json({ child, message: `${req.body.name} 已加入家庭成員` });
    } catch (err) {
      if (['AGE_UNDER_5', 'AGE_RESTRICTION'].includes(err.code)) return res.status(400).json(err);
      res.status(500).json({ error: err.code || 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /members/reports/active-passes - 持有效定期票人員（分票種）──
router.get('/reports/active-passes', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const today = taiwanToday(); // 台灣日期（與入場資格判定同源）
    const gymId = req.staff.role === 'super_admin' ? (req.query.gymId || null) : req.staff.gymId;
    const snap = await db.collection(COLLECTIONS.MEMBER_PASSES).where('status', '==', 'active').get();
    // endDate 用臨時休館補償後的到期日（與入場資格 getValidPasses 同源）
    let passes = (await require('../services/passExpiryService').attachEffectiveEndDates(
      snap.docs.map(d => ({ id: d.id, ...d.data() }))
    )).filter(p => (p.effectiveEndDate || p.endDate || '') >= today);
    // 與入場資格 getValidPasses 同源：全館票(scope='shared')任館可用；單館票看 targetGymId
    if (gymId) passes = passes.filter(p => p.scope === 'shared' || p.targetGymId === gymId);
    // 姓名以 members 集合為權威補齊——定期票文件（POST /passes、seed）常未存 memberName，
    // 否則前端 `memberName || memberId` 會 fallback 顯示原始 memberId。
    const memberIds = [...new Set(passes.map(p => p.memberId).filter(Boolean))];
    const nameMap = {};
    if (memberIds.length) {
      const memberDocs = await db.getAll(...memberIds.map(id => db.collection(COLLECTIONS.MEMBERS).doc(id)));
      memberDocs.forEach(d => { if (d.exists) nameMap[d.id] = d.data().name || ''; });
    }
    const groups = {};
    passes.forEach(p => {
      const key = p.passTypeId || p.passTypeName || 'other';
      if (!groups[key]) groups[key] = { passTypeId: p.passTypeId || null, passTypeName: p.passTypeName || '定期票', members: [] };
      groups[key].members.push({ memberId: p.memberId, memberName: nameMap[p.memberId] || p.memberName || '(已刪除會員)', startDate: p.startDate || null, endDate: p.effectiveEndDate || p.endDate || null });
    });
    const passTypes = Object.values(groups)
      .map(g => ({ ...g, count: g.members.length, members: g.members.sort((a, b) => (a.endDate || '') < (b.endDate || '') ? -1 : 1) }))
      .sort((a, b) => b.count - a.count);
    res.json({ passTypes, total: passes.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /members/reports/active-course-students - 課程效期內學員（分課程）──
router.get('/reports/active-course-students', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const today = taiwanToday(); // 台灣日期（與課程入館資格同源）
    const gymId = req.staff.role === 'super_admin' ? (req.query.gymId || null) : req.staff.gymId;
    const courseSnap = await db.collection('courses').get();
    let courses = courseSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status !== 'cancelled');
    if (gymId) courses = courses.filter(c => c.gymId === gymId);
    const practiceEndOf = (c) => c.unlimitedPracticeEnd
      || (c.endDate ? dayjs(c.endDate).add(c.gymAccessDaysAfter || 1, 'day').format('YYYY-MM-DD') : null);
    courses = courses.filter(c => {
      const ps = c.unlimitedPracticeStart || c.startDate;
      const pe = practiceEndOf(c);
      return ps && pe && ps <= today && today <= pe;
    });
    const out = [];
    for (const c of courses) {
      const enrollSnap = await db.collection('courseEnrollments').where('courseId', '==', c.id).get();
      const seen = new Map();
      enrollSnap.docs.forEach(d => {
        const e = d.data();
        if (e.status !== 'confirmed' || e.pauseStatus === 'paused') return;
        if (!seen.has(e.memberId)) seen.set(e.memberId, { memberId: e.memberId, memberName: e.memberName || '' });
      });
      const members = [...seen.values()];
      if (members.length) {
        out.push({
          courseId: c.id, courseName: c.name, gymId: c.gymId,
          practiceStart: c.unlimitedPracticeStart || c.startDate || null,
          practiceEnd: practiceEndOf(c),
          count: members.length, members: members.sort((a, b) => (a.memberName || '').localeCompare(b.memberName || '')),
        });
      }
    }
    out.sort((a, b) => b.count - a.count);
    res.json({ courses: out, total: out.reduce((s, c) => s + c.count, 0) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /members/download - 下載會員名單（XLSX，含最後兩次入場時間；管理員）──
// 注意：此路由必須在 GET /:id 之前，否則會被 /:id 攔截。
router.get('/download',
  authenticate,
  checkPermission('members.read'),
  async (req, res) => {
    try {
      const db = getDb();
      // 場館範圍：super_admin 可指定 gymId（不指定＝全部館）；其他角色鎖自己館
      const effectiveGymId = req.staff.role === 'super_admin' ? (req.query.gymId || null) : req.staff.gymId;
      let ref = db.collection(COLLECTIONS.MEMBERS);
      if (effectiveGymId) ref = ref.where('gymId', '==', effectiveGymId);
      const snap = await ref.get();
      const members = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // 台北時間字串（Firestore Timestamp / {_seconds} / Date 皆可）
      const fmtTs = (ts) => {
        if (!ts) return '';
        const ms = ts._seconds != null ? ts._seconds * 1000
          : (typeof ts.toDate === 'function' ? ts.toDate().getTime() : new Date(ts).getTime());
        if (!ms || isNaN(ms)) return '';
        return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      };

      // 每位會員最後兩次入場時間：以 memberId 撈其 checkIns（單欄等值，免 composite index），
      // 記憶體排序後取最近兩筆。分批並行避免一次發太多查詢。
      const lastVisits = {};
      for (let i = 0; i < members.length; i += 50) {
        const chunk = members.slice(i, i + 50);
        await Promise.all(chunk.map(async m => {
          const vs = await db.collection(COLLECTIONS.CHECK_INS).where('memberId', '==', m.id).get();
          const times = vs.docs.map(d => d.data().checkedInAt).filter(Boolean)
            .map(t => (t._seconds != null ? t._seconds * 1000 : (t.toDate ? t.toDate().getTime() : new Date(t).getTime())))
            .filter(ms => ms && !isNaN(ms))
            .sort((a, b) => b - a);
          lastVisits[m.id] = times.slice(0, 2);
        }));
      }

      const gymLabel = (g) => g === 'gym-hsinchu' ? '新竹館' : g === 'gym-shilin' ? '士林館' : (g || '');
      members.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
      const rows = members.map(m => ({
        '會員ID': m.id,
        '姓名': m.name || '',
        '電話': m.phone || '',
        'Email': m.email || '',
        '生日': m.birthday || '',
        '性別': m.gender || '',
        '子帳號': m.isChildAccount ? '是' : '',
        '家長ID': m.parentMemberId || '',
        '場館': gymLabel(m.gymId),
        '註冊來源': m.registeredBy || '',
        '狀態': m.isBlocked ? '封鎖' : '正常',
        '最近入場': fmtTs((lastVisits[m.id] || [])[0]),
        '前次入場': fmtTs((lastVisits[m.id] || [])[1]),
      }));
      if (rows.length === 0) rows.push({ '會員ID': '無資料', '姓名': '', '電話': '', 'Email': '', '生日': '', '性別': '', '子帳號': '', '家長ID': '', '場館': '', '註冊來源': '', '狀態': '', '最近入場': '', '前次入場': '' });

      const ws = sanitizeSheet(XLSX.utils.json_to_sheet(rows));
      ws['!cols'] = [24, 10, 12, 22, 12, 6, 6, 24, 8, 10, 8, 18, 18].map(w => ({ wch: w }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '會員名單');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const today = taiwanToday();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="members_${today}.xlsx"`);
      res.send(buf);
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── GET /members/:id - 取得單一會員 ─────────────────────────────
router.get('/:id',
  authenticate,
  checkPermission('members.read'),
  async (req, res) => {
    try {
      const member = await memberService.getMember(req.params.id);

      // 非 super_admin 只能查看本館資料（簡單的關聯性檢查）
      // 實際上會員跨館共用，這裡只擋明顯錯誤的場景

      // 取得 waiver 狀態
      const db = getDb();
      const waiverDoc = await db.collection(COLLECTIONS.WAIVERS).doc(req.params.id).get();

      // 取得最近墜落測驗
      // 取得最近墜落測驗（查詢失敗不影響其他資料）
      let fallTests = { empty: true, docs: [] };
      try {
        const ftSnap = await db.collection(COLLECTIONS.FALL_TESTS)
          .where('memberId', '==', req.params.id)
          .get();
        if (!ftSnap.empty) {
          // 客戶端排序
          const sorted = ftSnap.docs.map(d => d.data()).sort((a, b) => {
            const ta = a.testedAt?.seconds || a.testedAt?._seconds || 0;
            const tb = b.testedAt?.seconds || b.testedAt?._seconds || 0;
            return tb - ta;
          });
          fallTests = { empty: false, docs: [{ data: () => sorted[0] }] };
        }
      } catch (e) {}

      // 取得有效定期票
      const today = dayjs().format('YYYY-MM-DD');
      const passes = await db.collection(COLLECTIONS.MEMBER_PASSES)
        .where('memberId', '==', req.params.id)
        .where('endDate', '>=', today)
        .where('status', '==', 'active')
        .get();

      // 取得子會員
      const children = await db.collection(COLLECTIONS.MEMBERS)
        .where('parentMemberId', '==', req.params.id)
        .get();

      // 取得最新墜落測驗同意書簽署狀態（只取是否存在，不含圖片資料以節省頻寬）
      const fallTestSigSnap = await db.collection('fallTestSignatures')
        .where('memberId', '==', req.params.id)
        .get();
      const hasFallTestSignature = !fallTestSigSnap.empty;

      // waiver 簽署狀態（供顯示）
      const waiverData = waiverDoc.exists ? waiverDoc.data() : null;
      const liveWaiverSigned = !!(waiverData && waiverData.isComplete);
      member.waiverSigned = liveWaiverSigned;

      // 用權威函式重算「完整」封鎖狀態（含 waiver / 墜落測驗 / Email 未驗證），
      // 避免只用 waiver 原因覆寫而把因墜測/Email 被封鎖的會員誤解鎖
      const blockReasons = await memberService.refreshBlockStatus(req.params.id);
      member.blockReasons = blockReasons;
      member.isBlocked = blockReasons.length > 0;

      // 同步 waiverSigned（refreshBlockStatus 不含此欄位）
      db.collection(COLLECTIONS.MEMBERS).doc(req.params.id).update({
        waiverSigned: liveWaiverSigned,
      }).catch(() => {});

      const waiverOut = waiverDoc.exists
        ? await require('../utils/storageUrl').signFields(waiverDoc.data(), ['memberSignatureUrl', 'parentSignatureUrl'])
        : null;
      res.json({
        member,
        waiver: waiverOut,
        latestFallTest: fallTests.empty ? null : fallTests.docs[0].data(),
        activePasses: passes.docs.map(d => ({ id: d.id, ...d.data() })),
        children: children.docs.map(d => ({ id: d.id, name: d.data().name, birthday: d.data().birthday, memberType: d.data().memberType, isChildAccount: d.data().isChildAccount !== false })),
        hasFallTestSignature,
      });
    } catch (err) {
      if (err.code === 'MEMBER_NOT_FOUND') return res.status(404).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /members/:id/waiver - 查看已簽署的聲明書（會員僅能查看自己的）──
router.get('/:id/waiver', authenticateAny, async (req, res) => {
  try {
    const memberId = req.params.id;
    const db = getDb();
    if (req.member && req.member.id !== memberId) {
      // 允許父會員查看子會員的聲明書
      const childDoc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
      if (!childDoc.exists || childDoc.data().parentMemberId !== req.member.id) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只能查看自己或子會員的聲明書' });
      }
    }
    const waiverDoc = await db.collection(COLLECTIONS.WAIVERS).doc(memberId).get();
    if (!waiverDoc.exists) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '尚未簽署聲明書' });
    }
    const waiver = waiverDoc.data();

    // 舊紀錄（此功能上線前簽署）沒有文字快照，退而求其次顯示目前範本內容，並明確標註非簽署當時版本
    if (!waiver.contentSnapshot) {
      const contentDoc = await db.collection('systemSettings').doc('waiver').get();
      waiver.contentSnapshot = contentDoc.exists ? { zh: contentDoc.data().zh || '', en: contentDoc.data().en || '' } : { zh: '', en: '' };
      waiver.contentIsFallback = true; // 標註：這是現行版本，非簽署當下的逐字快照
    }

    await require('../utils/storageUrl').signFields(waiver, ['memberSignatureUrl', 'parentSignatureUrl']);
    res.json({ waiver, waiverSigned: !!waiver.isComplete });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ── POST /members/:id/waiver/sign - 簽署風險安全聲明書 ───────────────
// 會員本人自助簽署，或工作人員於毱台協助操作（authenticateAny）
router.post('/:id/waiver/sign',
  authenticateAny,
  [body('signatureData').notEmpty().withMessage('請先簽名')],
  validate,
  async (req, res) => {
    try {
      const memberId = req.params.id;
      // 會員只能簽自己的，或代簽自己的子會員；工作人員可代簽任何會員
      const deny = await checkMemberOwnership(req.member, memberId, {
        onMissing: 404, message: '只能簽署自己或子會員的聲明書',
      });
      if (deny) return res.status(deny.status).json(deny.body);

      const member = await memberService.getMember(memberId);
      const { signatureData, parentEmail: rawParentEmail, parentName, parentPhone, parentRelation } = req.body;

      // 子會員：自動帶入父會員 Email，不需另外填寫
      let parentEmail = rawParentEmail;
      if (member.isChildAccount && member.parentMemberId && !parentEmail) {
        const parentMember = await memberService.getMember(member.parentMemberId);
        parentEmail = parentMember?.email || parentMember?.phone || '';
      }

      if (member.isMinor && !member.isChildAccount && !parentEmail) {
        return res.status(400).json({ error: 'PARENT_EMAIL_REQUIRED', message: '未成年會員需提供家長/監護人 Email' });
      }

      const result = await waiverService.signWaiver({
        memberId, memberName: member.name, isMinor: member.isMinor,
        isChildAccount: member.isChildAccount || false,
        signatureData, parentEmail, parentName, parentPhone, parentRelation,
        staffId: req.staff?.id || null,
        ip: req.ip,
      });

      // 更新 member 文件的 waiverSigned，確保搜尋列表即時反映
      const db = getDb();
      await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
        waiverSigned: true,
        isBlocked: false,
        blockReasons: [],
        updatedAt: new Date(),
      });

      res.json({
        message: member.isMinor ? '簽署成功，已發送 Email 通知家長/監護人共同簽署' : '簽署成功',
        ...result,
      });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /members/:id/waiver/resend-parent - 重新發送家長簽名連結 ──
router.post('/:id/waiver/resend-parent',
  authenticateAny,
  async (req, res) => {
    try {
      const memberId = req.params.id;
      if (req.member && req.member.id !== memberId) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      const result = await waiverService.resendParentWaiverLink(memberId, req.staff?.id || null);
      res.json(result);
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /members - 建立新會員（店員端）────────────────────────
router.post('/',
  authenticate,
  checkPermission('members.create'),
  auditLog('member.create'),
  [
    body('name').trim().notEmpty().withMessage('姓名為必填'),
    body('phone').matches(/^09\d{8}$|^\+\d{7,15}$/).withMessage('電話格式不正確'),
    body('birthday').optional({ nullable: true }).isDate().withMessage('生日格式不正確（YYYY-MM-DD）'),
    body('email').optional().isEmail().withMessage('Email 格式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const member = await memberService.createMember(req.body, req.staff.id);
      res.status(201).json({ member, message: '會員建立成功' });
    } catch (err) {
      if (err.code === 'PHONE_EXISTS') return res.status(409).json(err);
      if (err.code === 'AGE_UNDER_5') return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /members/self-register - 會員自助註冊 ──────────────────
router.post('/self-register',
  [
    body('name').trim().notEmpty().withMessage('姓名為必填'),
    body('phone').matches(/^09\d{8}$/).withMessage('請輸入有效的台灣手機號碼'),
    body('birthday').optional({ nullable: true }).isDate().withMessage('生日格式不正確'),
    body('email').isEmail().withMessage('Email 格式不正確'),
    body('password').isLength({ min: 8 }).withMessage('密碼至少8碼'),
  ],
  validate,
  async (req, res) => {
    try {
      // 密碼雜湊
      const bcrypt = require('bcryptjs');
      const passwordHash = await bcrypt.hash(req.body.password, 10);

      // 建立會員（未滿 5 歲會於 createMember throw AGE_UNDER_5）
      const member = await memberService.createMember({
        ...req.body,
        registeredBy: 'self',
      }, null);

      // 存入 passwordHash
      const db = getDb();
      await db.collection(COLLECTIONS.MEMBERS).doc(member.id).update({ passwordHash });

      // 發送 Email 驗證信
      const emailService = require('../services/emailService');
      await emailService.sendEmailVerification(member.id, member.email, member.name);

      res.status(201).json({
        member: { id: member.id, name: member.name, phone: member.phone },
        message: '註冊成功，請至信箱完成驗證',
        nextStep: 'email_verification',
      });
    } catch (err) {
      if (err.code === 'PHONE_EXISTS') return res.status(409).json(err);
      if (err.code === 'AGE_UNDER_5') return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /members/:id - 更新會員資料 ─────────────────────────────
router.put('/:id',
  authenticate,
  checkPermission('members.update'),
  auditLog('member.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowedFields = ['name', 'email', 'emergencyContact', 'notes', 'gender'];
      const updates = {};
      allowedFields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      updates.updatedAt = new Date();

      await db.collection(COLLECTIONS.MEMBERS).doc(req.params.id).update(updates);
      res.json({ message: '更新成功' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /members/:id - 刪除會員（僅管理員；一併刪其子帳號）─────────
// 只刪會員檔案本身與其子帳號；入場/交易/票券/報名等歷史紀錄保留（內含 memberId 快照，供對帳）。
router.delete('/:id',
  authenticate,
  checkPermission('members.delete'),
  auditLog('member.delete'),
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection(COLLECTIONS.MEMBERS).doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此會員' });

      // 一併刪除其子帳號（子帳號無法脫離家長獨立存在）
      const childSnap = await db.collection(COLLECTIONS.MEMBERS)
        .where('parentMemberId', '==', req.params.id).get();
      const deletedChildren = childSnap.docs.map(d => ({ id: d.id, name: d.data().name }));

      const batch = db.batch();
      childSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(ref);
      await batch.commit();

      res.json({
        success: true,
        deleted: { id: req.params.id, name: doc.data().name || '' },
        deletedChildren,
        note: '已刪除會員與其子帳號；入場/交易/票券等歷史紀錄保留',
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /members/:id/qrcode - 取得 QR Code ──────────────────────
router.get('/:id/qrcode',
  authenticate,
  checkPermission('members.read'),
  async (req, res) => {
    try {
      const member = await memberService.getMember(req.params.id);
      res.json({ qrCode: member.qrCode, qrCodeId: member.qrCodeId });
    } catch (err) {
      res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    }
  }
);



// ── POST /members/:id/children - 新增子會員 ──────────────────────
router.post('/:id/children',
  authenticate,
  checkPermission('members.create'),
  [
    body('name').trim().notEmpty().withMessage('子會員姓名為必填'),
    body('birthday').optional({ nullable: true }).isDate().withMessage('生日格式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const parent = await memberService.getMember(req.params.id);

      const child = await memberService.createMember({
        name: req.body.name,
        birthday: req.body.birthday,
        gender: req.body.gender,
        phone: parent.phone, // 共用家長電話
        email: parent.email, // 共用家長 Email
      }, req.staff.id, {
        isChildAccount: true,
        parentMemberId: req.params.id,
      });

      res.status(201).json({ child, message: '子會員建立成功' });
    } catch (err) {
      if (['AGE_UNDER_5', 'AGE_RESTRICTION'].includes(err.code)) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /members/verify-email/:token - 驗證 Email ────────────────
router.get('/verify-email/:token',
  async (req, res) => {
    try {
      const result = await memberService.verifyEmail(req.params.token);
      // 重導向到前端成功頁
      res.redirect(`${process.env.CLIENT_URL}/member/verify?status=success&memberId=${result.memberId}`);
    } catch (err) {
      res.redirect(`${process.env.CLIENT_URL}/member/verify?status=error&code=${err.code}`);
    }
  }
);

// 註：舊端點 POST /members/:id/fall-test 已移除。
// 它寫入 result:'pass'/'fail'，但全系統（verify / eligibility / blockReasons）已統一只認
// 'passed'/'failed'，舊端點為前端未使用的死碼且會產生不相容資料。登記墜測請改用
// POST /fall-tests（routes/fallTests.js）。

// ── POST /members/:id/promote - 子會員升級為正式會員 ──────────────
router.post('/:id/promote', authenticate, checkPermission('members.create'),
  [
    body('phone').matches(/^09\d{8}$/).withMessage('請輸入有效的台灣手機號碼'),
    body('email').isEmail().withMessage('Email 格式不正確'),
    body('password').optional().isLength({ min: 8 }).withMessage('密碼至少8碼'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const childRef = db.collection(COLLECTIONS.MEMBERS).doc(req.params.id);
      const childDoc = await childRef.get();
      if (!childDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此會員' });

      const child = childDoc.data();
      if (!child.isChildAccount) {
        return res.status(400).json({ error: 'NOT_CHILD_ACCOUNT', message: '此會員並非子會員，無需升級' });
      }

      const { phone, email } = req.body;

      // 新手機號碼不可重複（不可跟現有任何會員相同，含原本共用的家長電話）
      const phoneClash = await db.collection(COLLECTIONS.MEMBERS).where('phone', '==', phone).get();
      if (!phoneClash.empty) return res.status(409).json({ error: 'PHONE_EXISTS', message: '此電話號碼已被其他會員使用' });

      const bcrypt = require('bcryptjs');
      const password = req.body.password || phone.slice(-4);
      const passwordHash = await bcrypt.hash(password, 10);

      await childRef.update({
        phone, email, passwordHash,
        isChildAccount: false,
        promotedAt: new Date(),
        promotedBy: req.staff.id,
        updatedAt: new Date(),
        // parentMemberId 保留作為歷史紀錄，不影響功能
      });

      res.json({ message: `${child.name} 已升級為正式會員，可使用新手機號碼獨立登入` });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /members/:id/waiver/reset - 員工退回 Waiver 重簽 ────────────
router.post('/:id/waiver/reset',
  authenticate, requireManagerOrStation,
  async (req, res) => {
    try {
      const db = getDb();
      const memberId = req.params.id;
      const { reason, force } = req.body;
      if (!reason?.trim()) return res.status(400).json({ error: 'MISSING_REASON', message: '請填寫退回原因' });

      // 保護：墜落測驗已通過的會員，兩份文件不可退回重簽（避免誤觸把在籍會員踢回入場前置流程）。
      // 僅 super_admin 帶 force:true 可強制覆寫（供條款改版等正當重簽情境）。
      const canForce = force === true && req.staff?.role === 'super_admin';
      if (!canForce) {
        const { checkFallTest } = require('../services/checkinService');
        const ft = await checkFallTest(memberId);
        if (ft.passed) {
          return res.status(409).json({
            error: 'FALL_TEST_PASSED_LOCKED',
            message: '此會員墜落測驗已通過，風險安全聲明與墜測同意書已鎖定、無法退回重簽（避免誤觸）',
          });
        }
      }

      const waiverRef = db.collection(COLLECTIONS.WAIVERS).doc(memberId);
      const waiverDoc = await waiverRef.get();
      if (!waiverDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '此會員尚未簽署 Waiver' });

      // 封存舊簽署紀錄到 waiverResetLogs，供後台查詢
      await db.collection('waiverResetLogs').add({
        memberId,
        resetBy: req.staff?.id || req.staff?.name || 'staff',
        resetByName: req.staff?.name || '',
        reason: reason.trim(),
        previousSignatureData: waiverDoc.data().signatureData || null,
        resetAt: new Date(),
      });

      // 清除簽署狀態（保留 parentRequired 等欄位結構，只清除簽署資料）
      await waiverRef.update({
        signedAt: null,
        signatureData: null,
        isComplete: false,
        resetAt: new Date(),
        resetReason: reason.trim(),
      });

      // 更新會員的 waiverSigned 狀態及 blockReasons（讓搜尋結果即時反映）
      await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
        waiverSigned: false,
        isBlocked: true,
        blockReasons: ['waiver_unsigned'],
        updatedAt: new Date(),
      });

      res.json({ message: 'Waiver 已退回，會員需重新簽署' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);


module.exports = router;
