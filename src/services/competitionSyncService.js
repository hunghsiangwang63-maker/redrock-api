/**
 * 紅石賽事計分系統（Redrock-comp 專案）同步
 * scoringSystem === 'competition_management_v2' 的賽事，跨專案直寫 Redrock-comp 的 `competitions` collection。
 *
 * 計分系統資料模型：一場賽事＝一個 `competitions` 文件
 *   { eventName, categories:[{name,color,rounds{賽制細節}}], athletes:{ <key>:{name,catIdx,round,bib,order,gender,birthday,phone,email,team,origId} }, visible, ... }
 *   選手是巢狀在賽事文件的 athletes map（非獨立 collection）。
 *
 * 分工：RedRock 建「賽事 + 組別(categories 名稱) + 報名名單(athletes)」；rounds 賽制/評審/分數細節由計分系統那邊設定。
 */
const admin = require('firebase-admin');
const { getCompDb } = require('../config/compFirebase');

const COMP_SCORING = 'competition_management_v2';
const CAT_COLORS = ['#4e8ef7', '#f74e8e', '#2D7D46', '#854F0B', '#533AB7', '#0F6E56', '#A32D2D', '#B5762B'];

const isCompScoring = (competition) => competition && competition.scoringSystem === COMP_SCORING;

const mapCategories = (competition) =>
  (competition.divisions || []).map((d, i) => ({ name: d.name, color: CAT_COLORS[i % CAT_COLORS.length], rounds: {} }));

// 把 RedRock 報名轉成計分系統 athlete
// 計分系統的性別一律送中文「男/女」（不送英文 male/female）
const toGenderZh = (g) => {
  const s = String(g || '').toLowerCase().trim();
  if (['male', 'm', '男', '男性'].includes(s)) return '男';
  if (['female', 'f', '女', '女性'].includes(s)) return '女';
  return g || '';   // 未知/空原樣
};

const mapAthlete = (competition, registration) => {
  const catIdx = Math.max(0, (competition.divisions || []).findIndex(d => d.id === registration.divisionId));
  const cf = registration.customFieldValues || {};
  return {
    origId: registration.id,
    name: registration.memberName || '',
    catIdx,
    round: 'Q',
    bib: '',                 // 號碼布由計分系統排
    order: 0,
    gender: toGenderZh(registration.gender || cf.gender || cf['性別'] || ''),
    birthday: registration.birthday || '',
    phone: registration.phone || '',
    email: registration.email || '',
    team: cf.team || cf['隊伍'] || cf['隊伍名稱'] || '',
  };
};

