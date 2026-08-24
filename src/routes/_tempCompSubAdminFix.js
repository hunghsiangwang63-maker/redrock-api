// 臨時端點（用完即刪）：把「202608 紅石成人抱石賽」單場管理員名冊裡
// 黎晉瑋／陳品翰兩筆舊格式（email 欄位存的是電話、另存獨立密碼雜湊）
// 更正為新格式（email 改存真實員工帳號 email、移除獨立密碼欄位）——
// 之後登入密碼驗證改走 redrock-api 的 staff 集合，比照現行「新增單場賽事管理員」表單的寫入格式。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getCompDb } = require('../config/compFirebase');
const admin = require('firebase-admin');

const FIXES = {
  sa1784184240898: { name: '黎晉瑋', email: 'allan860324@gmail.com' },
  sa1784184274081: { name: '陳品翰', email: 'handogwww@gmail.com' },
};

router.post('/:compDocId/fix-sub-admins', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  try {
    const cdb = getCompDb();
    if (!cdb) return res.status(500).json({ error: 'COMP_NOT_CONFIGURED' });
    const ref = cdb.collection('competitions').doc(req.params.compDocId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const before = doc.data().subAdmins || {};
    const updates = {};
    Object.keys(FIXES).forEach(key => {
      if (!before[key]) return;
      updates[`subAdmins.${key}.email`] = FIXES[key].email;
      updates[`subAdmins.${key}.password`] = admin.firestore.FieldValue.delete();
    });
    await ref.update(updates);
    const after = (await ref.get()).data().subAdmins || {};
    res.json({ before, after });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
