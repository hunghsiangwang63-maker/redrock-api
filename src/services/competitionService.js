/**
 * 比賽報名 Service
 *
 * 設計重點：
 * - 每場賽事可自訂組別(divisions)與報名表單欄位(customFields)
 * - 每次報名需簽署獨立的風險聲明書（與日常waiver完全無關，每次報名都要重新簽）
 * - 未滿18歲需家長共同簽署，沿用既有waiver的家長遠端簽署機制（連結+72小時效期）
 * - 報名完成（含家長簽署，若需要）後，立即webhook通知對應的計分系統
 * - 計分系統二選一：rating_system 或 competition_management_v2，建賽事時指定
 * - webhookUrl 若未設定，僅記錄為 skipped，不會報錯，待對方提供網址後可直接補上啟用
 */
const { getDb, COLLECTIONS } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { uploadSignature } = require('./waiverService');

const SCORING_SYSTEMS = ['rating_system', 'competition_management_v2'];

// ══════════════════════════════════════════════════════
// 賽事管理
// ══════════════════════════════════════════════════════

const createCompetition = async ({ name, description, gymId, registrationStart, registrationEnd, earlyBirdDeadline, eventDate, divisions, customFields, waiverContent, scoringSystem, webhookUrl, fees, refundPolicies, status, staffId }) => {
  if (!SCORING_SYSTEMS.includes(scoringSystem)) {
    throw { code: 'INVALID_SCORING_SYSTEM', message: 'scoringSystem 必須為 rating_system 或 competition_management_v2' };
  }
  if (!Array.isArray(divisions) || divisions.length === 0) {
    throw { code: 'INVALID_DIVISIONS', message: '請至少設定一個組別' };
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date();
  const competition = {
    id, name, description: description || '',
    gymId: gymId || null,
    registrationStart, registrationEnd, eventDate,
    earlyBirdDeadline: earlyBirdDeadline || null,
    divisions: divisions.map(d => ({
      id: d.id || uuidv4(),
      name: d.name,
      maxParticipants: d.maxParticipants || 40,
      waitlistMax: d.waitlistMax || 5,
    })),
    // 費用設定
    fees: fees || {
      adultEarlyBird: 990, adultRegular: 1100,
      childEarlyBird: 840, childRegular: 950,
      teamMemberDiscount: 0.9,
      childAgeLimit: 15, // 幾歲以下算兒童
    },
    // 退費政策（多組截止日+退款計算）
    refundPolicies: refundPolicies || [],
    customFields: (customFields || []).map(f => ({
      key: f.key, label: f.label, type: f.type || 'text', required: !!f.required, options: f.options || null,
    })),
    waiverContent: waiverContent || { zh: '', en: '' },
    scoringSystem,
    webhookUrl: webhookUrl || null,
    status: status || 'draft',
    createdBy: staffId, createdAt: now, updatedAt: now,
  };
  await db.collection(COLLECTIONS.COMPETITIONS).doc(id).set(competition);
  return competition;
};

const updateCompetition = async (competitionId, updates) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId);
  const doc = await ref.get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此賽事' };

  if (updates.scoringSystem && !SCORING_SYSTEMS.includes(updates.scoringSystem)) {
    throw { code: 'INVALID_SCORING_SYSTEM', message: 'scoringSystem 不正確' };
  }

  const allowed = ['name', 'description', 'gymId', 'registrationStart', 'registrationEnd', 'earlyBirdDeadline', 'eventDate',
    'divisions', 'customFields', 'waiverContent', 'scoringSystem', 'webhookUrl', 'status', 'fees', 'refundPolicies'];
  const payload = { updatedAt: new Date() };
  allowed.forEach(f => { if (updates[f] !== undefined) payload[f] = updates[f]; });

  await ref.update(payload);
  return { id: competitionId, ...doc.data(), ...payload };
};

const getCompetitions = async (status) => {
  const db = getDb();
  let ref = db.collection(COLLECTIONS.COMPETITIONS);
  if (status) ref = ref.where('status', '==', status);
  const snap = await ref.get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
};

const getCompetition = async (competitionId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.COMPETITIONS).doc(competitionId).get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此賽事' };
  return { id: doc.id, ...doc.data() };
};

// ══════════════════════════════════════════════════════
// 報名（含風險聲明書簽署）
// ══════════════════════════════════════════════════════

