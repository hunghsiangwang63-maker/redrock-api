/**
 * 紅石賽事計分系統（Redrock-comp）身分驗證橋接（2026-08-15 安全稽核後新增，見 compAuthService.js 說明）
 *
 * POST /comp-auth/login              密碼驗證＋核發 custom token（公開、限流；redrock-comp 前端呼叫）
 * POST /comp-auth/admin/change-password  變更總管理者密碼（限已持有 super_admin custom token 者）
 *
 * ⚠️ 這裡的「身分」是 redrock-comp 專案自己的 Firebase Auth custom claims，跟 redrock-api 本身的
 * 員工/會員 JWT 系統（middleware/auth.js）完全獨立——不要混用彼此的中介層。
 */
const express = require('express');
const router = express.Router();
const { getCompAuth } = require('../config/compFirebase');
const { verifyAndMintToken, changeAdminPassword } = require('../services/compAuthService');

router.post('/login', async (req, res) => {
  try {
    const { role, password, email, compId } = req.body || {};
    if (!['super_admin', 'sub_admin', 'judge'].includes(role)) {
      return res.status(400).json({ error: 'INVALID_ROLE', message: '未知的登入類型' });
    }
    const result = await verifyAndMintToken({ role, password, email, compId });
    if (!result.ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: result.message || '帳號或密碼錯誤' });
    res.json({ token: result.token, compIds: result.compIds, name: result.name });
  } catch (e) {
    console.error('[comp-auth] login 失敗', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '登入失敗，請稍後再試' });
  }
});

// 驗證呼叫者帶的 Firebase ID token（redrock-comp 專案）確實是已核發的 super_admin 身分
const requireSuperAdminIdToken = async (req, res, next) => {
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'UNAUTHORIZED', message: '請先登入' });
    const auth = getCompAuth();
    if (!auth) return res.status(500).json({ error: 'NOT_CONFIGURED', message: '計分系統未設定金鑰' });
    const decoded = await auth.verifyIdToken(idToken);
    if (decoded.role !== 'super_admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅總管理者可執行此操作' });
    }
    req.compUid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: 'INVALID_TOKEN', message: '登入已失效，請重新登入' });
  }
};

router.post('/admin/change-password', requireSuperAdminIdToken, async (req, res) => {
  try {
    await changeAdminPassword(req.body && req.body.newPassword);
    res.json({ success: true });
  } catch (e) {
    const code = e.code || 'SERVER_ERROR';
    const status = code === 'INVALID_PASSWORD' ? 400 : 500;
    res.status(status).json({ error: code, message: e.message || '密碼變更失敗' });
  }
});

module.exports = router;
