/**
 * emailService.js - 使用 Resend HTTP API 發送 Email
 * Railway 封鎖 SMTP，改用 Resend REST API
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@redrocktaiwan.com';
const FROM_NAME = '紅石攀岩 RedRock';
const CLIENT_URL = process.env.CLIENT_URL || 'https://app.redrocktaiwan.com';

/**
 * 核心發信函式
 */
const sendEmail = async ({ to, subject, html, text }) => {
  if (!RESEND_API_KEY) {
    console.warn('[Email] RESEND_API_KEY 未設定，跳過發信');
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text: text || subject,
      }),
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
  const token = require('crypto').randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 24 * 3600 * 1000);

  await db.collection(COLLECTIONS.MEMBERS).doc(memberId).update({
    emailVerifyToken: token,
    emailVerifyExpiry: expiry,
  });

  const verifyUrl = `${process.env.API_URL || 'https://redrock-api-production.up.railway.app'}/members/verify-email/${token}`;

  return sendEmail({
    to: email,
    subject: '【紅石攀岩】請驗證您的 Email',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
        <p>親愛的 ${name}，</p>
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
        <p>親愛的 ${memberName}，</p>
        <p>您有一堂課程即將開始：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>課程：</strong>${courseName}</div>
          <div><strong>日期：</strong>${sessionDate}</div>
          <div><strong>時間：</strong>${sessionTime}</div>
          <div><strong>場館：</strong>${gymName}</div>
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
        <p>親愛的 ${memberName}，</p>
        <p>您有一筆分期付款即將到期：</p>
        <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>項目：</strong>${itemName}</div>
          <div><strong>金額：</strong>NT$${amount}</div>
          <div><strong>到期日：</strong>${dueDate}</div>
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
    `<tr><td style="padding:6px">${o.memberName}</td><td style="padding:6px">${o.itemName}</td><td style="padding:6px">NT$${o.amount}</td><td style="padding:6px">${o.dueDate}</td></tr>`
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

// ── 體驗課程確認信 ────────────────────────────────────────────────
const sendExperienceBookingConfirmation = async (memberEmail, memberName, booking) => {
  return sendEmail({
    to: memberEmail,
    subject: '【紅石攀岩】體驗課程預約確認',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">體驗課程預約確認</h2>
        <p>親愛的 ${memberName}，</p>
        <p>您的體驗課程預約已確認收款！</p>
        <div style="background:#E6F4EB;border-radius:8px;padding:16px;margin:16px 0">
          <div><strong>日期：</strong>${booking.bookingDate}</div>
          <div><strong>時間：</strong>${booking.bookingTime}</div>
          <div><strong>場館：</strong>${booking.gymId === 'gym-hsinchu' ? '新竹館' : '士林館'}</div>
          <div><strong>人數：</strong>${booking.numParticipants} 人</div>
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
    subject: `【紅石攀岩】請完成 ${memberName} 的家長同意簽署`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#8B1A1A">紅石攀岩 RedRock</h2>
        <p>${parentName || '家長'} 您好，</p>
        <p>未成年會員 <strong>${memberName}</strong> 已完成風險自負同意書簽署，需法定代理人（家長）一同簽署才能生效。</p>
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

module.exports = {
  sendEmail,
  sendEmailVerification,
  sendCourseNotification,
  sendInstallmentReminder,
  sendInstallmentOverdueAlert,
  sendExperienceBookingConfirmation,
  sendInstallmentReminders,
  sendParentWaiverLink,
};