const registerForCompetition = async ({
  competitionId, memberId, memberName, isMinor, divisionId,
  customFieldValues, signatureData, parentEmail, parentName, parentPhone, parentRelation,
  // 保險用欄位
  idNumber, emergencyContact, emergencyPhone,
  // 比賽用欄位
  height, armSpan, isHonorary,
  // 付款
  paymentDate, bankLastFive, paymentMethod,
  ip
}) => {
  const db = getDb();
  const competition = await getCompetition(competitionId);

  if (competition.status !== 'open') {
    throw { code: 'REGISTRATION_CLOSED', message: '此賽事目前未開放報名' };
  }
  const today = dayjs().format('YYYY-MM-DD');
  if (competition.registrationEnd && today > competition.registrationEnd) {
    throw { code: 'REGISTRATION_ENDED', message: '報名期限已截止' };
  }
  if (!competition.divisions.some(d => d.id === divisionId)) {
    throw { code: 'INVALID_DIVISION', message: '組別不正確' };
  }

  // 檢查組別人數上限
  const division = competition.divisions.find(d => d.id === divisionId);
  const existingSnap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS || 'competitionRegistrations')
    .where('competitionId', '==', competitionId)
    .where('divisionId', '==', divisionId)
    .where('status', 'in', ['confirmed', 'waitlist'])
    .get();
  const confirmedCount = existingSnap.docs.filter(d => d.data().status === 'confirmed').length;
  const waitlistCount = existingSnap.docs.filter(d => d.data().status === 'waitlist').length;
  const maxParticipants = division.maxParticipants || 40;
  const waitlistMax = division.waitlistMax || 5;
  if (confirmedCount >= maxParticipants && waitlistCount >= waitlistMax) {
    throw { code: 'DIVISION_FULL', message: '此組別已滿（含候補），無法報名' };
  }
  const isWaitlist = confirmedCount >= maxParticipants;

  // 計算費用
  const fees = competition.fees || {};
  const todayStr = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
  const isEarlyBird = competition.earlyBirdDeadline && todayStr <= competition.earlyBirdDeadline;
  const childAgeLimit = fees.childAgeLimit || 15;
  const memberBirthday = null; // 由呼叫方傳入 birthday 計算
  const isChild = isMinor && false; // 待擴充：由 member.birthday 計算年齡
  let registrationFee = isChild
    ? (isEarlyBird ? fees.childEarlyBird : fees.childRegular) || 950
    : (isEarlyBird ? fees.adultEarlyBird : fees.adultRegular) || 1100;

  // 驗證必填自訂欄位
  for (const f of competition.customFields) {
    if (f.required && !customFieldValues?.[f.key]) {
      throw { code: 'MISSING_FIELD', message: `請填寫「${f.label}」` };
    }
  }

  const registrationId = uuidv4();
  const now = new Date();
  // 簽名上傳（失敗不阻斷報名）
  let memberSignatureUrl = null;
  try {
    memberSignatureUrl = await uploadSignature(`competition_${registrationId}`, 'member', signatureData);
  } catch (sigErr) { /* 簽名上傳失敗不影響報名，後續補簽 */ }

  const registration = {
    id: registrationId, competitionId, competitionName: competition.name,
    memberId, memberName, divisionId, divisionName: division.name,
    status: isWaitlist ? 'waitlist' : 'confirmed',
    waitlistPosition: isWaitlist ? waitlistCount + 1 : null,
    customFieldValues: customFieldValues || {},
    // 保險用欄位
    idNumber: idNumber || null,
    emergencyContact: emergencyContact || null,
    emergencyPhone: emergencyPhone || null,
    // 比賽欄位
    height: height || null,
    armSpan: armSpan || null,
    isHonorary: !!isHonorary,
    isMinor: !!isMinor,
    // 費用
    registrationFee,
    isEarlyBird: !!isEarlyBird,
    // 付款
    paymentMethod: paymentMethod || 'transfer',
    paymentDate: paymentDate || null,
    bankLastFive: bankLastFive || null,
    paymentStatus: 'pending', // pending | confirmed | refunded
    paidAmount: null,
    paidAt: null,
    paidConfirmedBy: null,
    memberSignatureUrl, memberSignedAt: now, memberSignedIp: ip || null,
    parentRequired: !!isMinor,
    isComplete: !isMinor,
    webhookStatus: 'pending', webhookSentAt: null, webhookError: null,
    registeredAt: now,
  };

  if (isMinor) {
    const token = uuidv4();
    const expiry = dayjs().add(parseInt(process.env.WAIVER_PARENT_TOKEN_HOURS) || 72, 'hour').toDate();
    Object.assign(registration, {
      parentName: parentName || null, parentEmail, parentPhone: parentPhone || null, parentRelation: parentRelation || null,
      parentSignToken: token, parentSignTokenExpiry: expiry,
    });
  }

  await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId).set(registration);

  if (isMinor && parentEmail) {
    const emailService = require('./emailService');
    try {
      await emailService.sendParentWaiverLink(registrationId, memberName, parentEmail, parentName, registration.parentSignToken);
    } catch (e) {
      console.error('比賽報名家長簽署Email發送失敗（會員本人報名已成功保存）:', e.message);
    }
  } else {
    // 成年人報名，立即完成，觸發webhook
    await sendWebhook(registrationId);
  }

  return registration;
};

