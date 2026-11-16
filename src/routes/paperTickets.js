/**
 * 紙本單張入場券「使用回收」（管理員／館長專用）
 * 清冊與資料模型見 services/paperTicketService.js。
 */
const express = require('express');
const router = express.Router();
const { authenticate, requireManager, auditLog } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const svc = require('../services/paperTicketService');

router.use(authenticate, requireManager);

// 各字軌：已售／已使用／尚未使用
router.get('/summary', async (req, res) => {
  try {
    res.json({ series: await svc.getSummary(getDb()) });
  } catch (e) {
    console.error('[paper-tickets] summary:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '讀取失敗' });
  }
});

// 只查詢，不登記
router.get('/lookup', async (req, res) => {
  try {
    const list = svc.parseTicketInput(req.query.no).slice(0, svc.MAX_BATCH);
    if (!list.length) return res.status(400).json({ error: 'NO_TICKETS', message: '請輸入票號' });
    const results = [];
    for (const no of list) results.push(await svc.lookup(getDb(), no));
    res.json({ results });
  } catch (e) {
    console.error('[paper-tickets] lookup:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '查詢失敗' });
  }
});

// 登記使用（回收）：一次可登記多張（一行一張或用空白／逗號隔開）
router.post('/redeem', auditLog('paperTicket.redeem'), async (req, res) => {
  try {
    const db = getDb();
    const list = svc.parseTicketInput(req.body.ticketNos);
    if (!list.length) return res.status(400).json({ error: 'NO_TICKETS', message: '請輸入票號' });
    if (list.length > svc.MAX_BATCH) {
      return res.status(400).json({ error: 'TOO_MANY', message: `一次最多登記 ${svc.MAX_BATCH} 張` });
    }
    // 館別：有館別的帳號（館長）用自己的館；管理員帳號（無館別）必須選
    const gymId = req.staff.gymId || req.body.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇使用的場館' });
    const gym = await db.collection('gyms').doc(gymId).get();
    if (!gym.exists) return res.status(400).json({ error: 'INVALID_GYM', message: '場館不存在' });
    const note = String(req.body.note || '').trim().slice(0, 200) || null;
    const results = await svc.redeemTickets(db, { ticketNos: list, gymId, staff: req.staff, note });
    const count = (s) => results.filter((r) => r.status === s).length;
    res.json({
      results,
      summary: { redeemed: count('redeemed'), alreadyUsed: count('already_used'), notFound: count('not_found') + count('not_sold'), invalid: count('invalid'), duplicate: count('duplicate_in_request') },
    });
  } catch (e) {
    console.error('[paper-tickets] redeem:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '登記失敗' });
  }
});

// 誤登復原（需填原因；使用紀錄保留在 undoHistory）
router.post('/undo', auditLog('paperTicket.undo'), async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ error: 'REASON_REQUIRED', message: '請填寫復原原因' });
    const r = await svc.undoRedeem(getDb(), { ticketNo: req.body.ticketNo, reason, staff: req.staff });
    res.json({ success: true, ...r });
  } catch (e) {
    if (['INVALID_TICKET', 'NOT_FOUND', 'NOT_USED'].includes(e.code)) {
      return res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.code, message: e.message });
    }
    console.error('[paper-tickets] undo:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '復原失敗' });
  }
});

// 最近的使用紀錄
router.get('/log', async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const series = req.query.series ? String(req.query.series) : undefined;
    res.json({ log: await svc.recentLog(getDb(), { limit, series }) });
  } catch (e) {
    console.error('[paper-tickets] log:', e);
    res.status(500).json({ error: 'SERVER_ERROR', message: '讀取失敗' });
  }
});

module.exports = router;
