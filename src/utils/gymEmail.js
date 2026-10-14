// 取得場館的聯絡 Email（gyms/{id}.email；無館別/無文件/未設定→null）。
// 由 registrationNotify、courseContractService、passContractService 三份相同實作抽出（2026-10-14）。
const resolveGymEmail = async (db, gymId) => {
  if (!gymId) return null;
  const d = await db.collection('gyms').doc(gymId).get();
  return d.exists ? (d.data().email || null) : null;
};
module.exports = { resolveGymEmail };