// ── 家長遠端簽署比賽風險聲明書（沿用waiver的token機制）─────────────
const signParentCompetitionWaiver = async (token, signatureData, ip) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('parentSignToken', '==', token).limit(1).get();
  if (snap.empty) throw { code: 'INVALID_TOKEN', message: '連結無效或已過期' };

  const doc = snap.docs[0];
  const registration = doc.data();
  if (registration.isComplete) throw { code: 'ALREADY_SIGNED', message: '已完成簽署' };
  if (dayjs().isAfter(dayjs(registration.parentSignTokenExpiry.toDate ? registration.parentSignTokenExpiry.toDate() : registration.parentSignTokenExpiry))) {
    throw { code: 'TOKEN_EXPIRED', message: '連結已過期，請聯絡館方重新發送' };
  }

  const parentSignatureUrl = await uploadSignature(`competition_${doc.id}`, 'parent', signatureData);
  const now = new Date();
  await doc.ref.update({
    parentSignatureUrl, parentSignedAt: now, parentSignedIp: ip || null,
    isComplete: true,
    parentSignToken: null, parentSignTokenExpiry: null,
  });

  await sendWebhook(doc.id);
  return { registrationId: doc.id };
};

// ══════════════════════════════════════════════════════
// Webhook 推送至計分系統
// ══════════════════════════════════════════════════════

const sendWebhook = async (registrationId) => {
  const db = getDb();
  const ref = db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId);
  const doc = await ref.get();
  if (!doc.exists) return;
  const registration = doc.data();

  const competition = await getCompetition(registration.competitionId);

  if (!competition.webhookUrl) {
    await ref.update({ webhookStatus: 'skipped', webhookError: '此賽事尚未設定計分系統webhook網址' });
    return;
  }

  const payload = {
    registrationId, competitionId: competition.id, competitionName: competition.name,
    scoringSystem: competition.scoringSystem,
    memberId: registration.memberId, memberName: registration.memberName,
    divisionId: registration.divisionId,
    divisionName: competition.divisions.find(d => d.id === registration.divisionId)?.name || '',
    customFieldValues: registration.customFieldValues,
    registeredAt: registration.registeredAt,
  };

  try {
    const res = await fetch(competition.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await ref.update({ webhookStatus: 'sent', webhookSentAt: new Date(), webhookError: null });
  } catch (err) {
    await ref.update({ webhookStatus: 'failed', webhookError: err.message });
  }
};

// ── 手動重新推送（webhook失敗或URL剛補上時使用）─────────────────────
const retryWebhook = async (registrationId) => {
  const db = getDb();
  const doc = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId).get();
  if (!doc.exists) throw { code: 'NOT_FOUND', message: '找不到此報名紀錄' };
  if (!doc.data().isComplete) throw { code: 'NOT_COMPLETE', message: '尚未完成簽署（可能等待家長簽署中），無法推送' };
  await sendWebhook(registrationId);
  const updated = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS).doc(registrationId).get();
  return { id: registrationId, ...updated.data() };
};

const getCompetitionRegistrations = async (competitionId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('competitionId', '==', competitionId)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.registeredAt?._seconds || 0) - (b.registeredAt?._seconds || 0));
};

const getMemberRegistrations = async (memberId) => {
  const db = getDb();
  const snap = await db.collection(COLLECTIONS.COMPETITION_REGISTRATIONS)
    .where('memberId', '==', memberId)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.registeredAt?._seconds || b.createdAt?._seconds || 0) - (a.registeredAt?._seconds || a.createdAt?._seconds || 0));
};

module.exports = {
  SCORING_SYSTEMS,
  createCompetition, updateCompetition, getCompetitions, getCompetition,
  registerForCompetition, signParentCompetitionWaiver,
  sendWebhook, retryWebhook,
  getCompetitionRegistrations, getMemberRegistrations,
};