// 建立/更新計分系統的賽事文件；回傳 compDocId（呼叫端負責回存到 RedRock 賽事）
const syncCompEvent = async (competition) => {
  if (!isCompScoring(competition)) return { status: 'skipped', reason: '非計分系統賽事' };
  const cdb = getCompDb();
  if (!cdb) return { status: 'skipped', reason: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  const now = new Date();
  if (competition.compDocId) {
    // 已建過 → 只更新賽事名（不覆蓋 categories 內賽制/athletes/judges 等計分系統那邊設定的細節）
    await cdb.collection('competitions').doc(competition.compDocId).set(
      { eventName: competition.name, redrockCompId: competition.id, updatedAt: now.toISOString() },
      { merge: true }
    );
    return { status: 'sent', compDocId: competition.compDocId };
  }
  const ref = cdb.collection('competitions').doc();
  await ref.set({
    eventName: competition.name,
    categories: mapCategories(competition),
    athletes: {},
    visible: true, isActive: true, scoringEnabled: false,  // 賽制設好再由計分系統開啟計分
    redrockCompId: competition.id,
    createdAt: (competition.eventDate || now.toISOString().slice(0, 10)),
    updatedAt: now.toISOString(),
    source: 'redrock-sync',
  });
  return { status: 'sent', compDocId: ref.id };
};

// 報名完成 → 寫一筆選手到計分系統名單（冪等：key=報名id）。回傳 webhook 狀態欄位給呼叫端記錄。
// 需要 competition.compDocId；若尚未建賽事，呼叫端應先 syncCompEvent 並回存 compDocId。
const syncCompAthlete = async (competition, registration) => {
  if (!isCompScoring(competition)) return { webhookStatus: 'skipped', webhookError: '非計分系統賽事' };
  const cdb = getCompDb();
  if (!cdb) return { webhookStatus: 'skipped', webhookError: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  if (!competition.compDocId) return { webhookStatus: 'failed', webhookError: '計分系統賽事尚未建立（請先開始對接）' };
  try {
    const ref = cdb.collection('competitions').doc(competition.compDocId);
    const key = registration.id;
    const ath = mapAthlete(competition, registration);
    const existing = (await ref.get()).data()?.athletes?.[key];
    if (existing) {
      // 已存在 → 只更新 RedRock 欄位(姓名/組別/性別/隊伍)，保留計分系統那邊排的 bib/order 與已進階的 round
      await ref.update({
        [`athletes.${key}.name`]: ath.name,
        [`athletes.${key}.catIdx`]: ath.catIdx,
        [`athletes.${key}.gender`]: ath.gender,
        [`athletes.${key}.birthday`]: ath.birthday,
        [`athletes.${key}.phone`]: ath.phone,
        [`athletes.${key}.email`]: ath.email,
        [`athletes.${key}.team`]: ath.team,
        [`athletes.${key}.origId`]: ath.origId,
      });
    } else {
      // 新選手 → 完整寫入(含 bib:'' / order:0 / round:'Q' 預設，由計分系統那邊再排)
      await ref.update({ [`athletes.${key}`]: ath });
    }
    return { webhookStatus: 'sent', webhookSentAt: new Date(), webhookError: null };
  } catch (e) {
    return { webhookStatus: 'failed', webhookError: e.message };
  }
};

// 批次推送多位選手（重新推送/開始對接用）：讀一次 event doc、一次 update 全部 athletes 欄位。
// 取代逐一 syncCompAthlete（16 位 → 32 次跨專案往返）造成的慢/timeout；保留既有 bib/order/round。
const syncAllAthletes = async (competition, registrations) => {
  if (!isCompScoring(competition)) return { synced: 0, failed: 0, error: '非計分系統賽事' };
  const cdb = getCompDb();
  if (!cdb) return { synced: 0, failed: registrations.length, error: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  if (!competition.compDocId) return { synced: 0, failed: registrations.length, error: '計分系統賽事尚未建立' };
  const ref = cdb.collection('competitions').doc(competition.compDocId);
  let existing = {};
  try { existing = (await ref.get()).data()?.athletes || {}; }
  catch (e) { return { synced: 0, failed: registrations.length, error: e.message }; }
  const update = {};
  for (const reg of registrations) {
    const key = reg.id;
    const ath = mapAthlete(competition, reg);
    if (existing[key]) {
      // 已存在 → 只更新 RedRock 欄位，保留計分系統排的 bib/order/round
      update[`athletes.${key}.name`] = ath.name;
      update[`athletes.${key}.catIdx`] = ath.catIdx;
      update[`athletes.${key}.gender`] = ath.gender;
      update[`athletes.${key}.birthday`] = ath.birthday;
      update[`athletes.${key}.phone`] = ath.phone;
      update[`athletes.${key}.email`] = ath.email;
      update[`athletes.${key}.team`] = ath.team;
      update[`athletes.${key}.origId`] = ath.origId;
    } else {
      update[`athletes.${key}`] = ath;
    }
  }
  try {
    if (Object.keys(update).length) await ref.update(update);
    return { synced: registrations.length, failed: 0 };
  } catch (e) {
    return { synced: 0, failed: registrations.length, error: e.message };
  }
};

// 取消/退賽 → 從計分系統名單移除該選手
const removeCompAthlete = async (competition, registrationId) => {
  if (!isCompScoring(competition) || !competition.compDocId) return;
  const cdb = getCompDb();
  if (!cdb) return;
  try {
    await cdb.collection('competitions').doc(competition.compDocId)
      .update({ [`athletes.${registrationId}`]: admin.firestore.FieldValue.delete() });
  } catch (e) { console.error('[計分系統] 移除選手失敗', e.message); }
};

module.exports = { COMP_SCORING, isCompScoring, syncCompEvent, syncCompAthlete, syncAllAthletes, removeCompAthlete };
