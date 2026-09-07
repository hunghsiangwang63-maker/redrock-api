// ⚠️ 臨時診斷路由（比照本專案既有慣例）——把剛補寄的士林紅石9月課程（技巧班/小蜘蛛人）課程服務同意書
// 各再寄一份到館方信箱存檔，super_admin 限定，用完即從 index.js 移除並刪除此檔。
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');

const COURSE_IDS = [
  '78f3b70e-0e81-424c-b59c-6e8b4fd483e4',
  '63951125-500a-485f-af48-99e14499fd74',
  '53a7efdc-fc8d-4d8d-8229-9983bbbb0168',
];
const TARGET_EMAIL = 'redrocktaiwan@gmail.com';

router.post('/', authenticate, async (req, res) => {
  if (req.staff.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN' });
  const db = getDb();
  const { sendCourseContractPdf } = require('../services/emailService');
  const results = [];

  const snap = await db.collection('courseContracts').get();
  const contracts = snap.docs.map(d => d.data()).filter(c => COURSE_IDS.includes(c.courseId));

  const bucket = getStorage().bucket();
  for (const c of contracts) {
    try {
      const file = bucket.file(`course-contracts/${c.id}.pdf`);
      const [pdfBuffer] = await file.download();
      await sendCourseContractPdf({ to: TARGET_EMAIL, memberName: c.memberName, courseName: c.courseName, pdfBuffer });
      results.push({ name: c.memberName, course: c.courseName, ok: true });
    } catch (e) {
      results.push({ name: c.memberName, course: c.courseName, ok: false, reason: e.message });
    }
  }
  res.json({ target: TARGET_EMAIL, count: contracts.length, results });
});

module.exports = router;
