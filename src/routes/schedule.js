/**
 * 排班表路由
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, checkPermission } = require('../middleware/auth');
const scheduleService = require('../services/scheduleService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: errors.array().map(e => `${e.path}: ${e.msg}`).join('；'),
      details: errors.array(),
    });
  }
  next();
};

// ── 權限輔助：gym_manager只能操作自己館，super_admin不限 ────────────
const resolveGymId = (req, requestedGymId) => {
  if (req.staff.role === 'super_admin') return requestedGymId || req.staff.gymId;
  return req.staff.gymId; // gym_manager/full_time/part_time 一律鎖定自己館，即使body帶了別的gymId也忽略
};

// ── POST /schedule - 新增排班 ──────────────────────────────────────
router.post('/',
  authenticate, checkPermission('schedule.manage'),
  [
    body('staffId').notEmpty().withMessage('請指定員工'),
    body('date').isDate().withMessage('請輸入有效日期'),
    body('type').isIn(['full_day', 'custom']).withMessage('type 必須為 full_day 或 custom'),
  ],
  validate,
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.body.gymId);
      const shift = await scheduleService.createShift({
        gymId,
        staffId: req.body.staffId,
        staffName: req.body.staffName,
        date: req.body.date,
        type: req.body.type,
        startTime: req.body.startTime,
        endTime: req.body.endTime,
        note: req.body.note,
        createdBy: req.staff.id,
      });
      res.status(201).json({ shift, message: '排班已新增' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /schedule/recurring - 批次建立固定週班 ──────────────────────
router.post('/recurring',
  authenticate, checkPermission('schedule.manage'),
  [
    body('staffId').notEmpty().withMessage('請指定員工'),
    body('weekdays').isArray({ min: 1 }).withMessage('請至少選擇一個星期幾'),
    body('type').isIn(['full_day', 'custom']).withMessage('type 必須為 full_day 或 custom'),
    body('rangeStart').isDate().withMessage('請輸入有效的開始日期'),
    body('rangeEnd').isDate().withMessage('請輸入有效的結束日期'),
  ],
  validate,
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.body.gymId);
      const result = await scheduleService.createRecurringShifts({
        gymId,
        staffId: req.body.staffId,
        staffName: req.body.staffName,
        weekdays: req.body.weekdays,
        type: req.body.type,
        startTime: req.body.startTime,
        endTime: req.body.endTime,
        note: req.body.note,
        rangeStart: req.body.rangeStart,
        rangeEnd: req.body.rangeEnd,
        createdBy: req.staff.id,
      });
      res.status(201).json({
        ...result,
        message: `已建立 ${result.createdCount} 筆排班` +
          (result.skippedClosed > 0 ? `，${result.skippedClosed} 天因休館跳過` : '') +
          (result.skippedDuplicate > 0 ? `，${result.skippedDuplicate} 天因當天已有整天班跳過` : '') +
          (result.adjustedSpecial > 0 ? `，${result.adjustedSpecial} 天已調整為特殊營業時段` : ''),
      });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── PUT /schedule/:shiftId - 修改排班 ──────────────────────────────
router.put('/:shiftId',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      const shift = await scheduleService.updateShift(req.params.shiftId, req.body);
      res.json({ shift, message: '排班已更新' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── DELETE /schedule/:shiftId - 刪除排班 ───────────────────────────
router.delete('/:shiftId',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      await scheduleService.deleteShift(req.params.shiftId);
      res.json({ message: '排班已刪除' });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /schedule/clear-month - 清空某館某月所有排班 ──────────────
router.post('/clear-month',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.body.gymId);
      const month = req.body.month;
      if (!gymId || !month) return res.status(400).json({ error: 'MISSING_PARAM', message: '請指定場館與月份' });
      const deleted = await scheduleService.clearMonthShifts(gymId, month);
      res.json({ deleted, message: `已清空 ${month} 共 ${deleted} 筆排班` });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── POST /schedule/copy-previous - 複製上月排班到本月（以星期為主）──
router.post('/copy-previous',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.body.gymId);
      const month = req.body.month;
      if (!gymId || !month) return res.status(400).json({ error: 'MISSING_PARAM', message: '請指定場館與月份' });
      const result = await scheduleService.copyPreviousMonthShifts(gymId, month, req.staff.id);
      res.json({ ...result, message: `已從 ${result.prevMonth} 複製 ${result.created} 筆排班（原 ${result.prevCount} 筆，以星期對應）` });
    } catch (err) {
      if (err.code) return res.status(400).json(err);
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /schedule - 查詢某館某月份排班（月曆檢視，所有員工皆可查看自己館）──
router.get('/',
  authenticate, checkPermission('schedule.read'),
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.query.gymId);
      const yearMonth = req.query.month || require('dayjs')().format('YYYY-MM');
      if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定場館' });
      const shifts = await scheduleService.getMonthlyShifts(gymId, yearMonth);
      res.json({ shifts, gymId, month: yearMonth });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /schedule/hours-summary - 月工時統計（管理端）───────────────
router.get('/hours-summary',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.query.gymId);
      const yearMonth = req.query.month || require('dayjs')().format('YYYY-MM');
      if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定場館' });
      const summary = await scheduleService.getMonthlyHoursSummary(gymId, yearMonth);
      res.json({ summary, gymId, month: yearMonth });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);

// ── GET /schedule/staff-list - 取得館內員工清單（排班指派用）─────────
router.get('/staff-list',
  authenticate, checkPermission('schedule.manage'),
  async (req, res) => {
    try {
      const gymId = resolveGymId(req, req.query.gymId);
      if (!gymId) return res.status(400).json({ error: 'MISSING_GYM', message: '請指定場館' });
      const db = require('../config/firebase').getDb();
      const snap = await db.collection('staff')
        .where('gymId', '==', gymId)
        .where('isActive', '==', true)
        .get();
      const staffList = snap.docs.map(d => ({ id: d.id, name: d.data().name, role: d.data().role }));
      res.json({ staffList });
    } catch (err) {
      res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
    }
  }
);


// ── GET /schedule/settings/:gymId - 取得排班工時設定 ──────────────
router.get('/settings/:gymId',
  authenticate,
  async (req, res) => {
    try {
      const db = require('../config/firebase').getDb();
      const doc = await db.collection('systemSettings').doc('scheduleHours_' + req.params.gymId).get();
      const defaultHours = { 0:11, 1:9, 2:9, 3:9, 4:9, 5:9, 6:12 };
      const settings = doc.exists ? doc.data() : { gymId: req.params.gymId, standardHours: defaultHours };
      res.json({ settings });
    } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

// ── PUT /schedule/settings/:gymId - 更新排班工時設定 ──────────────
router.put('/settings/:gymId',
  authenticate, checkPermission('settings.manage'),
  async (req, res) => {
    try {
      const db = require('../config/firebase').getDb();
      const { standardHours } = req.body;
      await db.collection('systemSettings').doc('scheduleHours_' + req.params.gymId).set({
        gymId: req.params.gymId,
        standardHours,
        updatedAt: new Date(),
      });
      res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
  }
);

module.exports = router;
