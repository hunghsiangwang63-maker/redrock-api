/*
 * registrationNotify.js — 課程／工作坊／比賽 報名通知信（報名收到 + 確認收款兩封）
 *  cc：一律副本該館 email（gyms.<gymId>.email）；運動按摩工作坊另副本 seven2170923@gmail.com。
 *  運動按摩：報名收到信「不附匯款帳號」；確認收款信附 7 點注意事項。
 *  皆非同步呼叫、以 try/catch 包住，寄信失敗不阻斷報名/收款主流程。
 */
const { getDb } = require('../config/firebase');
const emailService = require('./emailService');

const MASSAGE_CC = 'seven2170923@gmail.com';
const isMassage = (name) => /運動按摩/.test(String(name || ''));

// 運動按摩「確認報名」信附註意事項（7 點）
const MASSAGE_NOTICE_HTML = `
  <div style="background:#F7F3F3;border-radius:8px;padding:16px;margin:14px 0;font-size:13px;line-height:1.9;text-align:left;color:#333">
    <div style="font-weight:600;color:#8B1A1A;margin-bottom:6px">您已完成運動按摩預約，以下為提醒注意事項：</div>
    <div>1. 因資源有限，每人限預約一次。待未來週期拉長，再行開放多次預約。</div>
    <div>2. 請記住您預約時段，著輕便衣物(短袖/短褲)，女性請著運動內衣，並提早 10 分鐘向櫃檯報到。</div>
    <div>3. 運動按摩會有肢體碰觸，若不能接受，請勿報名。</div>
    <div>4. 若欲調整預約時段，請自行協調其他隊員調換，並於隊員 LINE 群尋求轉讓。</div>
    <div>5. 運動按摩會在岩館進行，現場備有按摩床，唯因場地空間限制，預計放在單槓架中間，若您會覺得不自在，請把機會讓給其他人。</div>
    <div>6. 請自備大、小毛巾作為按摩過程使用。</div>
    <div>7. 按摩床為岩館無償借用，使用前後請協助清潔。</div>
  </div>`;

const resolveGymEmail = async (db, gymId) => {
  if (!gymId) return null;
  const d = await db.collection('gyms').doc(gymId).get();
  return d.exists ? (d.data().email || null) : null;
};

const resolveBank = async (db, gymId) => {
  if (!gymId) return null;
  const d = await db.collection('systemSettings').doc('bankAccounts').get();
  const b = d.exists ? (d.data()[gymId] || null) : null;
  return b ? { bankName: b.bankName, branch: b.notes || '', account: b.accountNumber, accountName: b.accountName } : null;
};

const resolveMemberEmail = async (db, memberId) => {
  if (!memberId) return null;
  const d = await db.collection('members').doc(memberId).get();
  return d.exists ? (d.data().email || null) : null;
};

// 報名收到（請完成繳費）
async function notifyRegReceived({ memberId, to, memberName, typeLabel, itemName, gymId, fee, paymentMethod, massage }) {
  try {
    const db = getDb();
    const email = to || await resolveMemberEmail(db, memberId);
    if (!email) return;
    const cc = [await resolveGymEmail(db, gymId), massage ? MASSAGE_CC : null].filter(Boolean);
    // 運動按摩不附匯款帳號
    const bank = (paymentMethod === 'transfer' && !massage) ? await resolveBank(db, gymId) : null;
    await emailService.sendRegistrationReceived(email, { cc, typeLabel, memberName, itemName, gymId, fee, paymentMethod, bank });
  } catch (e) { console.error('[Email] 報名收到通知', e.message); }
}

// 確認收款（已收款；運動按摩附注意事項）
async function notifyRegConfirmed({ memberId, to, memberName, typeLabel, itemName, gymId, massage }) {
  try {
    const db = getDb();
    const email = to || await resolveMemberEmail(db, memberId);
    if (!email) return;
    const cc = [await resolveGymEmail(db, gymId), massage ? MASSAGE_CC : null].filter(Boolean);
    await emailService.sendRegistrationConfirmed(email, {
      cc, typeLabel, memberName, itemName, gymId,
      extraNoticeHtml: massage ? MASSAGE_NOTICE_HTML : null,
    });
  } catch (e) { console.error('[Email] 報名確認通知', e.message); }
}

module.exports = { notifyRegReceived, notifyRegConfirmed, isMassage };
