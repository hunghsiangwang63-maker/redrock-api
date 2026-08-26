/**
 * 紅石賽事計分系統（Redrock-comp）身分驗證橋接（2026-08-15 安全稽核後新增，見 compAuthService.js 說明）
 *
 * POST /comp-auth/login   密碼驗證＋核發 custom token（公開、限流；redrock-comp 前端呼叫）
 *   role='super_admin'/'sub_admin'：驗證紅石系統既有員工帳號（email+密碼）
 *   role='judge'：維持 redrock-comp 自己的獨立密碼（裁判常是外部人，見 compAuthService.js 說明）
 *
 * POST /comp-auth/sso     員工端（redrock-web）已登入的正式入口（2026-08-26 新增）——賽事管理頁
 *   「計分系統」/「設定」按鈕呼叫，用現有的員工 JWT（authenticate 中介層）直接核發 token，
 *   不需要再輸入一次 email/密碼。計分系統首頁的「管理員功能」卡片與底部導覽「設定」分頁已移除，
 *   管理員/單場管理員以後一律從員工端進入。
 *
 * ⚠️ 這裡的「身分」是 redrock-comp 專案自己的 Firebase Auth custom claims，跟 redrock-api 本身的
 * 員工/會員 JWT 系統（middleware/auth.js）完全獨立——不要混用彼此的中介層；只是 super_admin/
 * sub_admin 的「密碼驗證來源」現在指向同一份 staff 集合。
 */
const express = require('express');
const router = express.Router();
const { verifyAndMintToken, ssoMintToken } = require('../services/compAuthService');
const { authenticate } = require('../middleware/auth');

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

router.post('/sso', authenticate, async (req, res) => {
  try {
    const result = await ssoMintToken(req.staff.id);
    if (!result.ok) return res.status(403).json({ error: 'NO_COMP_ACCESS', message: result.message || '此帳號無計分系統管理權限' });
    res.json({ token: result.token, compIds: result.compIds, name: result.name });
  } catch (e) {
    console.error('[comp-auth] sso 失敗', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '登入失敗，請稍後再試' });
  }
});

module.exports = router;
