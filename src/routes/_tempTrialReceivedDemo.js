// TEMP：寄一封真實試上「報名收到」信給測試信箱，供人工檢視——用完即刪。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/emailService');

router.get('/send', authenticate, async (req, res) => {
  if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const deadline = new Date(Date.now() + 48 * 3600 * 1000);
    await emailService.sendExperienceBookingReceived(
      'chihchiu_chu@yahoo.com.tw', '測試會員',
      { kind: 'trial', courseName: '小蜘蛛人初級班 9-1月週一A班', bookingDate: '2026-09-14', bookingTime: '20:30~22:00', gymId: 'gym-hsinchu', totalFee: 990, isGuest: false },
      { bank: { bankName: '台新銀行(812)', branch: '關東橋分行', account: '21000100211430', accountName: '紅石攀岩有限公司' }, cc: undefined, deadline },
    );
    // 訪客版（帶 isGuest 提醒）也寄一封，確認差異
    await emailService.sendExperienceBookingReceived(
      'chihchiu_chu@yahoo.com.tw', '測試訪客',
      { kind: 'trial', courseName: '小蜘蛛人初級班 9-1月週一A班', bookingDate: '2026-09-14', bookingTime: '20:30~22:00', gymId: 'gym-hsinchu', totalFee: 990, isGuest: true, participants: [{ name: '測試訪客' }] },
      { bank: { bankName: '台新銀行(812)', branch: '關東橋分行', account: '21000100211430', accountName: '紅石攀岩有限公司' }, cc: undefined, deadline },
    );
    res.json({ ok: true, sentTo: 'chihchiu_chu@yahoo.com.tw (member + guest 各一封)' });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

module.exports = router;
