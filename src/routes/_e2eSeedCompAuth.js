// ⚠️ TEMPORARY — 僅供這次「redrock-comp 身分驗證橋接」上線後端到端驗證用，測完立刻整檔刪除
// + 移除 index.js 的掛載，不留在正式程式碼裡。
const express = require('express');
const router = express.Router();
const { getCompDb } = require('../config/compFirebase');
const { hashPw } = require('../services/compAuthService');

const TEST_COMP_ID = 'e2eAuthBridgeTest123'; // Firestore 保留 __xxx__ 格式的 doc id，不能用

router.post('/seed', async (req, res) => {
  try {
    const db = getCompDb();
    if (!db) return res.status(500).json({ error: 'NOT_CONFIGURED' });
    await db.collection('competitions').doc(TEST_COMP_ID).set({
      eventName: '【E2E測試】身分驗證橋接',
      createdAt: '2026-08-15',
      isActive: false,
      athletes: {},
      categories: [],
      judgeAccounts: { k1: { email: 'e2e-judge@test.invalid', password: hashPw('E2eTestPw!23'), name: 'E2E Test Judge' } },
    });
    res.json({ ok: true, compId: TEST_COMP_ID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cleanup', async (req, res) => {
  try {
    const db = getCompDb();
    if (!db) return res.status(500).json({ error: 'NOT_CONFIGURED' });
    await db.collection('competitions').doc(TEST_COMP_ID).collection('data').doc('scores').delete();
    await db.collection('competitions').doc(TEST_COMP_ID).delete();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
