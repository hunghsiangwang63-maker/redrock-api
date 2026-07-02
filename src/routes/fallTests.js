/**
 * 墜落測驗路由
 * GET  /fall-tests/member/:memberId   取得會員墜落測驗狀態
 * POST /fall-tests                    工作人員標記測驗結果
 * GET  /fall-tests/settings           取得測驗設定
 * PUT  /fall-tests/settings           更新測驗設定
 * POST /fall-tests/sign               會員簽署同意書
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate, authenticateAny, requireManagerOrStation, checkPermission } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// 取得測驗設定
const getFallTestSettings = async (db) => {
  const doc = await db.collection('systemSettings').doc('fallTest').get();
  return doc.exists ? doc.data() : {
    requiredCheckins: 2,
    validYears: 1,
    youtubeUrl: '',
    watchPercentRequired: 90,
    contentZh: '',
    contentEn: '',
  };
};

// 計算測驗狀態
const calcFallTestStatus = async (db, memberId, settings) => {
  const snap = await db.collection('fallTests')
    .where('memberId', '==', memberId)
    .get();

  if (snap.empty) return { status: 'not_tested', needsTest: true };

  // 客戶端排序取最新一筆（避免需要 Firestore 複合索引）
  const tests = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const ta = a.testedAt?.seconds || 0;
    const tb = b.testedAt?.seconds || 0;
    return tb - ta;
  });
  const test = tests[0];
  if (test.result !== 'passed') return { status: 'failed', needsTest: true };

  const expiresRaw = test.currentExpiresAt || test.expiresAt;
  const expiresSec = expiresRaw?.seconds || expiresRaw?._seconds;
  const expiresAt = expiresSec
    ? dayjs(expiresSec * 1000)
    : expiresRaw ? dayjs(expiresRaw) : null;

  if (!expiresAt || !expiresAt.isValid()) {
    // 無法判斷有效期，視為通過
  } else if (dayjs().isAfter(expiresAt)) {
    return { status: 'expired', needsTest: true, expiredAt: expiresAt.format('YYYY-MM-DD') };
  }

  // 計算本年度入場次數（從通過日起算）
  const passedAt = dayjs(test.testedAt?.seconds ? test.testedAt.seconds * 1000 : test.testedAt?._seconds ? test.testedAt._seconds * 1000 : test.testedAt);
  let checkinCount = 0;
  try {
    const checkinsSnap = await db.collection('checkIns')
      .where('memberId', '==', memberId)
      .where('status', '==', 'checked_in').get();
    checkinCount = checkinsSnap.docs.filter(d => {
      const at = d.data().checkedInAt?.toDate?.() || new Date(0);
      return at >= passedAt.toDate();
    }).length;
  } catch (e) { checkinCount = 0; }

  return {
    status: 'passed',
    needsTest: false,
    passedAt: passedAt.format('YYYY-MM-DD'),
    expiresAt: expiresAt.format('YYYY-MM-DD'),
    checkinCount,
    requiredCheckins: settings.requiredCheckins,
    testId: test.id,
  };
};

// ── GET /fall-tests/settings ─────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const db = getDb();
    const settings = await getFallTestSettings(db);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /fall-tests/settings ─────────────────────────────────────
router.put('/settings', authenticate, checkPermission('settings.manage'), async (req, res) => {
  try {
    const db = getDb();
    const { requiredCheckins, validYears, youtubeUrl, watchPercentRequired, contentZh, contentEn } = req.body;
    await db.collection('systemSettings').doc('fallTest').set({
      requiredCheckins: Number(requiredCheckins) || 2,
      validYears: Number(validYears) || 1,
      youtubeUrl: youtubeUrl || '',
      watchPercentRequired: Number(watchPercentRequired) || 90,
      contentZh: contentZh || '',
      contentEn: contentEn || '',
      updatedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /fall-tests/member/:memberId ─────────────────────────────
router.get('/member/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const settings = await getFallTestSettings(db);
    const status = await calcFallTestStatus(db, req.params.memberId, settings);
    res.json({ ...status, settings });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /fall-tests/sign ─────────────────────────────────────────
// 會員簽署同意書（影片看完後）
router.post('/sign', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    // 支援家長代替子會員簽署：body 可帶 targetMemberId
    let memberId = req.member?.id || req.body.memberId;
    if (req.body.targetMemberId && req.member && req.body.targetMemberId !== req.member.id) {
      const targetSnap = await db.collection('members').doc(req.body.targetMemberId).get();
      if (!targetSnap.exists) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
      const target = targetSnap.data();
      if (!target.isChildAccount || target.parentMemberId !== req.member.id) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只能代替自己的子會員簽署' });
      }
      memberId = req.body.targetMemberId;
    }
    const { signatureData, watchPercent, agreedParagraphs, guardianSignatureData, guardianName } = req.body;
    const settings = await getFallTestSettings(db);

    if (!(watchPercent >= settings.watchPercentRequired))
      return res.status(400).json({ error: 'INSUFFICIENT_WATCH', message: `請觀看至少 ${settings.watchPercentRequired}% 的影片` });

    if (!agreedParagraphs || !Array.isArray(agreedParagraphs) || agreedParagraphs.length === 0)
      return res.status(400).json({ error: 'MISSING_AGREEMENT', message: '請閱讀並勾選所有條款後再簽署' });

    // 建立簽署紀錄，同時儲存當下條款文字快照（避免未來條款改版後副本顯示錯誤內容）
    const signId = uuidv4();
    await db.collection('fallTestSignatures').doc(signId).set({
      id: signId,
      memberId,
      signatureData: signatureData || '',
      watchPercent,
      agreedParagraphs,
      contentSnapshot: {
        zh: settings.contentZh || '',
        en: settings.contentEn || '',
      },
      guardianSignatureData: guardianSignatureData || null,
      guardianName: guardianName || null,
      signedAt: new Date(),
    });

    res.status(201).json({ signatureId: signId, message: '同意書已簽署，等待工作人員進行測驗' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /fall-tests ──────────────────────────────────────────────
// 工作人員標記測驗結果
router.post('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { memberId, result, notes } = req.body;
    if (!memberId || !result) return res.status(400).json({ error: 'MISSING_FIELDS' });

    // 未簽署同意書不可登記通過
    if (result === 'passed') {
      const sigSnap = await db.collection('fallTestSignatures')
        .where('memberId', '==', memberId)
        .limit(1)
        .get();
      if (sigSnap.empty) {
        return res.status(400).json({
          error: 'SIGNATURE_REQUIRED',
          message: '此會員尚未簽署墜落測驗同意書，無法登記為通過',
        });
      }
    }

    const settings = await getFallTestSettings(db);
    const now = dayjs();
    const expiresAt = now.add(settings.validYears, 'year').toDate();

    const testId = uuidv4();
    const test = {
      id: testId,
      memberId,
      result, // 'passed' | 'failed'
      testedBy: req.staff.id,
      testedByName: req.staff.name,
      testedAt: now.toDate(),
      expiresAt: result === 'passed' ? expiresAt : null,
      notes: notes || '',
    };
    await db.collection('fallTests').doc(testId).set(test);

    // 更新會員狀態
    if (result === 'passed') {
      await db.collection('members').doc(memberId).update({
        fallTestPassed: true,
        fallTestExpiresAt: expiresAt,
        blockReasons: [], // 清除 fall_test_required
        updatedAt: new Date(),
      });
    }

    res.status(201).json({ test, message: result === 'passed' ? '測驗通過！' : '測驗未通過' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /fall-tests/:testId/extend ──────────────────────────────
// 自動展延（入場時觸發）
router.post('/:testId/extend', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const testRef = db.collection('fallTests').doc(req.params.testId);
    const test = (await testRef.get()).data();
    if (!test) return res.status(404).json({ error: 'NOT_FOUND' });

    // 以目前有效期為基準（含遞延）：currentExpiresAt → expiresAt → testedAt+1年
    let base;
    if (test.currentExpiresAt) base = dayjs(test.currentExpiresAt);
    else {
      const sec = test.expiresAt?.seconds || test.expiresAt?._seconds;
      base = sec ? dayjs(sec * 1000) : test.expiresAt ? dayjs(test.expiresAt) : dayjs(test.testedAt.toDate()).add(1, 'year');
    }
    const newExpiry = base.add(1, 'year').format('YYYY-MM-DD');

    // 統一寫入 currentExpiresAt（與自動遞延同欄位、同格式），入場閘門才讀得到
    await testRef.update({ currentExpiresAt: newExpiry, extendedAt: new Date() });
    await db.collection('members').doc(test.memberId).update({
      fallTestExpiresAt: newExpiry,
      updatedAt: new Date(),
    });

    res.json({ message: '墜落測驗有效期已展延1年', newExpiresAt: newExpiry });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /fall-tests/signature/:memberId - 取得會員最新簽署副本 ─────────
router.get('/signature/:memberId', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    // 會員僅能查自己或自己子會員的同意書（員工不受限）
    if (req.member && req.member.id !== req.params.memberId) {
      const childDoc = await db.collection('members').doc(req.params.memberId).get();
      if (!childDoc.exists || childDoc.data().parentMemberId !== req.member.id) {
        return res.status(403).json({ error: 'FORBIDDEN', message: '只能查看自己或子會員的同意書' });
      }
    }
    const snap = await db.collection('fallTestSignatures')
      .where('memberId', '==', req.params.memberId)
      .get();
    if (snap.empty) return res.json({ signature: null });
    // 取最新一筆
    const docs = snap.docs.map(d => d.data()).sort((a, b) => {
      const ta = a.signedAt?.toDate?.() || new Date(0);
      const tb = b.signedAt?.toDate?.() || new Date(0);
      return tb - ta;
    });
    res.json({ signature: docs[0] });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /fall-tests/signature/:memberId/reset - 員工退回同意書重簽 ──
router.post('/signature/:memberId/reset', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { memberId } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'MISSING_REASON', message: '請填寫退回原因' });

    const snap = await db.collection('fallTestSignatures')
      .where('memberId', '==', memberId)
      .get();
    if (snap.empty) return res.status(404).json({ error: 'NOT_FOUND', message: '此會員尚未簽署墜落測驗同意書' });

    // 取最新一筆
    const latest = snap.docs
      .map(d => ({ ref: d.ref, ...d.data() }))
      .sort((a, b) => {
        const ta = a.signedAt?.toDate?.() || new Date(0);
        const tb = b.signedAt?.toDate?.() || new Date(0);
        return tb - ta;
      })[0];

    // 封存到 fallTestSignatureResetLogs
    await db.collection('fallTestSignatureResetLogs').add({
      memberId,
      signatureId: latest.id,
      resetBy: req.staff?.id || '',
      resetByName: req.staff?.name || '',
      reason: reason.trim(),
      resetAt: new Date(),
    });

    // 刪除最新簽署紀錄，讓會員需要重新簽署
    await latest.ref.delete();

    res.json({ message: '墜落測驗同意書已退回，會員需重新簽署' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
