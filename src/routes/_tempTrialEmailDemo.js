// TEMP：寄一封真實試上確認信給測試信箱，供人工檢視新內容——用完即刪。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/emailService');

router.get('/send', authenticate, async (req, res) => {
  if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    await emailService.sendExperienceBookingConfirmation(
      'chihchiu_chu@yahoo.com.tw', '測試會員',
      { kind: 'trial', courseName: '小蜘蛛人初級班 9-1月週一A班', bookingDate: '2026-09-14', bookingTime: '20:30~22:00', gymId: 'gym-hsinchu', totalFee: 990 },
      undefined,
    );
    res.json({ ok: true, sentTo: 'chihchiu_chu@yahoo.com.tw' });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

module.exports = router;
