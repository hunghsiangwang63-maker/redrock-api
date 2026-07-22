/*
 * simulateRegistration.js — 員工端「模擬報名」驗證工具
 *  目的：課程梯次（週課/專班/工作坊）、體驗課程、比賽 設定完成後，員工可一鍵模擬跑一次報名表流程，
 *        確認「流程是否正常、資訊（費用/欄位/規則）是否正確、報名確認信內容是否正確」。
 *  ⚠️ 不佔名額：完全不寫真實集合（不建會員 / 不建報名 / 不動場次 enrolledCount），
 *     只用真實的費用/規則/表單邏輯「算出這張報名表的內容」＋寄真實確認信＋寫一筆 simulationRuns 日誌。
 *  ⚠️ 自動刪除：simulationRuns 日誌 10 分鐘後自動刪（setTimeout 為主，setInterval backstop 補殺重啟遺漏）。
 */
const express = require('express');
const router = express.Router();
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { authenticate, requireManagerOrStation } = require('../middleware/auth');
const { taiwanToday } = require('../utils/taiwanDate');
const emailService = require('../services/emailService');
const courseService = require('../services/courseService');
const experienceService = require('../services/experienceService');

const SIM_COLL = 'simulationRuns';
const TTL_MIN = 10;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GYM_LABEL = { 'gym-hsinchu': '新竹館', 'gym-shilin': '士林館' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const esc = emailService.esc;
const SIM_NAME = '【模擬報名】測試';

const dateLabel = (d) => `${d}（${WD[dayjs(d).day()]}）`;

// 排程刪除該筆 simulationRuns（記憶體 setTimeout；伺服器重啟由 backstop 補殺）
const scheduleDelete = (id) => {
  setTimeout(async () => {
    try { await getDb().collection(SIM_COLL).doc(id).delete(); } catch (e) { /* 已刪/斷線，backstop 會補 */ }
  }, TTL_MIN * 60 * 1000);
};

// 寫入模擬日誌 + 排程刪除
const recordRun = async (data) => {
  const id = uuidv4();
  const now = new Date();
  await getDb().collection(SIM_COLL).doc(id).set({
    id, ...data, createdAt: now, expiresAt: new Date(now.getTime() + TTL_MIN * 60000),
  });
  scheduleDelete(id);
  return id;
};

// backstop：清掉過期未刪的模擬日誌（重啟後 setTimeout 遺失時補殺）
const sweepStaleSimulations = async () => {
  try {
    const db = getDb();
    const snap = await db.collection(SIM_COLL).get();
    const now = Date.now();
    let n = 0;
    for (const d of snap.docs) {
      const exp = d.data().expiresAt;
      const ms = exp?.toMillis ? exp.toMillis() : (exp ? new Date(exp).getTime() : 0);
      if (ms && ms < now) { await d.ref.delete(); n++; }
    }
    if (n) console.log(`[simulate] backstop 清除過期模擬日誌 ${n} 筆`);
  } catch (e) { /* ignore */ }
};
// 每 5 分鐘 backstop（模組載入即啟動一次；首跳 5 分後）
if (!global.__simSweepStarted) {
  global.__simSweepStarted = true;
  setInterval(sweepStaleSimulations, 5 * 60 * 1000);
}

// ── POST /simulate/registration — 模擬一次報名表流程 ──
router.post('/registration', authenticate, requireManagerOrStation, async (req, res) => {
  try {
    const db = getDb();
    const { type, targetId, sessionId, divisionId } = req.body;
    const to = String(req.body.email || '').trim();
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'INVALID_EMAIL', message: '請輸入有效的收件 Email' });
    const staffId = req.staff?.id || req.operator?.id || null;

    // ─────────── 課程（週課 / 專班 / 工作坊）───────────
    if (type === 'course') {
      const cDoc = await db.collection('courses').doc(targetId).get();
      if (!cDoc.exists) return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: '找不到課程梯次' });
      const course = cDoc.data();
      const cat = await courseService.getCategoryOf(db, course.categoryId).catch(() => null);
      const rules = courseService.resolveRules(course, cat);
      const isWorkshop = course.type === 'workshop';
      const today = taiwanToday();

      const ssSnap = await db.collection('courseSessions')
        .where('courseId', '==', targetId).where('status', '==', 'scheduled').get();
      let sessions = ssSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
      if (isWorkshop) {
        const chosen = sessionId ? sessions.find(s => s.id === sessionId) : sessions[0];
        sessions = chosen ? [chosen] : [];
      }
      if (!sessions.length) return res.status(400).json({ error: 'NO_SESSIONS', message: '此課程目前無可報名的未來場次' });

      const fee = course.price || 0;
      const gymName = GYM_LABEL[course.gymId] || '';
      const sessionLines = sessions.map(s => `${dateLabel(s.date)} ${s.startTime || ''}~${s.endTime || ''}`);
      const paymentMethods = (course.paymentMethods && course.paymentMethods.length) ? course.paymentMethods : ['cash', 'transfer'];
      const payLabel = paymentMethods.map(m => ({ cash: '現金', transfer: '轉帳', linepay: 'LinePay', jkopay: '街口', taiwanpay: '台灣Pay' }[m] || m)).join('、');
      const formFields = {
        skipSignature: course.skipSignature === true,
        collectGenderAge: course.collectGenderAge === true,
        enrollNoteLabel: course.enrollNoteLabel || null,
        enrollNoteRequired: course.enrollNoteRequired === true,
        paymentMethods,
      };
      const rulesSummary = isWorkshop ? null : {
        maxLeaves: rules.maxLeaves, leaveDeadlineHours: rules.leaveDeadlineHours,
        allowMakeup: rules.allowMakeup, makeupDeadlineDays: rules.makeupDeadlineDays,
        preStartFeeRate: rules.preStartFeeRate, handlingFeeRate: rules.handlingFeeRate,
      };

      await emailService.sendEmail({
        to,
        subject: `【紅石攀岩・模擬】課程報名確認 — ${course.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <div style="background:#FFF4E5;border:1px solid #F0D9A8;border-radius:8px;padding:10px 14px;font-size:13px;color:#8B6914;margin-bottom:16px">🧪 這是一封<strong>模擬報名</strong>測試信，用於確認報名確認信內容是否正確，非真實報名。</div>
            <h2 style="color:#8B1A1A">課程報名確認</h2>
            <p>親愛的 ${esc(SIM_NAME)}，</p>
            <p>您已完成報名 <strong>「${esc(course.name)}」</strong>：</p>
            <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;line-height:1.9">
              <div><strong>課程：</strong>${esc(course.name)}</div>
              <div><strong>場館：</strong>${esc(gymName)}</div>
              <div><strong>${isWorkshop ? '場次' : '共 ' + sessions.length + ' 堂'}：</strong>${esc(sessionLines[0])}${sessions.length > 1 ? ` 起，共 ${sessions.length} 堂` : ''}</div>
              <div><strong>應繳金額：</strong>NT$${esc(Number(fee).toLocaleString())}</div>
              <div><strong>付款方式：</strong>${esc(payLabel)}</div>
            </div>
            <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
          </div>`,
      }).catch(e => { throw { code: 'EMAIL_FAILED', message: '寄信失敗：' + (e.message || e.code) }; });

      const runId = await recordRun({ type, targetId, targetName: course.name, gymId: course.gymId || null, email: to, fee, sessionCount: sessions.length, byStaff: staffId });
      return res.json({
        ok: true, runId, type: 'course', emailedTo: to, expiresInMin: TTL_MIN,
        summary: { name: course.name, gym: gymName, isWorkshop, fee, sessionCount: sessions.length, sessions: sessionLines, paymentLabel: payLabel, formFields, rules: rulesSummary },
      });
    }

    // ─────────── 體驗課程 ───────────
    if (type === 'experience') {
      const sDoc = await db.collection('systemSettings').doc('experienceCourses').get();
      const settings = sDoc.exists ? sDoc.data() : experienceService.defaultSettings();
      const ct = (settings.courseTypes || []).find(c => c.id === targetId);
      if (!ct) return res.status(404).json({ error: 'COURSE_TYPE_NOT_FOUND', message: '找不到體驗課程類型' });

      const numPeople = 1;
      // 體驗費解析：階梯(tiers min~max) / 固定(price) / priceMap；體驗費已含保險
      const resolveExpPrice = (t, n) => {
        if (Array.isArray(t.tiers) && t.tiers.length) {
          const hit = t.tiers.find(x => n >= (x.min ?? 1) && n <= (x.max ?? 999));
          return (hit ? hit.price : t.tiers[0].price) || 0;
        }
        if (t.price != null) return t.price;
        if (t.priceMap) return t.priceMap[String(n)] ?? t.priceMap[n] ?? Object.values(t.priceMap)[0] ?? 0;
        return 0;
      };
      const fee = resolveExpPrice(ct, numPeople) * numPeople; // 每人單價（含保險）× 人數
      const bookingDate = dayjs(taiwanToday()).add(3, 'day').format('YYYY-MM-DD');
      const bookingTime = '14:00-16:00';
      const fakeBooking = { bookingDate, bookingTime, gymId: 'gym-hsinchu', numParticipants: numPeople };

      await emailService.sendExperienceBookingConfirmation(to, SIM_NAME, fakeBooking)
        .catch(e => { throw { code: 'EMAIL_FAILED', message: '寄信失敗：' + (e.message || e.code) }; });

      const runId = await recordRun({ type, targetId, targetName: ct.label, email: to, fee, byStaff: staffId });
      return res.json({
        ok: true, runId, type: 'experience', emailedTo: to, expiresInMin: TTL_MIN,
        summary: {
          name: ct.label, fee, numPeople, bookingDate: dateLabel(bookingDate), bookingTime,
          formFields: { fields: ['場館', '課程類型', '日期', '希望時段', '參加者姓名', '身分證字號', '生日', '聯絡人姓名/電話/Email', '付款方式（轉帳）'], note: '體驗費已含保險；未成年需現場簽署免責' },
        },
      });
    }

    // ─────────── 比賽 ───────────
    if (type === 'competition') {
      const compDoc = await db.collection('competitions').doc(targetId).get();
      if (!compDoc.exists) return res.status(404).json({ error: 'COMPETITION_NOT_FOUND', message: '找不到賽事' });
      const comp = compDoc.data();
      const division = (comp.divisions || []).find(d => d.id === divisionId) || (comp.divisions || [])[0];
      if (!division) return res.status(400).json({ error: 'NO_DIVISION', message: '此賽事尚未設定組別' });

      const fees = comp.fees || {};
      const today2 = taiwanToday();
      const isEarly = comp.earlyBirdDeadline && today2 <= comp.earlyBirdDeadline;
      // 模擬選手＝成人、非隊員、非友館
      const fee = isEarly ? (fees.adultEarlyBird ?? 990) : (fees.adultRegular ?? 1100);
      const eventDate = comp.eventDate || comp.competitionDate || '';

      await emailService.sendEmail({
        to,
        subject: `【紅石攀岩・模擬】比賽報名確認 — ${comp.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <div style="background:#FFF4E5;border:1px solid #F0D9A8;border-radius:8px;padding:10px 14px;font-size:13px;color:#8B6914;margin-bottom:16px">🧪 這是一封<strong>模擬報名</strong>測試信，用於確認報名確認信內容是否正確，非真實報名。</div>
            <h2 style="color:#8B1A1A">比賽報名確認</h2>
            <p>親愛的 ${esc(SIM_NAME)}，</p>
            <p>您已完成報名 <strong>「${esc(comp.name)}」</strong>：</p>
            <div style="background:#FBF5F5;border-radius:8px;padding:16px;margin:16px 0;font-size:14px;line-height:1.9">
              <div><strong>賽事：</strong>${esc(comp.name)}</div>
              <div><strong>組別：</strong>${esc(division.name)}</div>
              <div><strong>比賽日：</strong>${esc(eventDate)}</div>
              <div><strong>報名費：</strong>NT$${esc(Number(fee).toLocaleString())}${isEarly ? '（早鳥）' : ''}</div>
            </div>
            <p style="color:#999;font-size:12px">紅石攀岩 RedRock | redrocktaiwan.com</p>
          </div>`,
      }).catch(e => { throw { code: 'EMAIL_FAILED', message: '寄信失敗：' + (e.message || e.code) }; });

      const runId = await recordRun({ type, targetId, targetName: comp.name, email: to, fee, byStaff: staffId });
      return res.json({
        ok: true, runId, type: 'competition', emailedTo: to, expiresInMin: TTL_MIN,
        summary: {
          name: comp.name, division: division.name, divisions: (comp.divisions || []).map(d => d.name),
          fee, isEarly, eventDate,
          formFields: { needsSignature: true, fields: ['報名組別', '性別', '生日', '手機', 'Email', '身分證/護照', '緊急聯絡人（姓名/關係/電話）', '身高', '臂展', '榮譽參賽', '會員備註', '本人簽名（未成年加法定代理人）'] },
        },
      });
    }

    return res.status(400).json({ error: 'INVALID_TYPE', message: 'type 須為 course / experience / competition' });
  } catch (err) {
    if (err.code === 'EMAIL_FAILED') return res.status(502).json({ error: 'EMAIL_FAILED', message: err.message });
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

module.exports = router;
module.exports.sweepStaleSimulations = sweepStaleSimulations;
