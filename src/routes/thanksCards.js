/**
 * 感恩節感謝卡片（會員互送／送給教練與櫃檯）。
 *  GET  /thanks-cards/config        → 目前是否開放寄送、預設句子 id／貼紙 id、收件匣是否顯示
 *  POST /thanks-cards/lookup        → 以手機查收件會員（只回遮罩姓名，不洩漏其他資料；每小時 20 次）
 *  GET  /thanks-cards/staff         → 可收卡的教練／櫃檯名單（只有姓名與館別）
 *  POST /thanks-cards               → 寄卡（句子、貼紙都用預設 id；同一人對同一收件人最多 3 張）
 *  GET  /thanks-cards/inbox         → 我收到的卡片
 *  POST /thanks-cards/:id/hide      → 隱藏收到的卡片（可選擇不再收到此人的卡片）
 * 寄給員工的卡片以站內通知送達（員工端通知頁）。
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/firebase');
const { authenticateMember } = require('../middleware/auth');
const cfg = require('../config/thanksCards');
const { createNotification } = require('../services/notificationService');

const digits = (p) => String(p || '').replace(/[^0-9]/g, '');
const maskName = (n) => {
  const s = Array.from(String(n || '').trim());
  if (s.length <= 1) return s.join('') || '？';
  if (s.length === 2) return s[0] + '○';
  return s[0] + '○'.repeat(s.length - 2) + s[s.length - 1];
};

// systemSettings/thanksCards { forceOpen:true } 可在活動期間外提前開放（上線前測試用；測試期間寄出的卡片標 isTest，上線前清除）
let _forceCache = { v: false, at: 0 };
const forceOpen = async () => {
  if (Date.now() - _forceCache.at < 30000) return _forceCache.v;
  try {
    const d = await getDb().collection('systemSettings').doc('thanksCards').get();
    _forceCache = { v: !!(d.exists && d.data().forceOpen === true), at: Date.now() };
  } catch (e) { _forceCache = { v: false, at: Date.now() }; }
  return _forceCache.v;
};
const state = async () => {
  const today = cfg.tpDate();
  const force = await forceOpen();
  return {
    sendOpen: force || (today >= cfg.SEND_START && today <= cfg.SEND_END),
    inboxOpen: force || (today >= cfg.SEND_START && today <= cfg.INBOX_UNTIL),
    force,
  };
};

// 查詢頻率限制（記憶體；單一實例即可）
const lookupHits = new Map();
const lookupAllowed = (memberId) => {
  const now = Date.now(); const arr = (lookupHits.get(memberId) || []).filter(t => now - t < 3600e3);
  if (arr.length >= cfg.LOOKUP_LIMIT_PER_HOUR) { lookupHits.set(memberId, arr); return false; }
  arr.push(now); lookupHits.set(memberId, arr); return true;
};

router.get('/config', authenticateMember, async (req, res) => {
  const st = await state();
  res.json({ ...st, phrases: Object.keys(cfg.PHRASES), stickers: cfg.STICKERS, maxPerPair: cfg.MAX_PER_PAIR });
});

router.post('/lookup', authenticateMember, async (req, res) => {
  try {
    if (!(await state()).sendOpen) return res.status(400).json({ error: 'NOT_OPEN', message: '感謝卡片目前未開放' });
    if (!lookupAllowed(req.member.id)) return res.status(429).json({ error: 'TOO_MANY', message: '查詢太頻繁，請稍後再試' });
    const phone = digits(req.body.phone);
    if (phone.length < 8) return res.status(400).json({ error: 'INVALID_PHONE', message: '請輸入完整手機號碼' });
    const db = getDb();
    // 手機欄位格式可能不一（0912… 或國際碼），逐一試；只取本人帳號（非家庭子帳號）
    const tries = [...new Set([phone, req.body.phone ? String(req.body.phone).trim() : phone])];
    let hit = null;
    for (const p of tries) {
      const snap = await db.collection('members').where('phone', '==', p).limit(5).get();
      hit = snap.docs.find(d => !d.data().isChildAccount && !d.data().isSimulation);
      if (hit) break;
    }
    if (!hit || hit.id === req.member.id) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此會員，請確認手機號碼' });
    res.json({ toMemberId: hit.id, maskedName: maskName(hit.data().name) });
  } catch (e) { res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

router.get('/staff', authenticateMember, async (req, res) => {
  try {
    const snap = await getDb().collection('staff').select('name', 'gymId', 'role', 'isActive', 'type').get();
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(s => s.isActive !== false && ['part_time', 'full_time', 'gym_manager'].includes(s.role) && s.name && !/測試|test/i.test(s.name))
      .map(s => ({ id: s.id, name: s.name, gymId: s.gymId || null }))
      .sort((a, b) => (a.gymId || '').localeCompare(b.gymId || '') || a.name.localeCompare(b.name, 'zh-Hant'));
    res.json({ staff: list });
  } catch (e) { res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

router.post('/', authenticateMember, async (req, res) => {
  try {
    const st = await state();
    if (!st.sendOpen) return res.status(400).json({ error: 'NOT_OPEN', message: '感謝卡片目前未開放' });
    const { toType, toMemberId, toStaffId, stickerId, phraseId, displayAs } = req.body || {};
    if (!cfg.PHRASES[phraseId]) return res.status(400).json({ error: 'INVALID_PHRASE', message: '請選擇卡片句子' });
    if (!cfg.STICKERS.includes(stickerId)) return res.status(400).json({ error: 'INVALID_STICKER', message: '請選擇貼紙' });
    if (!['member', 'staff'].includes(toType)) return res.status(400).json({ error: 'INVALID_TYPE' });
    const db = getDb(); const me = req.member;
    let toKey, toName = '', staffDoc = null;
    if (toType === 'member') {
      if (!toMemberId || toMemberId === me.id) return res.status(400).json({ error: 'INVALID_RECIPIENT', message: '收件人不正確' });
      const m = await db.collection('members').doc(toMemberId).get();
      if (!m.exists || m.data().isChildAccount) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此會員' });
      toKey = `m_${toMemberId}`; toName = m.data().name || '';
    } else {
      if (!toStaffId) return res.status(400).json({ error: 'INVALID_RECIPIENT', message: '請選擇收件人' });
      const s = await db.collection('staff').doc(toStaffId).get();
      if (!s.exists || s.data().isActive === false) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此人員' });
      staffDoc = { id: s.id, ...s.data() }; toKey = `s_${toStaffId}`; toName = staffDoc.name || '';
    }
    // 同一人對同一收件人最多 3 張（含已被隱藏的）
    const mine = await db.collection('thanksCards').where('fromMemberId', '==', me.id).get();
    if (mine.docs.filter(d => d.data().toKey === toKey).length >= cfg.MAX_PER_PAIR) {
      return res.status(409).json({ error: 'PAIR_LIMIT', message: `對同一個人最多可以送 ${cfg.MAX_PER_PAIR} 張感謝卡片` });
    }
    const fromDisplay = (displayAs === 'name' || !me.nickname) ? (me.name || '') : me.nickname;
    // 收件人已選擇不再收到此人的卡片 → 對寄件人照常顯示成功（不洩漏封鎖），但卡片不會出現
    let blocked = false;
    if (toType === 'member') {
      const b = await db.collection('thanksCardBlocks').doc(`${toMemberId}_${me.id}`).get();
      blocked = b.exists;
    }
    const id = uuidv4(); const now = new Date();
    await db.collection('thanksCards').doc(id).set({
      id, fromMemberId: me.id, fromDisplay, toType, toKey, toMemberId: toType === 'member' ? toMemberId : null, toStaffId: toType === 'staff' ? toStaffId : null,
      toName, stickerId, phraseId, status: blocked ? 'blocked' : 'active', isTest: !!(st.force && !(cfg.tpDate() >= cfg.SEND_START && cfg.tpDate() <= cfg.SEND_END)),
      createdAt: now, readAt: null,
    });
    if (toType === 'staff') {
      try {
        await createNotification({ gymId: staffDoc.gymId || null, targetStaffId: staffDoc.id, type: 'thanks_card', title: '💌 收到一張感謝卡片',
          body: `${fromDisplay}：「${cfg.PHRASES[phraseId]}」`, referenceId: id, referenceType: 'thanksCard', link: null });
      } catch (e) { console.error('[感謝卡片] 員工通知失敗', e.message); }
    }
    res.status(201).json({ success: true, id, remaining: Math.max(0, cfg.MAX_PER_PAIR - mine.docs.filter(d => d.data().toKey === toKey).length - 1) });
  } catch (e) { res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

router.get('/inbox', authenticateMember, async (req, res) => {
  try {
    const st = await state();
    if (!st.inboxOpen) return res.json({ cards: [], inboxOpen: false });
    const snap = await getDb().collection('thanksCards').where('toKey', '==', `m_${req.member.id}`).get();
    const cards = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.status === 'active')
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)).slice(0, 30)
      .map(c => ({ id: c.id, fromDisplay: c.fromDisplay, stickerId: c.stickerId, phraseId: c.phraseId, createdAt: c.createdAt?.toDate?.()?.toISOString() || null }));
    res.json({ cards, inboxOpen: true });
  } catch (e) { res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

router.post('/:id/hide', authenticateMember, async (req, res) => {
  try {
    const db = getDb(); const ref = db.collection('thanksCards').doc(req.params.id); const doc = await ref.get();
    if (!doc.exists || doc.data().toKey !== `m_${req.member.id}`) return res.status(404).json({ error: 'NOT_FOUND' });
    await ref.update({ status: 'hidden', hiddenAt: new Date() });
    if (req.body && req.body.block === true) {
      await db.collection('thanksCardBlocks').doc(`${req.member.id}_${doc.data().fromMemberId}`).set({ memberId: req.member.id, blockedMemberId: doc.data().fromMemberId, at: new Date() });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'SERVER_ERROR', message: e.message }); }
});

module.exports = router;
