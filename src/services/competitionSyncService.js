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

// ── 賽事結束後拉回最終成績（與上面的推送方向相反）─────────────────────────────
// 2026-08-27：計分系統總管理者確認「此賽事已結束」後，在計分系統按「回寫成績至會員紀錄」——
// 計分系統那邊算好每個組別的最終名次（含未晉級決賽者，見 redrock-comp
// computeFinalStandings()），存進賽事文件的 finalStandings 欄位（key=組別索引）。這裡只負責
// 讀出來、依 origId（＝RedRock 報名 id，見 mapAthlete）比對整理成「報名 id → 名次/參賽人數」，
// 名次計算的唯一權威在計分系統那邊算好（單一計算來源，不在這裡重算），呼叫端（competitionService.js
// syncFinalResults）負責寫回 RedRock 自己的 competitionRegistrations。
// 現場手動加的選手（origId 不對應任何真實報名）自然找不到 regMap 對應項，略過不寫。
const pullFinalResults = async (competition) => {
  if (!isCompScoring(competition)) return { updated: 0, error: '非計分系統賽事' };
  const cdb = getCompDb();
  if (!cdb) return { updated: 0, error: '計分系統未設定金鑰（COMP_FIREBASE_SA）' };
  if (!competition.compDocId) return { updated: 0, error: '計分系統賽事尚未建立（請先開始對接）' };
  let doc;
  try { doc = await cdb.collection('competitions').doc(competition.compDocId).get(); }
  catch (e) { return { updated: 0, error: e.message }; }
  if (!doc.exists) return { updated: 0, error: '找不到計分系統賽事文件' };
  const finalStandings = doc.data().finalStandings;
  if (!finalStandings || !Object.keys(finalStandings).length) {
    return { updated: 0, error: '計分系統尚未回寫成績（請先在計分系統確認「此賽事已結束」並按下「回寫成績至會員紀錄」）' };
  }
  const results = {}; // registrationId → { rank, participantCount, categoryName }
  Object.keys(finalStandings).forEach(catIdxStr => {
    const cat = finalStandings[catIdxStr];
    if (!cat || !Array.isArray(cat.results)) return;
    const catIdx = Number(catIdxStr);
    const categoryName = (competition.divisions || [])[catIdx]?.name || null;
    cat.results.forEach(r => {
      if (!r.origId) return;
      results[r.origId] = { rank: r.rank, participantCount: cat.participantCount, categoryName };
    });
  });
  return { updated: Object.keys(results).length, results };
};

// ── 賽前 10 分鐘自動開啟計分（2026-08-30：現場屢次忘記開「🟢 計分中」）──────────
// 每 5 分鐘檢查：open 賽事 && eventDate=今天 && 已對接（compDocId）&& 未處理過 →
// 現在時間 >= (eventStartTime||'09:00') − 10 分鐘 → 讀計分系統賽事：未 ended 且未開啟 →
// scoringEnabled=true ＋ 站內通知同館管理員。不論實際有沒有改（已手動開/已結束皆然），
// RedRock 賽事標 scoringAutoEnabledAt（冪等：只自動處理一次——之後管理員手動關閉不會被重開）。
const autoEnableScoringSweep = async () => {
  try {
    const db = getDb();
    const { taiwanToday } = require('../utils/taiwanDate');
    const today = taiwanToday();
    const snap = await db.collection('competitions').where('status', '==', 'open').get();
    const now = new Date(); // TZ=Asia/Taipei
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const d of snap.docs) {
      const c = d.data();
      if (c.eventDate !== today || !c.compDocId || c.scoringAutoEnabledAt) continue;
      const st = /^\d{2}:\d{2}$/.test(c.eventStartTime || '') ? c.eventStartTime : '09:00';
      const [hh, mm] = st.split(':').map(Number);
      if (nowMin < hh * 60 + mm - 10) continue; // 未到開賽前 10 分鐘
      let action = 'skipped';
      try {
        const cdb = getCompDb();
        const evRef = cdb.collection('competitions').doc(c.compDocId);
        const ev = await evRef.get();
        if (ev.exists && ev.data().ended !== true && ev.data().scoringEnabled !== true) {
          await evRef.update({ scoringEnabled: true });
          action = 'enabled';
          try {
            const { notifyRoleInGym } = require('./notificationService');
            await notifyRoleInGym(c.gymId, ['gym_manager', 'super_admin'], {
              type: 'scoring_auto_enabled', title: '計分系統已自動開啟',
              body: `「${c.name}」開賽前 10 分鐘（${st}），計分系統「計分中」已自動開啟。`,
            });
          } catch (e) { console.error('[自動開計分] 通知失敗（不阻斷）:', e.message); }
        }
      } catch (e) { console.error('[自動開計分] 讀寫計分系統失敗（下輪再試）:', e.message); continue; }
      await d.ref.update({ scoringAutoEnabledAt: new Date(), scoringAutoEnableAction: action });
      console.log(`[自動開計分] ${c.name}: ${action}`);
    }
  } catch (e) { console.error('[自動開計分] sweep 失敗:', e.message); }
};

// 啟動排程（index.js 呼叫；global 旗標防多次 require 重複掛 interval，比照 staffEntry sweep 模式）
const startAutoScoringTimer = () => {
  if (global.__autoScoringTimerStarted) return;
  global.__autoScoringTimerStarted = true;
  setInterval(autoEnableScoringSweep, 5 * 60 * 1000);
  setTimeout(autoEnableScoringSweep, 20 * 1000); // 開機 20 秒後先跑一次（部署當下若已在窗口內即刻生效）
};

module.exports = { COMP_SCORING, isCompScoring, syncCompEvent, syncCompAthlete, syncAllAthletes, removeCompAthlete, pullFinalResults,
  autoEnableScoringSweep, startAutoScoringTimer,
};
