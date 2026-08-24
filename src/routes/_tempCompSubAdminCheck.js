// 臨時診斷路由：查詢紅石賽事計分系統(redrock-comp)某比賽的單站管理員(subAdmins)。
// super_admin 限定。用完即從 index.js 移除掛載＋刪除此檔重新部署。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getCompDb } = require('../config/compFirebase');

router.get('/:compDocId/sub-admins', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const cdb = getCompDb();
    if (!cdb) return res.status(500).json({ error: 'COMP_NOT_CONFIGURED' });
    const doc = await cdb.collection('competitions').doc(req.params.compDocId).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const d = doc.data();
    res.json({ name: d.name, subAdmins: d.subAdmins || {} });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
