/**
 * emailService.js - 使用 Resend HTTP API 發送 Email
 * Railway 封鎖 SMTP，改用 Resend REST API
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@redrocktaiwan.com';
const FROM_NAME = '紅石攀岩 RedRock';
const CLIENT_URL = process.env.CLIENT_URL || 'https://app.redrocktaiwan.com';

// HTML 跳脫：避免使用者可控字串（姓名/課程名/項目名等）注入 HTML 進信件內容
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/**
 * 核心發信函式
 */
const sendEmail = async ({ to, cc, subject, html, text, attachments }) => {
  if (!RESEND_API_KEY) {
    console.warn('[Email] RESEND_API_KEY 未設定，跳過發信');
    return { skipped: true };
  }
  try {
    const payload = {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || subject,
    };
    // 副本收件人（選填；字串或陣列）
    const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).filter(Boolean);
    if (ccList.length) payload.cc = ccList;
    // 附件：Resend 格式 [{ filename, content(base64 字串) }]
    if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Resend error ${res.status}`);
    console.log(`[Email] 已發送 "${subject}" → ${to} (id: ${data.id})`);
    return { success: true, id: data.id };
  } catch (err) {
    console.error('[Email] 發送失敗:', err.message);
    return { error: err.message };
  }
};

// ── Email 驗證信 ────────────────────────────────────────────────
const sendEmailVerification = async (memberId, email, name) => {
  const { getDb, COLLECTIONS } = require('../config/firebase');
  const db = getDb();
  // 沿用未過期的既有 token（重寄多封信連結一致、點任一封都有效），過期/沒有才換新
  const mDoc = await db.collection(COLLECTIONS.MEMBERS).doc(memberId).get();
  const cur = mDoc.exists ? mDoc.data() : {};
  const curExpiry = cur.emailVerifyExpiry?.toDate?.() || null;
  let token = (cur.emailVerifyToken && curExpiry && curExpiry > new Date()) ? cur.emailVerifyToken : null;
  const expiry = new Date(Date.now() + 24 * 3600 * 1000);
  if (!token) token = require('crypto').randomBytes(32).toString('hex');

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
    emailVerifyToken: token,
    emailVerifyExpiry: expiry,   // 效期一律展延 24 小時
  });

  const verifyUrl = `${process.env.API_URL || 'https://redrock-api-production.up.railway.app'}/members/verify-email/${token}`;

  return sendEmail({
    to: email,
    subject: '【紅石攀岩】請驗證您的 Email',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
        <p>親愛的 ${esc(name)}，</p>
        <p>感謝您註冊紅石攀岩會員！請點擊下方按鈕完成 Email 驗證：</p>
        <a href="${verifyUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#8B1A1A;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">
          ✉ 驗證 Email
        </a>
        <p style="color:#999;font-size:12px">此連結 24 小時內有效。若非本人操作請忽略此信。</p>
      </div>
    `,
  });
};

