/*
 * simulateRegistration.js — 模擬報名啟動端點
 *  POST /simulate/start：建臨時模擬會員 + 簽 member token → 回「真實會員報名表」deepLink（帶 sim token 自動登入）。
 *  員工開此連結 → 逐步操作真實報名表 → 送出時由各報名建立端點的 isSimulation guard 短路處理（見 simulationService）。
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate, requireManagerOrStation } = require('../middleware/auth');
const simulationService = require('../services/simulationService');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MEMBER_BASE = process.env.CLIENT_URL || 'https://app.redrocktaiwan.com';

// POST /simulate/start — 建臨時模擬帳號 + 回真實報名表 deepLink
router.post('/start', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { type, targetId, gymId } = req.body;
    const email = String(req.body.email || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'INVALID_EMAIL', message: '請輸入有效的收件 Email' });
    if (!['course', 'experience', 'competition'].includes(type)) return res.status(400).json({ error: 'INVALID_TYPE', message: 'type 須為 course / experience / competition' });

    const member = await simulationService.createSimMember(db, { email, gymId });
    const token = simulationService.signSimToken(member.id);

    let path;
    if (type === 'course') path = `/member/courses?course=${encodeURIComponent(targetId)}&sim=${token}`;
    else if (type === 'competition') path = `/member/competitions?comp=${encodeURIComponent(targetId)}&tab=open&sim=${token}`;
    else path = `/member/experience?sim=${token}`; // 體驗：表單內自選課程類型

    return res.json({ ok: true, deepLink: MEMBER_BASE + path, memberId: member.id, expiresInMin: simulationService.MAX_LIFE_MIN, email });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
module.exports.sweepExpiredSimulations = simulationService.sweepExpiredSimulations;
