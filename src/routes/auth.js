/**
 * 認證路由：工作人員登入 / 會員登入
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const { getDb, COLLECTIONS } = require('../config/firebase');
const memberService = require('../services/memberService');
const { authenticate, authenticateMember, checkPermission } = require('../middleware/auth');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const signToken = (payload, expiresIn) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: expiresIn || process.env.JWT_EXPIRES_IN || '7d' });

// ── Email 認證總開關（可逆；systemSettings/security.emailVerificationEnabled）──
// 預設 true（自助註冊須驗證 Email 才能登入）；設 false 可暫時停用（如資料移轉/測試期），改回 true 即恢復。
// 讀取失敗一律回 true（安全預設：寧可強制、不誤放行）。與裝置綁定共用 security doc。
const isEmailVerificationEnabled = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('security').get();
    if (doc.exists && doc.data().emailVerificationEnabled === false) return false;
    return true;
  } catch (e) { return true; }
};

// ── POST /auth/staff/login - 工作人員登入 ────────────────────────
router.post('/staff/login',
  [
    body('email').isEmail().withMessage('請輸入有效的 Email'),
    body('password').notEmpty().withMessage('請輸入密碼'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { email, password } = req.body;

      // 查詢 staff
      const snapshot = await db.collection(COLLECTIONS.STAFF)
        .where('email', '==', email)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });
      }

      const staffDoc = snapshot.docs[0];
      const staff = staffDoc.data();

      if (!staff.isActive) {
        return res.status(401).json({ error: 'STAFF_INACTIVE', message: '帳號已停用，請聯絡管理員' });
      }

      // 逐帳號登入鎖定（放寬門檻，見 utils/loginLock）
      const loginLock = require('../utils/loginLock');
      const lock = loginLock.checkLocked(staff);
      if (lock.locked) {
        return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號已鎖定，請 ${lock.mins} 分鐘後再試` });
      }

      // 驗證密碼（實際使用 bcrypt）
      const bcrypt = require('bcryptjs');
      const valid = await bcrypt.compare(password, staff.passwordHash);
      if (!valid) {
        const r = await loginLock.registerFail(COLLECTIONS.STAFF, staffDoc.id, staff);
        if (r.locked) return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號鎖定 ${r.mins} 分鐘` });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: `帳號或密碼錯誤（剩餘 ${r.remaining} 次）` });
      }
      await loginLock.clearFail(COLLECTIONS.STAFF, staffDoc.id);

      // 裝置綁定檢查（super_admin 例外；並可經 systemSettings/security.deviceBindingEnabled 暫時停用）
      const deviceAuthService = require('../services/deviceAuthService');
      if (staff.role !== 'super_admin' && await deviceAuthService.isDeviceBindingEnabled()) {
        const trusted = await deviceAuthService.isDeviceTrusted('staff', staffDoc.id, req.body.deviceToken);
        if (!trusted) {
          const { verificationId } = await deviceAuthService.createDeviceVerification({
            accountType: 'staff', accountId: staffDoc.id,
            accountName: staff.name, accountEmail: staff.notificationEmail || staff.email,
            deviceToken: req.body.deviceToken,
            deviceLabel: req.headers['user-agent'] || '',
          });
          return res.status(403).json({
            error: 'DEVICE_VERIFICATION_REQUIRED',
            verificationId,
            message: '此裝置尚未授權，已發送驗證碼至您的Email，或請聯絡管理員審核此裝置',
          });
        }
      }

      // 更新最後登入時間
      await staffDoc.ref.update({ lastLoginAt: new Date() });

      const token = signToken({
        staffId: staffDoc.id,
        gymId: staff.gymId,
        role: staff.role,
        type: 'staff',
      });

      // 登入後分流資訊
      const redirectMap = {
        super_admin: '/staff/dashboard/all',
        gym_manager: '/staff/dashboard',
        full_time: '/staff/checkin',
        part_time: '/staff/checkin',
      };

      res.json({
        token,
        staff: {
          id: staffDoc.id,
          name: staff.name,
          email: staff.email,
          role: staff.role,
          gymId: staff.gymId,
          gymName: staff.gymName,
        },
        redirect: redirectMap[staff.role],
        message: '登入成功',
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /auth/member/login - 會員登入 ──────────────────────────
router.post('/member/login',
  [
    body('identifier').notEmpty().withMessage('請輸入手機號碼或 Email'),
    body('password').notEmpty().withMessage('請輸入密碼'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { identifier, password } = req.body;

      // 支援手機號碼或 Email 登入
      // 親子帳號常共用同一支電話／Email；登入身分應指向「可登入的正式帳號」（非子帳號），
      // 子會員只能由家長代為操作。故取所有相符者後優先挑非子帳號，避免 limit(1) 依
      // 文件 id 排序誤判成子帳號（子帳號 id 若排在前，家長將無法登入自己的帳號）。
      let memberDoc;
      const field = identifier.includes('@') ? 'email' : 'phone';
      const snapshot = await db.collection(COLLECTIONS.MEMBERS)
        .where(field, '==', identifier).get();
      if (!snapshot.empty) {
        const docs = snapshot.docs;
        memberDoc = docs.find(d => d.data().isChildAccount !== true) || docs[0];
      }

      if (!memberDoc) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });
      }

      const member = memberDoc.data();

      // 檢查帳號是否被鎖定
      const now = new Date();
      if (member.loginLockedUntil) {
        const lockedUntil = member.loginLockedUntil.toDate?.() || new Date(member.loginLockedUntil._seconds * 1000);
        if (lockedUntil > now) {
          const mins = Math.ceil((lockedUntil - now) / 60000);
          return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤次數過多，帳號已鎖定，請 ${mins} 分鐘後再試` });
        }
      }

      // 驗證密碼
      const bcrypt = require('bcryptjs');
      if (!member.passwordHash) {
        return res.status(401).json({ error: 'NO_PASSWORD', message: '請使用忘記密碼功能設定密碼' });
      }
      const valid = await bcrypt.compare(password, member.passwordHash);
      if (!valid) {
        // 累計錯誤次數
        const failCount = (member.loginFailCount || 0) + 1;
        const MAX_FAIL = 5;
        const LOCK_MINUTES = 15;
        if (failCount >= MAX_FAIL) {
          const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60000);
          await db.collection(COLLECTIONS.MEMBERS).doc(memberDoc.id).update({
            loginFailCount: failCount,
            loginLockedUntil: lockUntil,
          });
          return res.status(429).json({ error: 'ACCOUNT_LOCKED', message: `密碼錯誤已達 ${MAX_FAIL} 次，帳號鎖定 ${LOCK_MINUTES} 分鐘` });
        }
        await db.collection(COLLECTIONS.MEMBERS).doc(memberDoc.id).update({ loginFailCount: failCount });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: `帳號或密碼錯誤（剩餘 ${MAX_FAIL - failCount} 次）` });
      }

      // 登入成功，清除錯誤計數
      await db.collection(COLLECTIONS.MEMBERS).doc(memberDoc.id).update({
        loginFailCount: 0,
        loginLockedUntil: null,
      });

      // Email 未驗證的自助註冊帳號：密碼正確也不發 token，強制先完成 Email 驗證。
      // 店員建立的帳號 emailVerified 預設 true 不受影響；共用 Email 的親子帳號各自有獨立驗證 token。
      // 受系統管理員「Email 認證」總開關控管（關閉時暫不強制，如資料移轉/測試期）。
      if (member.registeredBy === 'self' && !member.emailVerified && await isEmailVerificationEnabled()) {
        return res.status(403).json({
          error: 'EMAIL_NOT_VERIFIED',
          needsEmailVerification: true,
          email: member.email,
          message: '帳號尚未完成 Email 驗證，請至信箱點擊驗證連結後再登入（可要求重新寄送）',
        });
      }

      const token = signToken({
        memberId: memberDoc.id,
        type: 'member',
      });

      const { isActiveTeamMember } = require('../services/teamMemberService');

      res.json({
        token,
        member: {
          id: memberDoc.id,
          name: member.name,
          phone: member.phone,
          email: member.email,
          isBlocked: member.isBlocked,
          blockReasons: member.blockReasons,
          qrCode: member.qrCode,
          isMinor: member.isMinor || false,
          isTeamMember: isActiveTeamMember(member),
          teamMemberUntil: member.teamMemberUntil || null,
          emergencyContact: member.emergencyContact || null,
        },
        message: '登入成功',
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /auth/member/resend-verification - 重新寄送 Email 驗證信 ──
// 登入被 EMAIL_NOT_VERIFIED 擋下時使用；需帶密碼避免變成對外濫發入口。
router.post('/member/resend-verification',
  [
    body('identifier').notEmpty().withMessage('請輸入手機號碼或 Email'),
    body('password').notEmpty().withMessage('請輸入密碼'),
    body('newEmail').optional({ nullable: true }).isEmail().withMessage('新 Email 格式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { identifier, password, newEmail } = req.body;

      const field = identifier.includes('@') ? 'email' : 'phone';
      const snapshot = await db.collection(COLLECTIONS.MEMBERS)
        .where(field, '==', identifier).get();
      let memberDoc;
      if (!snapshot.empty) {
        const docs = snapshot.docs;
        memberDoc = docs.find(d => d.data().isChildAccount !== true) || docs[0];
      }
      if (!memberDoc) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });

      const member = memberDoc.data();
      const bcrypt = require('bcryptjs');
      if (!member.passwordHash || !(await bcrypt.compare(password, member.passwordHash))) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' });
      }
      if (member.emailVerified) {
        return res.json({ alreadyVerified: true, message: '此帳號 Email 已完成驗證，可直接登入' });
      }

      // 允許重寄時順便修正 Email（當初打錯的情況）。共用 Email 已允許，故不做唯一性檢查。
      let targetEmail = member.email;
      if (newEmail && newEmail !== member.email) {
        await db.collection(COLLECTIONS.MEMBERS).doc(memberDoc.id).update({
          email: newEmail,
          updatedAt: new Date(),
        });
        targetEmail = newEmail;
      }

      const emailService = require('../services/emailService');
      await emailService.sendEmailVerification(memberDoc.id, targetEmail, member.name);
      res.json({
        message: '驗證信已重新寄出，請至信箱點擊連結完成驗證',
        email: targetEmail,
        ...(targetEmail !== member.email ? { emailUpdated: true } : {}),
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /auth/member/forgot-password - 忘記密碼 ───────────────
// ── GET /auth/member/me - 取得目前登入會員的最新資料（含即時 blockReasons）─
router.get('/member/me', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member.id;
    const memberDoc = await db.collection('members').doc(memberId).get();
    if (!memberDoc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const member = memberDoc.data();

    // 即時計算 blockReasons（不依賴快取欄位）
    const waiverDoc = await db.collection('waivers').doc(memberId).get();
    const waiverData = waiverDoc.exists ? waiverDoc.data() : null;
    const blockReasons = [];
    if (!waiverData || !waiverData.isComplete) {
      if (!waiverData) blockReasons.push('waiver_unsigned');
      else if (waiverData.parentRequired && !waiverData.parentSignedAt) blockReasons.push('parent_waiver_pending');
      else blockReasons.push('waiver_unsigned');
    }

    const { isActiveTeamMember } = require('../services/teamMemberService');
    res.json({
      member: {
        id: memberId,
        name: member.name,
        phone: member.phone,
        email: member.email,
        birthday: member.birthday,
        gender: member.gender,
        emergencyContact: member.emergencyContact || null,
        isBlocked: blockReasons.length > 0,
        blockReasons,
        qrCode: member.qrCode,
        isMinor: member.isMinor || false,
        isTeamMember: isActiveTeamMember(member),
        waiverSigned: waiverData?.isComplete || false,
      },
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.post('/member/forgot-password',
  [body('email').isEmail()],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const snapshot = await db.collection(COLLECTIONS.MEMBERS)
        .where('email', '==', req.body.email).limit(1).get();

      // 無論是否找到都回傳成功（安全考量）
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const resetToken = uuidv4();
        const expiry = dayjs().add(24, 'hour').toDate();

        await doc.ref.update({ resetPasswordToken: resetToken, resetPasswordExpiry: expiry });

        const emailService = require('../services/emailService');
        const resetUrl = `${process.env.CLIENT_MEMBER_URL || 'https://app.redrocktaiwan.com'}/member/reset-password?token=${resetToken}`;
        await emailService.sendEmail({
          to: req.body.email,
          subject: '【紅石攀岩】密碼重設連結',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
            <p>親愛的 ${emailService.esc(doc.data().name)}，</p>
            <p>您申請了密碼重設，請點擊下方按鈕設定新密碼：</p>
            <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#8B1A1A;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">🔑 重設密碼</a>
            <p style="color:#999;font-size:12px">此連結 24 小時內有效。若非本人操作請忽略此信。</p>
          </div>`,
        });
      }

      res.json({ message: '如此 Email 有對應帳號，重設連結已發送' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /auth/waiver/parent/:token - 家長遠端簽名 ─────────────
router.get('/waiver/parent/:token',
  async (req, res) => {
    try {
      const db = getDb();
      const snapshot = await db.collection(COLLECTIONS.WAIVERS)
        .where('parentSignToken', '==', req.params.token)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return res.status(404).json({ error: 'INVALID_TOKEN', message: '無效的簽名連結' });
      }

      const waiver = snapshot.docs[0].data();

      if (dayjs().isAfter(dayjs(waiver.parentSignTokenExpiry.toDate()))) {
        return res.status(410).json({ error: 'TOKEN_EXPIRED', message: '簽名連結已過期（72小時有效）' });
      }

      if (waiver.parentSignedAt) {
        return res.status(409).json({ error: 'ALREADY_SIGNED', message: '已完成簽署' });
      }

      // 一併載入該會員的墜落測驗同意書（本人已簽、待家長簽）供同頁簽署
      let fallTest = null;
      const ftSnap = await db.collection('fallTestSignatures')
        .where('memberId', '==', waiver.memberId).get();
      if (!ftSnap.empty) {
        const latest = ftSnap.docs
          .map(d => d.data())
          .sort((a, b) => (b.signedAt?._seconds || b.signedAt?.seconds || 0) - (a.signedAt?._seconds || a.signedAt?.seconds || 0))[0];
        fallTest = {
          content: latest.contentSnapshot || { zh: '', en: '' },
          pending: latest.parentRequired === true && !latest.guardianSignedAt,
        };
      }

      // 回傳給前端的 Waiver 頁面資訊
      res.json({
        memberId: waiver.memberId,
        memberName: waiver.memberName,
        parentName: waiver.parentName,
        fallTest,           // { content:{zh,en}, pending } 或 null
        isValid: true,
      });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.post('/waiver/parent/:token',
  [body('signatureData').notEmpty().withMessage('簽名資料不可為空')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const snapshot = await db.collection(COLLECTIONS.WAIVERS)
        .where('parentSignToken', '==', req.params.token)
        .limit(1)
        .get();

      if (snapshot.empty) return res.status(404).json({ error: 'INVALID_TOKEN' });

      const waiverDoc = snapshot.docs[0];
      const waiver = waiverDoc.data();

      if (dayjs().isAfter(dayjs(waiver.parentSignTokenExpiry.toDate()))) {
        return res.status(410).json({ error: 'TOKEN_EXPIRED' });
      }

      // 上傳簽名圖
      const waiverService = require('../services/waiverService');
      const signatureUrl = await waiverService.uploadSignature(
        waiver.memberId,
        'parent',
        req.body.signatureData
      );

      const now = new Date();
      await waiverDoc.ref.update({
        parentSignatureUrl: signatureUrl,
        parentSignedAt: now,
        parentSignedIp: req.ip,
        isComplete: true,
        lockedAt: now,
        parentSignToken: null,   // 用完即廢
        parentSignTokenExpiry: null,
      });

      // 同一簽名一併套用到「墜落測驗同意書」（待家長簽的那份）→ 統一一次簽名兩份都完成
      try {
        const ftSnap = await db.collection('fallTestSignatures')
          .where('memberId', '==', waiver.memberId).get();
        if (!ftSnap.empty) {
          const target = ftSnap.docs
            .filter(d => d.data().parentRequired === true && !d.data().guardianSignedAt)
            .sort((a, b) => (b.data().signedAt?._seconds || 0) - (a.data().signedAt?._seconds || 0))[0]
            || ftSnap.docs.sort((a, b) => (b.data().signedAt?._seconds || 0) - (a.data().signedAt?._seconds || 0))[0];
          await target.ref.update({
            guardianSignatureData: signatureUrl,
            guardianName: waiver.parentName || null,
            guardianSignedAt: now,
          });
        }
      } catch (e) { console.error('家長簽名套用墜測同意書失敗（waiver 已完成）:', e.message); }

      // 解除會員封鎖
      await memberService.refreshBlockStatus(waiver.memberId);

      // 通知工作人員
      const emailService = require('../services/emailService');
      await emailService.notifyParentWaiverComplete(waiver.memberId, waiver.memberName);

      res.json({ message: '簽名完成，謝謝您！風險安全聲明書與墜落測驗同意書皆已完成。' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /auth/device/verify-otp - 新裝置驗證碼自助驗證 ──────────
// 驗證成功後直接核發正式登入token（跟原登入流程同一套token格式）
router.post('/device/verify-otp',
  [body('verificationId').notEmpty(), body('code').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const deviceAuthService = require('../services/deviceAuthService');
      const v = await deviceAuthService.verifyDeviceOtp(req.body.verificationId, req.body.code);

      const db = getDb();
      if (v.accountType === 'staff') {
        const staffDoc = await db.collection(COLLECTIONS.STAFF).doc(v.accountId).get();
        if (!staffDoc.exists) return res.status(404).json({ error: 'STAFF_NOT_FOUND' });
        const staff = staffDoc.data();
        await staffDoc.ref.update({ lastLoginAt: new Date() });
        const token = signToken({ staffId: staffDoc.id, gymId: staff.gymId, role: staff.role, type: 'staff' });
        const redirectMap = {
          super_admin: '/staff/dashboard/all', gym_manager: '/staff/dashboard',
          full_time: '/staff/checkin', part_time: '/staff/checkin',
        };
        return res.json({
          token,
          staff: { id: staffDoc.id, name: staff.name, email: staff.email, role: staff.role, gymId: staff.gymId, gymName: staff.gymName },
          redirect: redirectMap[staff.role],
          message: '裝置驗證成功，登入成功',
        });
      }

      if (v.accountType === 'station') {
        const stationDoc = await db.collection('stations').doc(v.accountId).get();
        if (!stationDoc.exists) return res.status(404).json({ error: 'STATION_NOT_FOUND' });
        const station = stationDoc.data();
        await stationDoc.ref.update({ lastLoginAt: new Date() });
        const token = signToken({ stationId: stationDoc.id, gymId: station.gymId, gymName: station.gymName, type: 'station' }, '30d');
        return res.json({
          token,
          station: { id: stationDoc.id, name: station.name, gymId: station.gymId, gymName: station.gymName },
          message: '裝置驗證成功，登入成功',
        });
      }

      res.status(400).json({ error: 'UNKNOWN_ACCOUNT_TYPE' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── 裝置審核（管理員後台）─────────────────────────────────────────
router.get('/device/pending', authenticate, checkPermission('devices.manage'), async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('deviceVerifications')
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .limit(50).get();
    res.json({ devices: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/device/pending/:id/approve', authenticate, checkPermission('devices.manage'), async (req, res) => {
  try {
    const deviceAuthService = require('../services/deviceAuthService');
    await deviceAuthService.approveDeviceVerification(req.params.id, `admin:${req.staff.id}`);
    res.json({ message: '已核准此裝置' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

router.post('/device/pending/:id/reject', authenticate, checkPermission('devices.manage'), async (req, res) => {
  try {
    const deviceAuthService = require('../services/deviceAuthService');
    await deviceAuthService.rejectDeviceVerification(req.params.id, `admin:${req.staff.id}`);
    res.json({ message: '已拒絕此裝置' });
  } catch (err) {
    if (err.code) return res.status(400).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});


// ── PUT /auth/member/profile - 會員更新個人資料 ─────────────────
router.put('/member/profile',
  authenticateMember,
  [
    body('name').trim().notEmpty().withMessage('姓名不可為空'),
    body('email').optional({ nullable: true }).isEmail().withMessage('Email 格式不正確'),
  ],
  validate,
  async (req, res) => {
    try {
      if (!req.member) return res.status(403).json({ error: 'FORBIDDEN', message: '僅會員可使用' });
      const db = getDb();
      const { name, email, birthday, gender, emergencyContact } = req.body;
      const updates = { name, updatedAt: new Date() };
      if (email !== undefined) updates.email = email || null;
      if (birthday !== undefined) updates.birthday = birthday || null;
      if (gender !== undefined) updates.gender = gender || null;
      if (emergencyContact !== undefined) updates.emergencyContact = emergencyContact || null;
      await db.collection(COLLECTIONS.MEMBERS).doc(req.member.id).update(updates);
      const snap = await db.collection(COLLECTIONS.MEMBERS).doc(req.member.id).get();
      res.json({ success: true, member: { id: snap.id, ...snap.data() } });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /auth/member/reset-password ───────────────────────────
router.post('/member/reset-password',
  [
    body('token').notEmpty().withMessage('缺少 token'),
    body('newPassword').isLength({ min: 8 }).withMessage('密碼至少 8 碼'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const { token, newPassword } = req.body;
      const snap = await db.collection(COLLECTIONS.MEMBERS).where('resetPasswordToken', '==', token).limit(1).get();
      if (snap.empty) return res.status(400).json({ error: 'INVALID_TOKEN', message: '連結無效或已過期' });
      const doc = snap.docs[0];
      const member = doc.data();
      if (member.resetPasswordExpiry?.toDate?.() < new Date() ||
          new Date(member.resetPasswordExpiry?._seconds * 1000) < new Date()) {
        return res.status(400).json({ error: 'TOKEN_EXPIRED', message: '連結已過期，請重新申請' });
      }
      const bcrypt = require('bcryptjs');
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await db.collection(COLLECTIONS.MEMBERS).doc(doc.id).update({
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExpiry: null,
        updatedAt: new Date(),
      });
      res.json({ success: true, message: '密碼已重設，請重新登入' });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
