/**
 * 會員問題諮詢（2026-09-02 新增）：常見問題（靜態，含制式回覆，瀏覽不進待辦）
 * ＋自訂提問（會員自由輸入標題/內容，送出後進員工端待辦頁 pendingTasks.js，需人工回覆）。
 *
 * 集合：memberInquiries（僅存自訂提問，常見問題不落地任何記錄——瀏覽 FAQ 本就不用追蹤）。
 *   {memberId, memberName, memberPhone, subject, content, status:'pending'|'replied',
 *    reply, repliedAt, repliedByName, unread（會員尚未讀取「已有回覆」，讀取後清除，供底部
 *    導航角標使用）, createdAt, updatedAt}
 *
 * 常見問題內容：優先讀 systemSettings/memberFaq.items（供未來調整內容，目前無管理 UI，走
 * Firestore 直接編輯），未設定則回退 DEFAULT_FAQ（本檔案內建初始清單）。
 *
 * 權限：會員端（authenticateMember，僅本人）；員工端回覆（authenticate，任何登入員工皆可回覆——
 * 純溝通性質，不涉金流/庫存，不比照櫃檯動作限值班/管理員）。
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateMember } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const { notifyRoleInGym } = require('../services/notificationService');

const GYM_IDS = ['gym-hsinchu', 'gym-shilin'];

// 通知該館相關人員（gym_manager+super_admin，比照 courseService.notifyCourseManagers 同一套慣例）；
// 逐一 try/catch、不阻斷提問本身送出成功。
const notifyInquiryManagers = async ({ gymId, inquiryId, memberName, subject }) => {
  for (const role of ['gym_manager', 'super_admin']) {
    try {
      await notifyRoleInGym({
        gymId, role, type: 'member_inquiry',
        title: '會員問題諮詢', body: `${memberName} — ${subject}`,
        referenceId: inquiryId, referenceType: 'memberInquiry', link: '/staff/pending-tasks',
      });
    } catch (e) { console.error('notifyInquiryManagers 失敗', e.message); }
  }
};

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const DEFAULT_FAQ = [
  { id: 'forgot-password', question: '忘記密碼怎麼辦？', answer: '請至登入頁點選「忘記密碼」，輸入註冊時的 Email，系統會寄送重設密碼連結，設定新密碼後即可重新登入。' },
  { id: 'onboarding', question: '入場前為什麼要簽署文件、安排墜落測驗？', answer: '首次入場需完成「風險安全聲明書」與「墜落測驗同意書」簽署，並到館完成墜落測驗（由現場人員登記通過與否），以確保每位入場者都了解基本的抱石安全守則以及注意事項。全部完成後即可自助入場，不需每次臨櫃辦理。' },
  { id: 'no-phone', question: '手機沒電或忘記帶會員證，要怎麼入場？', answer: '可請櫃檯人員以您的電話號碼查詢會員資料協助入場，不需出示手機 QR code。' },
  { id: 'course-leave-makeup', question: '課程請假後可以補課嗎？操作方式與規定是什麼？', answer: '【請假】至「我的課程」找到該堂課展開後，點選「申請請假」（需於課前一定時數內申請，且有次數上限，各班規則不同）。已核准的請假若後來不需要了，可自行點「取消請假」銷假（須課程尚未開始、原堂名額未滿，且尚未動用該堂衍生的補課資格才能取消）。\n【補課】請假成立後，系統會自動核發一筆補課資格，顯示在「我的課程」頁上方「📋 補課資格」區塊（含到期日）。點選「選擇補課」即可挑選同館、相容班別的其他場次預約，需在補課期限內完成（通常為課程結束後一定天數，各班規則不同）。已預約的補課如需異動，可在上課前一天內自行取消，額度會退回可重新預約。\n各班別詳細規則（請假次數/時限、補課期限）可在課卡上的「📋 課程規則」查看。' },
  { id: 'pass-renewal', question: '定期票快到期了，可以在家線上續約嗎？', answer: '到期前 14 天內，可在「我的票券」直接使用線上支付續約，付款成功會立即延長票期。下次到館時記得提醒櫃檯人員補開發票。' },
  { id: 'minor-registration', question: '未成年會員報名課程/比賽需要準備什麼？', answer: '需填寫法定代理人姓名、電話與關係。系統會寄送一封 Email 給法定代理人，於同一個連結頁面完成「風險安全聲明書」與「墜落測驗同意書」的簽署，全程免臨櫃。' },
  { id: 'family-members', question: '如何新增家庭成員（子帳號）？資料會跟我混在一起嗎？', answer: '可至「個人資料」頁新增家庭成員（僅限未滿 18 歲）。家庭成員沒有獨立的登入帳號，由家長用自己的帳號登入後代為操作——報名課程/比賽、入場、購買票券、記錄路線完攀等，都可以選擇「為自己」或「為家庭成員」操作。雖然共用家長的登入帳號，但每位家庭成員的票券、課程進度、入場資格、積分等資料都是各自獨立計算與保存，不會互相混用或共用扣抵。通常於子帳號成員年滿 18 歲、需要獨立登入時，可直接在「個人資料」的家庭成員清單中，為該成員設定一組新的手機號碼、Email 與密碼即可完成升級，不需臨櫃辦理。升級後原有的票券、課程紀錄、入場歷史等資料都會完整保留，改用新的手機號碼獨立登入即可看到所有既有資料；升級後也會自動從您的家庭成員清單中移除，不再由您代為操作。' },
  { id: 'fall-test-expiry', question: '墜落測驗有效期限多久？快到期了要重測嗎？', answer: '墜落測驗通過後有一定效期（可在首頁查看目前效期）。在效期到期前 2 個月內入場，只要您過去一年內入場次數達 2 次以上，系統會自動延長效期 1 年，不需要重新測驗（每個效期週期最多自動延長一次）。若已經到期，或到期前不符合上述入館頻率，則需要重新安排並通過墜落測驗才能繼續入場。' },
  { id: 'transfer-deadline', question: '課程/比賽用轉帳付款，多久內要完成？被退回怎麼辦？', answer: '轉帳報名通常需在報名時間起 2~3 天內完成繳費，逾期未繳費會自動釋出名額（現金報名則由櫃檯人工確認，不受此限制）。若您的繳費資訊被退回，請至「我的課程」或「我的比賽」查看退回原因，並依指示重新上傳正確的匯款資訊。' },
  { id: 'team-application', question: '如何申請攀岩隊員資格？', answer: '請至「加入攀岩隊」頁填寫申請表並完成繳費，經館方確認收款後即開通隊員身份（享入場費 9 折優惠等權益），詳細隊籍效期以申請頁說明為準。' },
  { id: 'pass-adjustment', question: '想申請定期票退費/展延/轉讓，怎麼操作？', answer: '請至「我的票券」找到該張定期票，點選票券詳情內的「申請展延／退費／轉讓」（每張票限申請一次，需符合法定事由並上傳相關證明），送出後將由館方人員審核處理。' },
];

// ── GET /member-inquiries/faq：常見問題（含制式回覆） ──
router.get('/faq', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('memberFaq').get();
    const items = (doc.exists && Array.isArray(doc.data().items) && doc.data().items.length) ? doc.data().items : DEFAULT_FAQ;
    res.json({ items });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /member-inquiries/my：我的提問歷史（含待回覆/已回覆狀態） ──
router.get('/my', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('memberInquiries').where('memberId', '==', req.member.id).get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /member-inquiries/unread-count：底部導航角標用（有已回覆但尚未讀取的提問則 count>0） ──
router.get('/unread-count', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection('memberInquiries')
      .where('memberId', '==', req.member.id).where('unread', '==', true).count().get();
    res.json({ count: snap.data().count });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /member-inquiries：會員提出新問題（選擇相關場館+自訂標題+內容）；
//    送出後進員工端待辦，並通知該館 gym_manager+super_admin ──
router.post('/', authenticateMember,
  [
    body('gymId').isIn(GYM_IDS).withMessage('請選擇相關場館'),
    body('subject').trim().notEmpty().isLength({ max: 60 }).withMessage('請填寫標題（60字以內）'),
    body('content').trim().notEmpty().isLength({ max: 1000 }).withMessage('請填寫內容（1000字以內）'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const id = uuidv4();
      const now = new Date();
      const inquiry = {
        id, memberId: req.member.id, memberName: req.member.name || '', memberPhone: req.member.phone || '',
        gymId: req.body.gymId,
        subject: req.body.subject.trim(), content: req.body.content.trim(),
        status: 'pending', reply: null, repliedAt: null, repliedByName: null, unread: false,
        createdAt: now, updatedAt: now,
      };
      await db.collection('memberInquiries').doc(id).set(inquiry);
      notifyInquiryManagers({ gymId: inquiry.gymId, inquiryId: id, memberName: inquiry.memberName, subject: inquiry.subject })
        .catch(e => console.error('[會員提問通知]', e.message));
      res.status(201).json({ success: true, inquiry });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── POST /member-inquiries/:id/read：會員標記已讀取回覆（清 unread，供底部導航角標消失） ──
router.post('/:id/read', authenticateMember, async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('memberInquiries').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此提問' });
    if (doc.data().memberId !== req.member.id) return res.status(403).json({ error: 'FORBIDDEN', message: '無權操作' });
    await ref.update({ unread: false });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /member-inquiries：員工端提問記錄（待辦頁「❓ 問題諮詢記錄」用；預設回全部含已回覆，
//    ?status=pending|replied 可篩選）——依角色館別範圍：super_admin 全部或帶 ?gymId= 指定館別，
//    其餘員工固定回自己所屬館別，跟其他待辦追蹤清單（課程/定期票相關）同一套權限慣例。
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff.role === 'super_admin' ? req.query.gymId : req.staff.gymId;
    let query = db.collection('memberInquiries');
    if (gymId) query = query.where('gymId', '==', gymId);
    if (req.query.status) query = query.where('status', '==', req.query.status);
    const snap = await query.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /member-inquiries/:id/reply：員工回覆（任何登入員工皆可，純溝通性質不設限） ──
router.post('/:id/reply', authenticate,
  [body('reply').trim().notEmpty().withMessage('請填寫回覆內容')],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const ref = db.collection('memberInquiries').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此提問' });
      await ref.update({
        status: 'replied', reply: req.body.reply.trim(),
        repliedAt: new Date(), repliedByName: req.staff.name || '',
        unread: true, updatedAt: new Date(),
      });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
