/**
 * 通知路由
 */
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getUnreadNotifications, markAsRead, markAllAsRead } = require('../services/notificationService');

// ── GET /notifications - 取得未讀通知 ───────────────────────────
router.get('/',
  authenticate,
  async (req, res) => {
    try {
      const notifs = await getUnreadNotifications(req.staff.id, req.staff.gymId, req.staff.role);
      res.json({ notifications: notifs, count: notifs.length });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /notifications/:id/read - 標記已讀 ──────────────────────
router.put('/:id/read',
  authenticate,
  async (req, res) => {
    try {
      await markAsRead(req.params.id);
      res.json({ message: '已標記為已讀' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /notifications/read-all - 全部已讀 ──────────────────────
router.put('/read-all',
  authenticate,
  async (req, res) => {
    try {
      const count = await markAllAsRead(req.staff.id);
      res.json({ message: `已標記 ${count} 則通知為已讀`, count });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

module.exports = router;
