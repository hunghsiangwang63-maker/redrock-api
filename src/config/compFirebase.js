/**
 * 紅石賽事計分系統（Redrock-comp 專案）跨專案連線層
 *
 * 賽世紀＝獨立的 Firebase 專案，與本系統(redrock-dev-a35c1)不同專案。
 * 透過第二個 Admin app 連到 Redrock-comp 的 Firestore，把「賽事 + 報名名單」直接寫過去。
 *
 * 金鑰走環境變數 COMP_FIREBASE_SA（整包 service account JSON 字串，放 Railway secret，不進版控）。
 * 未設定 → getCompDb() 回 null，計分系統同步自動停用（不報錯、不影響現有比賽功能）。
 */
const admin = require('firebase-admin');

let compDb = null;
let tried = false;

const getCompDb = () => {
  if (compDb) return compDb;
  if (tried) return null;
  tried = true;
  try {
    const raw = process.env.COMP_FIREBASE_SA;
    if (!raw) {
      console.warn('[賽世紀] 未設定 COMP_FIREBASE_SA → 計分系統同步停用（待補金鑰後自動啟用）');
      return null;
    }
    const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const existing = admin.apps.find(a => a && a.name === 'compApp');
    const app = existing || admin.initializeApp({ credential: admin.credential.cert(sa) }, 'compApp');
    compDb = app.firestore();
    console.log(`✅ 賽世紀(Redrock-comp) Firestore 已連線（project ${sa.project_id || '?'}）`);
    return compDb;
  } catch (e) {
    console.error('[賽世紀] Redrock-comp 連線失敗：', e.message);
    return null;
  }
};

// 是否已設定金鑰（供前端/狀態判斷）
const isCompConfigured = () => !!process.env.COMP_FIREBASE_SA;

module.exports = { getCompDb, isCompConfigured };