// ── 課程通知 ─────────────────────────────────────────────────────
const sendCourseNotification = async (memberEmail, memberName, courseName, sessionDate, sessionTime, gymName) => {
  return sendEmail({
    to: memberEmail,
    subject: `【紅石攀岩】課程提醒：${courseName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">課程提醒</h2>
        <p>親愛的 ${esc(memberName)}，</p>
        <p>您有一堂課程即將開始：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>課程：</strong>${esc(courseName)}</div>
          <div><strong>日期：</strong>${esc(sessionDate)}</div>
          <div><strong>時間：</strong>${esc(sessionTime)}</div>
          <div><strong>場館：</strong>${esc(gymName)}</div>
        </div>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
  });
};

// ── 分期付款提醒 ──────────────────────────────────────────────────
const sendInstallmentReminder = async (memberEmail, memberName, itemName, amount, dueDate) => {
  return sendEmail({
    to: memberEmail,
    subject: `【紅石攀岩】分期付款提醒 - ${itemName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">分期付款提醒</h2>
        <p>親愛的 ${esc(memberName)}，</p>
        <p>您有一筆分期付款即將到期：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>項目：</strong>${esc(itemName)}</div>
          <div><strong>金額：</strong>NT$${esc(amount)}</div>
          <div><strong>到期日：</strong>${esc(dueDate)}</div>
        </div>
        <p>請至館方完成繳款，謝謝。</p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
  });
};

// ── 分期逾期管理員通知 ────────────────────────────────────────────
const sendInstallmentOverdueAlert = async (adminEmail, overdueList) => {
  const rows = overdueList.map(o =>
    `<tr><td style="padding:6px">${esc(o.memberName)}</td><td style="padding:6px">${esc(o.itemName)}</td><td style="padding:6px">NT$${esc(o.amount)}</td><td style="padding:6px">${esc(o.dueDate)}</td></tr>`
  ).join('');
  return sendEmail({
    to: adminEmail,
    subject: `【紅石攀岩】${overdueList.length} 筆分期付款逾期`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#A32D2D">分期付款逾期通知</h2>
        <p>以下 ${overdueList.length} 筆分期付款已逾期：</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#FBF5F5">
            <th style="padding:8px;text-align:left">會員</th>
            <th style="padding:8px;text-align:left">項目</th>
            <th style="padding:8px;text-align:left">金額</th>
            <th style="padding:8px;text-align:left">到期日</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `,
  });
};

// ── 分期：會員到期前提醒（物件參數，含期數）──────────────────────
const sendInstallmentDueReminder = async ({ email, memberName, itemName, seq, totalSeq, amount, dueDate }) => {
  return sendEmail({
    to: email,
    subject: `【紅石攀岩】分期第 ${seq}/${totalSeq} 期即將到期 - ${itemName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">分期付款到期提醒</h2>
        <p>親愛的 ${esc(memberName)}，</p>
        <p>您有一筆分期付款即將到期，請於到期日前完成繳款：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>項目：</strong>${esc(itemName)}</div>
          <div><strong>期數：</strong>第 ${esc(seq)} / ${esc(totalSeq)} 期</div>
          <div><strong>金額：</strong>NT$${esc(Number(amount).toLocaleString())}</div>
          <div><strong>到期日：</strong>${esc(dueDate)}</div>
        </div>
        <p>逾期未繳將暫停入場資格，請至櫃檯或線上完成繳款，謝謝。</p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
  });
};

// ── 分期：會員逾期通知（物件參數，含期數）────────────────────────
const sendInstallmentOverdueNotice = async ({ email, memberName, itemName, seq, totalSeq, amount, dueDate }) => {
  return sendEmail({
    to: email,
    subject: `【紅石攀岩】分期第 ${seq}/${totalSeq} 期已逾期 - ${itemName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#A32D2D">分期付款逾期通知</h2>
        <p>親愛的 ${esc(memberName)}，</p>
        <p>您的分期付款已逾期，<strong>入場資格已暫停</strong>，請儘速完成繳款以恢復：</p>
        <div style="background:#FCEBEB;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>項目：</strong>${esc(itemName)}</div>
          <div><strong>期數：</strong>第 ${esc(seq)} / ${esc(totalSeq)} 期</div>
          <div><strong>金額：</strong>NT$${esc(Number(amount).toLocaleString())}</div>
          <div><strong>原到期日：</strong>${esc(dueDate)}</div>
        </div>
        <p>請至櫃檯或線上完成繳款，繳清後即可恢復入場，謝謝。</p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
  });
};

// ── 體驗課程確認信 ────────────────────────────────────────────────
const sendExperienceBookingConfirmation = async (memberEmail, memberName, booking) => {
  return sendEmail({
    to: memberEmail,
    subject: '【紅石攀岩】體驗課程預約確認',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">體驗課程預約確認</h2>
        <p>親愛的 ${esc(memberName)}，</p>
        <p>您的體驗課程預約已確認收款！</p>
        <div style="background:#E6F4EB;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>日期：</strong>${esc(booking.bookingDate)}</div>
          <div><strong>時間：</strong>${esc(booking.bookingTime)}</div>
          <div><strong>場館：</strong>${booking.gymId === 'gym-hsinchu' ? '新竹館' : '士林館'}</div>
          <div><strong>人數：</strong>${esc(booking.numParticipants)} 人</div>
        </div>
        <p>期待與您見面！如有疑問請聯繫館方。</p>
        <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
      </div>
    `,
  });
};

// ── 家長 Waiver 簽署連結 ─────────────────────────────────────────
const sendParentWaiverLink = async (memberId, memberName, parentEmail, parentName, token) => {
  const url = `${CLIENT_URL}/waiver/parent/${token}`;
  return sendEmail({
    to: parentEmail,
    subject: `【紅石攀岩】請完成 ${memberName} 的法定代理人簽署（風險安全聲明書＋墜落測驗同意書）`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
        <p>${esc(parentName || '法定代理人')} 您好，</p>
        <p>未成年會員 <strong>${esc(memberName)}</strong> 已完成本人簽署，需法定代理人（家長）一同簽署 <strong>風險安全聲明書</strong> 與 <strong>墜落測驗同意書</strong> 才能生效。</p>
        <p style="color:#666;font-size:13px">點擊下方連結，於同一頁面簽一次名即可完成兩份文件。</p>
        <a href="${url}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#8B1A1A;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">前往簽署</a>
        <p style="color:#999;font-size:12px">此連結 72 小時內有效。若非本人操作請忽略此信。</p>
      </div>
    `,
  });
};

// ── 比賽報名法定代理人簽署連結（比賽 token 在 competitionRegistrations、專屬頁 /competitions/waiver/parent）──
const sendParentCompetitionWaiverLink = async ({ memberName, competitionName, parentEmail, parentName, token }) => {
  const url = `${CLIENT_URL}/competitions/waiver/parent/${token}`;
  return sendEmail({
    to: parentEmail,
    subject: `【紅石攀岩】請完成 ${memberName} 的法定代理人簽署（${competitionName} 比賽風險聲明書）`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
        <p>${esc(parentName || '法定代理人')} 您好，</p>
        <p>未成年選手 <strong>${esc(memberName)}</strong> 已報名 <strong>${esc(competitionName)}</strong>，需法定代理人（家長／監護人）簽署比賽風險聲明書，報名才會生效。</p>
        <a href="${url}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#8B1A1A;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">前往簽署</a>
        <p style="color:#999;font-size:12px">此連結 72 小時內有效。若非本人操作請忽略此信。</p>
      </div>
    `,
  });
};

// ── 舊版相容介面 ─────────────────────────────────────────────────
const sendInstallmentReminders = async () => {
  console.log('[Email] sendInstallmentReminders called (stub)');
  return { reminderSent: 0, overdueSent: 0, adminNotified: 0 };
};

// 裝置驗證碼（員工/站台新裝置登入 OTP；效期 10 分鐘）
const sendDeviceVerificationCode = async (email, name, code) => {
  return sendEmail({
    to: email,
    subject: '【紅石攀岩】新裝置登入驗證碼',
    html: `<p>${esc(name || '')} 您好，</p>
<p>您正在新的裝置上登入紅石攀岩館系統，驗證碼：</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;">${esc(code)}</p>
<p>驗證碼 10 分鐘內有效。若非您本人操作，請忽略此信並通知管理員。</p>`,
  });
};

module.exports = {
  esc, // HTML 跳脫（供各路由組信件時共用）
  sendEmail,
  sendEmailVerification,
  sendCourseNotification,
  sendInstallmentReminder,
  sendInstallmentOverdueAlert,
  sendInstallmentDueReminder,
  sendInstallmentOverdueNotice,
  sendExperienceBookingConfirmation,
  sendInstallmentReminders,
  sendParentWaiverLink,
  sendParentCompetitionWaiverLink,
  sendDeviceVerificationCode,
};
