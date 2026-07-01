/**
 * 裝置綁定總開關（可逆）
 * 讀/寫 systemSettings/security.deviceBindingEnabled，控制 station + staff 登入是否強制裝置驗證。
 * 預設（無此欄位）＝強制。設 false＝暫時停用（測試期）；設回 true＝恢復強制。
 * super_admin 一律豁免、不受此開關影響。
 *
 * 用法：
 *   狀態：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/deviceBinding.js status
 *   解除：...同上... off      （測試期停用裝置驗證）
 *   恢復：...同上... on       （測試完恢復強制）
 */
const mode = (process.argv[2] || 'status').toLowerCase();

(async () => {
  const { initFirebase, getDb } = require('../src/config/firebase');
  initFirebase(); const db = getDb();
  const ref = db.collection('systemSettings').doc('security');

  const read = async () => {
    const d = await ref.get();
    const v = d.exists ? d.data().deviceBindingEnabled : undefined;
    return v === false ? false : true; // 預設強制
  };

  if (mode === 'status') {
    console.log(`裝置綁定目前：${await read() ? '✅ 強制（ON）' : '⚠️ 已停用（OFF，測試期）'}`);
    process.exit(0);
  }
  if (mode === 'off') {
    await ref.set({ deviceBindingEnabled: false, updatedAt: new Date(), note: '測試期暫時停用，測試完請改回 on' }, { merge: true });
    console.log('⚠️ 已【解除】裝置綁定：station + staff 登入暫時不需裝置驗證（super_admin 本就豁免）。');
    console.log('   測試完成後請執行：node scripts/deviceBinding.js on');
    process.exit(0);
  }
  if (mode === 'on') {
    await ref.set({ deviceBindingEnabled: true, updatedAt: new Date() }, { merge: true });
    console.log('✅ 已【恢復】裝置綁定強制：新裝置登入需重新驗證/核准。');
    process.exit(0);
  }
  console.error('用法：node scripts/deviceBinding.js status|off|on');
  process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
