/**
 * 場館資訊 + 公告管理路由
 *
 * 公開端點（不需登入）：
 *   GET /gyms                    所有場館基本資訊
 *   GET /gyms/:id                單一場館詳情
 *   GET /gyms/:id/today-status   今日營業狀態
 *   GET /gyms/:id/announcements  場館公告列表（含輪播）
 *
 * 管理端點（需登入）：
 *   PUT  /gyms/:id               更新場館資訊
 *   PUT  /gyms/:id/hours         更新標準營業時間
 *   POST /gyms/:id/announcements 新增公告
 *   PUT  /gyms/:id/announcements/:aid  編輯公告
 *   DELETE /gyms/:id/announcements/:aid 刪除公告
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission, requireManagerOrStation, auditLog } = require('../middleware/auth');
const { getDb, getStorage, COLLECTIONS } = require('../config/firebase');
const multer = require('multer');
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const ANNOUNCE_COLLECTION = 'gymAnnouncements';

// 公告館別隔離：非 super_admin（含值班 operator / gym_manager）只能對「自己館」發布，
// 不可對 'all'（全館）或他館。super_admin 不限（可發全館與任一館）。
const announceGymGuard = (req, res, next) => {
  if (req.staff?.role === 'super_admin') return next();
  const targetGym = req.params.id;
  if (targetGym === 'all' || targetGym !== req.staff?.gymId) {
    return res.status(403).json({ error: 'CROSS_GYM_FORBIDDEN', message: '只能發布自己館別的公告' });
  }
  next();
};

// 休館／特殊營業時間有票期補償財務副作用 → 限管理員（super_admin / gym_manager）；
// 值班 operator（full/part 角色）僅可發一般／輪播／路線更換。
const MANAGER_ONLY_TYPES = ['closure', 'special_hours'];
const announceTypeGuard = (req, res, next) => {
  const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
  if (isManager) return next();
  if (MANAGER_ONLY_TYPES.includes(req.body?.type)) {
    return res.status(403).json({ error: 'MANAGER_ONLY_TYPE', message: '休館／特殊營業時間公告限管理員發布' });
  }
  next();
};

// 會員可見的「發布時段」判定：publishAt <= now <= publishUntil（兩者皆選填）。
// ⚠ 僅供「顯示給會員」的過濾。getGymStatusForDate（休館判定／定期票臨停補償來源）
//   只看 publishAt、不套此函式——否則發布時段一過會讓休館「不算數」，補償錯亂。
const isPublishedNow = (a, now) =>
  (!a.publishAt || a.publishAt.toDate() <= now) &&
  (!a.publishUntil || a.publishUntil.toDate() >= now);

// ── 今日營業狀態判斷 ──────────────────────────────────────────────
const getGymStatusForDate = async (gymId, dateStr) => {
  const db = getDb();
  const dayOfWeek = ['sun','mon','tue','wed','thu','fri','sat'][dayjs(dateStr).day()];

  // 取得場館資訊
  const gymDoc = await db.collection(COLLECTIONS.GYMS).doc(gymId).get();
  if (!gymDoc.exists) throw { code: 'GYM_NOT_FOUND' };
  const gym = gymDoc.data();

  // 查詢有效公告（已發布；日期範圍篩選改在程式碼層處理，避免Firestore複合索引問題——
  // 這裡若用 where('effectiveFrom','<=',dateStr) 搭配 where('isPublished','==',true) 在某些索引組合下會失敗）
  const now = new Date();
  const annoSnap = await db.collection(ANNOUNCE_COLLECTION)
    .where('isPublished', '==', true)
    .get();

  const dateAnnouncements = annoSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a =>
      (a.gymId === gymId || a.gymId === null) &&
      a.effectiveFrom <= dateStr &&
      (a.effectiveTo === null || a.effectiveTo >= dateStr) &&
      (!a.publishAt || a.publishAt.toDate() <= now)
    );

  // 1. 臨時休館
  const closureAnnouncement = dateAnnouncements.find(a => a.type === 'closure');
  if (closureAnnouncement) {
    return {
      isOpen: false,
      todayHours: null,
      status: 'closed',
      statusLabel: '休館',
      specialNote: closureAnnouncement.title,
      announcementId: closureAnnouncement.id,
    };
  }

  // 2. 特殊營業時間
  const specialHours = dateAnnouncements.find(a => a.type === 'special_hours');
  if (specialHours) {
    return {
      isOpen: specialHours.specialOpen !== '00:00' || specialHours.specialClose !== '00:00',
      todayHours: specialHours.specialOpen && specialHours.specialClose
        ? `${specialHours.specialOpen} - ${specialHours.specialClose}`
        : null,
      status: 'special',
      statusLabel: '特殊營業時間',
      specialNote: specialHours.title,
      announcementId: specialHours.id,
      specialOpen: specialHours.specialOpen,
      specialClose: specialHours.specialClose,
    };
  }

  // 3. 標準營業時間
  const hours = gym.regularHours?.[dayOfWeek];
  if (!hours || hours.closed) {
    return {
      isOpen: false,
      todayHours: null,
      status: 'regular_closed',
      statusLabel: '公休',
      specialNote: null,
    };
  }

  return {
    isOpen: true,
    todayHours: `${hours.open} - ${hours.close}`,
    status: 'open',
    statusLabel: '營業中',
    specialNote: null,
  };
};

const getTodayStatus = async (gymId) => getGymStatusForDate(gymId, dayjs().format('YYYY-MM-DD'));

// ══════════════════════════════════════════════════════
// 公開端點
// ══════════════════════════════════════════════════════

// GET /gyms - 所有場館列表
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.GYMS)
      .where('status', '==', 'active')
      .get();

    const gyms = await Promise.all(
      snap.docs.map(async d => {
        const gym = { id: d.id, ...d.data() };
        // 隱藏敏感欄位（金流設定）
        delete gym.paymentSettings;
        // 附上今日狀態
        try {
          gym.todayStatus = await getTodayStatus(d.id);
        } catch (e) {
          gym.todayStatus = null;
        }
        return gym;
      })
    );

    res.json({ gyms });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /gyms/:id - 單一場館詳情
// GET /gyms/all - 員工查詢所有場館（含暫停）
router.get('/all', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.GYMS).get();
    const gyms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    gyms.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ gyms });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.GYMS).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'GYM_NOT_FOUND' });

    const gym = { id: doc.id, ...doc.data() };
    delete gym.paymentSettings;

    gym.todayStatus = await getTodayStatus(req.params.id);

    res.json({ gym });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /gyms/:id/today-status - 今日營業狀態
router.get('/:id/today-status', async (req, res) => {
  try {
    const status = await getTodayStatus(req.params.id);
    res.json(status);
  } catch (err) {
    if (err.code === 'GYM_NOT_FOUND') return res.status(404).json(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /gyms/:id/announcements - 公告列表（含輪播）
router.get('/:id/announcements', async (req, res) => {
  try {
    const db = getDb();
    const today = dayjs().format('YYYY-MM-DD');
    const now = new Date();
    const { type, limit = 20 } = req.query;

    const snap = await db.collection(ANNOUNCE_COLLECTION)
      .where('isPublished', '==', true)
      .orderBy('effectiveFrom', 'desc')
      .get();

    let announcements = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(a => {
        const matchGym = a.gymId === req.params.id || a.gymId === null;
        const notExpired = a.effectiveTo === null || a.effectiveTo >= today;
        const published = isPublishedNow(a, now);
        const matchType = !type || a.type === type;
        return matchGym && notExpired && published && matchType;
      })
      .slice(0, parseInt(limit));

    // 分類：輪播 vs 公告列表
    const bannerItems = announcements.filter(a => a.showOnBanner);
    const listItems = announcements;

    res.json({
      banner: bannerItems,
      announcements: listItems,
      count: listItems.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// GET /gyms/announcements/all - 兩館公告（會員首頁用）
router.get('/announcements/all', async (req, res) => {
  try {
    const db = getDb();
    const today = dayjs().format('YYYY-MM-DD');
    const now = new Date();
    const includeScheduled = req.query.all === '1'; // 員工端：連未到發布時間的排程公告一起回傳

    const snap = await db.collection(ANNOUNCE_COLLECTION)
      .where('isPublished', '==', true)
      .orderBy('effectiveFrom', 'desc')
      .limit(50)
      .get();

    const all = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(a => {
        const notExpired = a.effectiveTo === null || a.effectiveTo >= today;
        const published = isPublishedNow(a, now);
        return notExpired && (published || includeScheduled);
      });

    res.json({
      banner: all.filter(a => a.showOnBanner && isPublishedNow(a, now)),
      announcements: all,
      count: all.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
});

// ══════════════════════════════════════════════════════
// 管理端點（需登入）
// ══════════════════════════════════════════════════════

// PUT /gyms/:id - 更新場館基本資訊
router.put('/:id',
  authenticate,
  checkPermission('gyms.manage'),
  auditLog('gym.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowed = ['name', 'shortName', 'address', 'phone', 'googleMapsUrl',
        'parkingInfo', 'transitInfo', 'facilities', 'description', 'status'];
      const updates = {};
      allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      updates.updatedAt = new Date();

      await db.collection(COLLECTIONS.GYMS).doc(req.params.id).update(updates);
      res.json({ message: '場館資訊已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /gyms - 新增場館
router.post('/',
  authenticate,
  checkPermission('gyms.manage'),
  async (req, res) => {
    try {
      const db = getDb();
      const { id, name, address, shortName } = req.body;
      if (!id || !name) return res.status(400).json({ error: 'MISSING_FIELDS', message: '場館 ID 和名稱為必填' });
      const existing = await db.collection(COLLECTIONS.GYMS).doc(id).get();
      if (existing.exists) return res.status(409).json({ error: 'GYM_EXISTS', message: '場館 ID 已存在' });
      await db.collection(COLLECTIONS.GYMS).doc(id).set({
        id, name, shortName: shortName || name, address: address || '',
        status: 'active', createdAt: new Date(), updatedAt: new Date(),
      });
      res.status(201).json({ message: `場館「${name}」已建立`, id });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// PUT /gyms/:id/hours - 更新標準營業時間
router.put('/:id/hours',
  authenticate,
  checkPermission('gyms.manage'),
  auditLog('gym.update_hours'),
  [
    body('regularHours').isObject().withMessage('請提供 regularHours 物件'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      // regularHours 格式：{ mon: { open: '10:00', close: '22:00', closed: false }, ... }
      await db.collection(COLLECTIONS.GYMS).doc(req.params.id).update({
        regularHours: req.body.regularHours,
        updatedAt: new Date(),
      });
      res.json({ message: '標準營業時間已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// POST /gyms/:id/announcements - 新增公告
// POST /gyms/:id/announcements/:aid/image - 上傳公告圖片（存 Storage、簽名 URL 寫入 bannerImage）
// 權限同編輯公告（管理員或值班＋館別隔離）；休館/特殊時間公告限管理員（讀既有公告 type 判斷）
router.post('/:id/announcements/:aid/image',
  authenticate, requireManagerOrStation, announceGymGuard,
  auditLog('announcement.image.upload'),
  uploadImage.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'NO_FILE', message: '請選擇圖片' });
      if (!(req.file.mimetype || '').startsWith('image/')) {
        return res.status(400).json({ error: 'NOT_IMAGE', message: '只能上傳圖片檔' });
      }
      const db = getDb();
      const doc = await db.collection(ANNOUNCE_COLLECTION).doc(req.params.aid).get();
      if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到公告' });
      const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
      if (!isManager && MANAGER_ONLY_TYPES.includes(doc.data().type)) {
        return res.status(403).json({ error: 'MANAGER_ONLY_TYPE', message: '休館／特殊營業時間公告限管理員編輯' });
      }
      const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const bucket = getStorage().bucket();
      const file = bucket.file(`announcements/banner_${req.params.aid}_${uuidv4()}.${ext}`);
      await file.save(req.file.buffer, { contentType: req.file.mimetype });
      const [url] = await file.getSignedUrl({ action: 'read', expires: '2035-01-01' });
      await doc.ref.update({ bannerImage: url, updatedAt: new Date() });
      res.json({ message: '公告圖片已上傳', bannerImage: url });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

router.post('/:id/announcements',
  authenticate,
  requireManagerOrStation, announceGymGuard, announceTypeGuard,
  auditLog('announcement.create'),
  [
    body('title').notEmpty().withMessage('請輸入公告標題'),
    body('type').isIn(['closure', 'special_hours', 'route_change', 'general'])
      .withMessage('type 必須為 closure / special_hours / route_change / general'),
    body('effectiveFrom').isDate().withMessage('請輸入生效日期'),
  ],
  validate,
  async (req, res) => {
    try {
      const db = getDb();
      const id = uuidv4();
      const now = new Date();

      const announcement = {
        id,
        gymId: req.params.id === 'all' ? null : req.params.id,
        type: req.body.type,
        title: req.body.title,
        content: req.body.content || '',
        bannerImage: req.body.bannerImage || null,
        showOnBanner: req.body.showOnBanner || false,
        effectiveFrom: req.body.effectiveFrom,
        effectiveTo: req.body.effectiveTo || null,
        // 特殊營業時間才有
        specialOpen: req.body.specialOpen || null,
        specialClose: req.body.specialClose || null,
        // 排期發布時段：publishAt=顯示開始（排程上架）、publishUntil=顯示結束（皆選填）
        publishAt: req.body.publishAt ? new Date(req.body.publishAt) : null,
        publishUntil: req.body.publishUntil ? new Date(req.body.publishUntil) : null,
        // isPublished = 是否「上架（未下架）」；排程發布交由 publishAt <= now <= publishUntil 於讀取時過濾
        isPublished: true,
        createdBy: req.staff.id,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection(ANNOUNCE_COLLECTION).doc(id).set(announcement);

      res.status(201).json({ announcement, message: '公告已建立' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// PUT /gyms/:id/announcements/:aid - 編輯公告
router.put('/:id/announcements/:aid',
  authenticate,
  requireManagerOrStation, announceGymGuard, announceTypeGuard,
  auditLog('announcement.update'),
  async (req, res) => {
    try {
      const db = getDb();
      const allowed = ['title', 'content', 'bannerImage', 'showOnBanner',
        'effectiveFrom', 'effectiveTo', 'specialOpen', 'specialClose',
        'publishAt', 'publishUntil', 'isPublished'];
      const updates = {};
      allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
      // publishAt / publishUntil 需存為 Date（讀取時會 .toDate()）
      if (req.body.publishAt !== undefined) updates.publishAt = req.body.publishAt ? new Date(req.body.publishAt) : null;
      if (req.body.publishUntil !== undefined) updates.publishUntil = req.body.publishUntil ? new Date(req.body.publishUntil) : null;
      updates.updatedAt = new Date();

      await db.collection(ANNOUNCE_COLLECTION).doc(req.params.aid).update(updates);
      res.json({ message: '公告已更新' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// DELETE /gyms/:id/announcements/:aid - 刪除公告
router.delete('/:id/announcements/:aid',
  authenticate,
  requireManagerOrStation, announceGymGuard,
  auditLog('announcement.delete'),
  async (req, res) => {
    try {
      const db = getDb();
      // 值班（非管理員）不可下架休館／特殊營業時間公告（會反向影響票期補償）
      const isManager = ['super_admin', 'gym_manager'].includes(req.staff?.role);
      if (!isManager) {
        const cur = await db.collection(ANNOUNCE_COLLECTION).doc(req.params.aid).get();
        if (cur.exists && MANAGER_ONLY_TYPES.includes(cur.data().type)) {
          return res.status(403).json({ error: 'MANAGER_ONLY_TYPE', message: '休館／特殊營業時間公告限管理員下架' });
        }
      }
      // 軟刪除：設定為未發布
      await db.collection(ANNOUNCE_COLLECTION).doc(req.params.aid).update({
        isPublished: false,
        deletedAt: new Date(),
        deletedBy: req.staff.id,
      });
      res.json({ message: '公告已下架' });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// 匯出 getTodayStatus 供其他 service 使用
router.getTodayStatus = getTodayStatus;
router.getGymStatusForDate = getGymStatusForDate;

module.exports = router;
