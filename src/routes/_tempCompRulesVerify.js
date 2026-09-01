// ⚠️ 臨時診斷路由——僅供 2026-09-02 驗證 redrock-comp firestore.rules 的「photoAlbums 例外」
// 是否真的生效（規則只在 client SDK / Firestore REST API 才會被強制執行，Admin SDK 天生繞過，
// 故必須透過真實 idToken 打 Firestore REST API 才能驗證，不能只靠讀規則檔本身）。
// 驗證完成後應立即整段移除本檔＋src/index.js 的掛載，比照 2026-08-18 JKoPay 臨時驗證路由的
// 同一慣例（見 CLAUDE.md 該日「臨時路由已清除」記錄）。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getCompDb, getCompAuth } = require('../config/compFirebase');

const API_KEY = 'AIzaSyD2Uxh4m-kbH2PHa6vrrR_Zr29Rx1FnAig'; // redrock-comp 前端 firebaseConfig 本就公開的 Web API Key
const PROJECT_ID = 'redrock-comp';

router.get('/_temp/comp-rules-verify', authenticate, async (req, res) => {
  if (req.staff?.role !== 'super_admin') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const compDb = getCompDb();
  const compAuth = getCompAuth();
  if (!compDb || !compAuth) {
    return res.status(500).json({ error: 'COMP_NOT_CONFIGURED' });
  }
  const compId = 'e2e-photo-album-rule-test-' + Date.now();
  const results = {};
  try {
    await compDb.collection('competitions').doc(compId).set({
      eventName: '【E2E測試】相簿欄位規則驗證',
      isActive: false,
      ended: true,
      photoAlbums: [],
      createdAt: Date.now(),
    });

    const customToken = await compAuth.createCustomToken('e2e-test-subadmin', { role: 'sub_admin', compIds: [compId] });
    const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }).then(r => r.json());
    if (!exch.idToken) {
      results.exchangeError = exch;
      throw new Error('EXCHANGE_FAILED');
    }
    const idToken = exch.idToken;
    const docBase = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/competitions/${compId}`;
    const authedPatch = (mask, fields) => fetch(`${docBase}?${mask.map(f => `updateMask.fieldPaths=${f}`).join('&')}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }).then(async r => ({ status: r.status, ok: r.ok, body: await r.json() }));

    // ① ended:true、只改 photoAlbums → 應成功（規則例外）
    results.photoAlbumsOnly_shouldSucceed = await authedPatch(['photoAlbums'], {
      photoAlbums: { arrayValue: { values: [{ mapValue: { fields: { name: { stringValue: '測試相簿' }, url: { stringValue: 'https://photos.app.goo.gl/test' } } } }] } },
    });

    // ② ended:true、改別的欄位（eventName）→ 應被拒絕（403）
    results.otherFieldWhenEnded_shouldBlock = await authedPatch(['eventName'], {
      eventName: { stringValue: '改名測試' },
    });

    // ③ ended:true、同時改 photoAlbums + eventName → 應被拒絕（affectedKeys 不只 photoAlbums）
    results.mixedFieldsWhenEnded_shouldBlock = await authedPatch(['photoAlbums', 'eventName'], {
      photoAlbums: { arrayValue: { values: [] } },
      eventName: { stringValue: '改名測試2' },
    });

    // ④ 把 ended 改回 false（用 admin SDK，繞過規則），確認「未結束」時 sub_admin 仍可自由改任何欄位（回歸不受影響）
    await compDb.collection('competitions').doc(compId).update({ ended: false });
    results.notEnded_regression_shouldSucceed = await authedPatch(['eventName'], {
      eventName: { stringValue: '未結束時可改名' },
    });
  } catch (e) {
    results.error = e.message;
  } finally {
    try { await compDb.collection('competitions').doc(compId).delete(); } catch (e2) { results.cleanupError = e2.message; }
  }

  res.json({ compId, results });
});

module.exports = router;
