const express = require('express');
const router = express.Router();
const { authenticate, authenticateAny } = require('../middleware/auth');
const { getDb, getStorage } = require('../config/firebase');
const XLSX = require('xlsx');
const emailService = require('../services/emailService');

const COURSE_TYPES = [
  { id:'general',   label:'抱石體驗課程',          priceMap:{ 1:975, 2:875, 3:875, '4-5':825, '6-8':775, '9-12':775 } },
  { id:'children',  label:'小蜘蛛人（兒童）',        price: 600 },
  { id:'skill_fri', label:'抱石技巧班（週五20:00）', price:1075 },
  { id:'skill_sun14',label:'抱石技巧班（週日14:00）',price: 900 },
];

// ── POST /experience-bookings - 送出預約 ──────────────────────────
router.post('/', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id || req.body.memberId;
    const {
      gymId, bookingDate, bookingTime, courseType,
      contactName, contactEmail, contactPhone, facebookName,
      participants, // [{ name, idNumber, birthday, nationality }]
      totalFee, paymentDate, bankLastFive, notes,
    } = req.body;

    if (!gymId) return res.status(400).json({ code:'MISSING_GYM', message:'請選擇場館' });
    if (!bookingDate) return res.status(400).json({ code:'MISSING_DATE', message:'請填寫體驗日期' });
    if (!participants?.length) return res.status(400).json({ code:'MISSING_PARTICIPANTS', message:'請填寫參加人員資料' });

    // 後端權威計算費用（不信任前端傳入的 totalFee）：用與前端相同的設定來源
    const _settingsDoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const _settings = _settingsDoc.exists ? _settingsDoc.data() : defaultSettings();
    const _courseTypes = _settings.courseTypes || defaultSettings().courseTypes;
    const _ct = _courseTypes.find(c => c.id === (courseType || 'general'));
    if (!_ct) return res.status(400).json({ code:'INVALID_COURSE_TYPE', message:'課程類型不正確' });
    const _n = participants.length;
    let _unitPrice = 0;
    if (_ct.pricingType === 'tiered' && Array.isArray(_ct.tiers)) {
      const _tier = _ct.tiers.find(t => _n >= t.min && _n <= t.max);
      _unitPrice = _tier ? _tier.price : (_ct.tiers[_ct.tiers.length - 1]?.price || 0);
    } else {
      _unitPrice = _ct.price || 0;
    }
    const computedFee = _unitPrice * _n;

    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await db.collection('experienceBookings').doc(id).set({
      id, memberId, gymId, bookingDate, bookingTime, courseType: courseType||'general',
      contactName: contactName || req.member?.name || '',
      contactEmail: contactEmail || req.member?.email || '',
      contactPhone: contactPhone || req.member?.phone || '',
      facebookName: facebookName||'',
      participants, // 含姓名/身分證/生日/國籍
      numParticipants: participants.length,
      totalFee: computedFee,
      paymentDate: paymentDate||null,
      bankLastFive: bankLastFive||null,
      notes: notes||'',
      status: 'pending', // pending | confirmed | cancelled
      createdAt: new Date(), updatedAt: new Date(),
    });
    res.status(201).json({ success:true, id, message:'預約已送出，請於3日內完成匯款' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings - 員工查詢 ────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, status, from, to } = req.query;
    const effectiveGymId = req.staff.role==='super_admin' ? gymId : req.staff.gymId;
    let ref = db.collection('experienceBookings');
    if (effectiveGymId) ref = ref.where('gymId','==',effectiveGymId);
    if (status) ref = ref.where('status','==',status);
    const snap = await ref.get();
    let bookings = snap.docs.map(d=>({ id:d.id,...d.data() }));
    if (from) bookings = bookings.filter(b=>b.bookingDate>=from);
    if (to)   bookings = bookings.filter(b=>b.bookingDate<=to);
    bookings.sort((a,b)=>a.bookingDate.localeCompare(b.bookingDate));
    res.json({ bookings, courseTypes: COURSE_TYPES });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings/my - 會員查自己的 ─────────────────────
router.get('/my', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const memberId = req.member?.id;
    if (!memberId) return res.status(401).json({ error:'UNAUTHORIZED' });
    const snap = await db.collection('experienceBookings').where('memberId','==',memberId).get();
    const bookings = snap.docs.map(d=>({ id:d.id,...d.data() }))
      .sort((a,b)=>(b.createdAt?._seconds||0)-(a.createdAt?._seconds||0));
    res.json({ bookings });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── POST /experience-bookings/:id/confirm - 確認收款 ───────────────
router.post('/:id/confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('experienceBookings').doc(req.params.id).get();
    await db.collection('experienceBookings').doc(req.params.id).update({
      status:'confirmed', confirmedBy:req.staff.id, confirmedByName:req.staff.name, confirmedAt:new Date(), updatedAt:new Date(),
    });
    // 發送確認信
    if (doc.exists) {
      const b = doc.data();
      if (b.contactEmail) {
        const emailService = require('../services/emailService');
        emailService.sendExperienceBookingConfirmation(b.contactEmail, b.contactName, b).catch(e => console.error('[Email]', e.message));
      }
    }
    res.json({ success:true, message:'已確認收款' });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── POST /experience-bookings/:id/cancel - 取消預約 ────────────────
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('experienceBookings').doc(req.params.id).update({
      status:'cancelled', cancelReason:req.body.reason||'', cancelledAt:new Date(), updatedAt:new Date(),
    });
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── GET /experience-bookings/download - 下載 XLS 名單 ─────────────
router.get('/download', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { gymId, from, to } = req.query;
    const effectiveGymId = req.staff.role==='super_admin' ? gymId : req.staff.gymId;
    let ref = db.collection('experienceBookings');
    if (effectiveGymId) ref = ref.where('gymId','==',effectiveGymId);
    const snap = await ref.get();
    let bookings = snap.docs.map(d=>({ id:d.id,...d.data() }));
    if (from) bookings = bookings.filter(b=>b.bookingDate>=from);
    if (to)   bookings = bookings.filter(b=>b.bookingDate<=to);
    bookings.sort((a,b)=>a.bookingDate.localeCompare(b.bookingDate));

    // 展開每位參加者
    const rows = [];
    bookings.forEach(b => {
      const gymLabel = b.gymId==='gym-hsinchu'?'新竹館':'士林館';
      const statusLabel = { pending:'待確認', confirmed:'已確認', cancelled:'已取消' }[b.status]||b.status;
      (b.participants||[]).forEach((p, idx) => {
        rows.push({
          '場館': gymLabel,
          '預約日期': b.bookingDate,
          '預約時間': b.bookingTime||'',
          '課程類型': b.courseType||'',
          '總人數': b.numParticipants,
          '狀態': statusLabel,
          '聯絡人': b.contactName,
          '聯絡電話': b.contactPhone,
          '序號': idx+1,
          '參加者姓名': p.name||'',
          '身分證字號': p.idNumber||'',
          '生日（民國）': p.birthday||'',
          '國籍': p.nationality||'台灣',
          '費用': idx===0 ? b.totalFee : '',
          '匯款末五碼': idx===0 ? (b.bankLastFive||'') : '',
          '備註': idx===0 ? (b.notes||'') : '',
        });
      });
    });

    if (rows.length===0) rows.push({ '場館':'無資料','預約日期':'','預約時間':'','課程類型':'','總人數':'','狀態':'','聯絡人':'','聯絡電話':'','序號':'','參加者姓名':'','身分證字號':'','生日（民國）':'','國籍':'','費用':'','匯款末五碼':'','備註':'' });

    const ws = XLSX.utils.json_to_sheet(rows);
    // 欄位寬度
    ws['!cols'] = [8,12,10,12,8,8,10,12,6,12,14,12,8,8,12,14].map(w=>({wch:w}));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '體驗課程名單');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });

    const today = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="experience_bookings_${today}.xlsx"`);
    res.send(buf);
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

module.exports = router;

// ── 保險名冊 XLS 產生（下載與一鍵寄送共用）──────────────────────
function buildInsuranceXlsBuffer(bookings) {
    // 工具函式
    const parseRocBirthday = (bStr) => {
      // 輸入可能是 920110(6位) 或 0920110(7位)，統一轉為 Date
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return null;
      let rocYear, mm, dd;
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        rocYear = yy <= 20 ? 100 + yy : yy; // 00-20 → 100-120
        mm = parseInt(s.slice(2, 4)) || 1;
        dd = parseInt(s.slice(4, 6)) || 1;
      } else {
        rocYear = parseInt(s.slice(0, 3));
        mm = parseInt(s.slice(3, 5)) || 1;
        dd = parseInt(s.slice(5, 7)) || 1;
      }
      return new Date(rocYear + 1911, mm - 1, dd);
    };

    const toRoc7 = (bStr) => {
      // 轉成 7 位民國格式 YYYMMDD
      const s = String(bStr).replace(/\D/g, '');
      if (!s) return '';
      if (s.length <= 6) {
        const yy = parseInt(s.slice(0, 2));
        const rocYear = yy <= 20 ? 100 + yy : yy;
        return String(rocYear).padStart(3, '0') + s.slice(2).padStart(4, '0');
      }
      return s.padStart(7, '0');
    };

    const calcAge = (birthdayDate, onDate) => {
      if (!birthdayDate || isNaN(birthdayDate)) return 99;
      let age = onDate.getFullYear() - birthdayDate.getFullYear();
      const m = onDate.getMonth() - birthdayDate.getMonth();
      if (m < 0 || (m === 0 && onDate.getDate() < birthdayDate.getDate())) age--;
      return age;
    };

    // 彙整所有參加者，並依活動日計算年齡
    const adults = [];   // 15歲以上
    const children = []; // 未滿15歲
    bookings.forEach(b => {
      const activityDate = new Date(b.bookingDate);
      (b.participants || []).forEach(p => {
        const bd = parseRocBirthday(p.birthday);
        const age = calcAge(bd, activityDate);
        const row = {
          name: p.name || '',
          idNumber: p.idNumber || '',
          birthday: toRoc7(p.birthday),
        };
        if (age >= 15) adults.push(row);
        else children.push(row);
      });
    });

    // 產生 XLS（使用 xlsx 套件）
    const headers = [
      '被保險人姓名\n(必填)\n※主被保險人放第一列',
      '被保險人ID\n(必填)',
      '出生日期\n(必填)',
      '英文姓名\n',
      '護照號碼\n',
      '投保實支\n',
      '監護宣告\n',
      '受益人姓名\n(法定繼承人不須輸入)',
      '行動電話廠牌型號',
      '受益人ID\n(超過二等親時必入)',
      '受益人與被保險人關係(請填寫代碼)\n01 本人、02 配偶、03 子女、04 父母、05 配偶父母、06 兄弟姐妹、07 (外)祖父母、08 (外)孫子女、09 其他、13 父子、14 父女、15 母子、16 母女、17 (外)祖孫',
      '受益人備註',
      '自主管理',
      '投保法傳',
    ];

    const makeSheet = (rows) => {
      const data = [headers, ...rows.map(r => [r.name, r.idNumber, r.birthday, '', '', '', '', '', '', '', '', '', '', ''])];
      return XLSX.utils.aoa_to_sheet(data);
    };

    const wb = XLSX.utils.book_new();
    const ws1 = makeSheet(adults);
    const ws2 = makeSheet(children);
    ws1['!cols'] = [14, 14, 10, 12, 12, 8, 8, 14, 14, 14, 40, 12, 8, 8].map(w => ({ wch: w }));
    ws2['!cols'] = ws1['!cols'];
    XLSX.utils.book_append_sheet(wb, ws1, '成人名冊（15歲以上）');
    XLSX.utils.book_append_sheet(wb, ws2, '未成年名冊（未滿15歲）');

    return XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
}

// ── GET /experience-bookings/insurance-download - 下載保險名冊 XLS ──
router.get('/insurance-download', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { bookingId, gymId, from, to } = req.query;
    const effectiveGymId = req.staff.role === 'super_admin' ? gymId : req.staff.gymId;
    let bookings = [];
    if (bookingId) {
      const doc = await db.collection('experienceBookings').doc(bookingId).get();
      if (doc.exists) bookings = [{ id: doc.id, ...doc.data() }];
    } else {
      let ref = db.collection('experienceBookings').where('status', '!=', 'cancelled');
      if (effectiveGymId) ref = ref.where('gymId', '==', effectiveGymId);
      const snap = await ref.get();
      bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (from) bookings = bookings.filter(b => b.bookingDate >= from);
      if (to)   bookings = bookings.filter(b => b.bookingDate <= to);
    }
    const buf = buildInsuranceXlsBuffer(bookings);
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`旅平險名冊_${today}.xls`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /experience-bookings/:id/send-insurance-email - 一鍵寄送單筆保險名冊 ──
router.post('/:id/send-insurance-email', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('experienceBookings').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '查無此預約' });
    const b = { id: doc.id, ...doc.data() };

    const sdoc = await db.collection('systemSettings').doc('experienceCourses').get();
    const settings = sdoc.exists ? sdoc.data() : {};
    const to = (settings.insuranceRecipientEmail || '').trim();
    if (!to) return res.status(400).json({ error: 'NO_RECIPIENT', message: '尚未設定保險名冊收件人 email（請至體驗課程設定填寫）' });

    // 標題：紅石攀岩{館}{年}年{月}月{日}日{首位姓名}等{N}人保險名冊
    const gymName = b.gymId === 'gym-hsinchu' ? '新竹館' : b.gymId === 'gym-shilin' ? '士林館' : '';
    const [yy, mm, dd] = String(b.bookingDate || '').split('-');
    const firstName = (b.participants && b.participants[0]?.name) || b.contactName || '';
    const count = b.numParticipants || (b.participants || []).length || 0;
    const title = `紅石攀岩${gymName}${yy || ''}年${mm ? parseInt(mm) : ''}月${dd ? parseInt(dd) : ''}日${firstName}等${count}人保險名冊`;

    const tpl = settings.insuranceEmailTemplate || '{title}';
    const body = tpl.replace(/{title}/g, title).replace(/{gym}/g, gymName)
      .replace(/{date}/g, b.bookingDate || '').replace(/{name}/g, firstName).replace(/{count}/g, count);

    const buf = buildInsuranceXlsBuffer([b]);
    const fileName = `${title}.xls`;

    const result = await emailService.sendEmail({
      to, subject: title,
      html: `<div style="font-family:sans-serif;white-space:pre-wrap;font-size:14px">${body}</div>`,
      text: body,
      attachments: [{ filename: fileName, content: buf.toString('base64') }],
    });
    if (result.error) return res.status(502).json({ error: 'EMAIL_FAILED', message: '寄送失敗：' + result.error });

    // 上傳 Storage + 保存歷史紀錄
    let fileUrl = null, filePath = null;
    try {
      const bucket = getStorage().bucket();
      filePath = `insurance-rosters/${b.gymId}/${b.id}_${Date.now()}.xls`;
      const f = bucket.file(filePath);
      await f.save(buf, { metadata: { contentType: 'application/vnd.ms-excel' } });
      [fileUrl] = await f.getSignedUrl({ action: 'read', expires: '2035-01-01' });
    } catch (e) { console.error('insurance storage:', e.message); }

    await db.collection('insuranceExports').add({
      bookingId: b.id, gymId: b.gymId, courseType: b.courseType,
      title, recipient: to, bookingDate: b.bookingDate, count, firstName,
      fileName, filePath, fileUrl,
      emailId: result.id || null, skipped: !!result.skipped,
      sentBy: req.staff.id, sentByName: req.staff.name, createdAt: new Date(),
    });

    res.json({ success: true, title, message: result.skipped ? '已建立名冊並保存（Email 未設定 RESEND_API_KEY，未實際寄出）' : `已寄送至 ${to}` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/insurance-history - 歷史保險名冊（分館）──
router.get('/insurance-history', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff.role === 'super_admin' ? (req.query.gymId || null) : req.staff.gymId;
    const snap = await db.collection('insuranceExports').get();
    let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (gymId) records = records.filter(r => r.gymId === gymId);
    records.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
    res.json({ records: records.slice(0, 200) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /experience-bookings/settings - 取得課程設定 ──────────────
router.get('/settings', authenticateAny, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('experienceCourses').get();
    if (doc.exists) return res.json(doc.data());
    // 預設值
    res.json(defaultSettings());
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

// ── PUT /experience-bookings/settings - 更新課程設定 ──────────────
router.put('/settings', authenticate, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('systemSettings').doc('experienceCourses').set({
      ...req.body, updatedAt: new Date(), updatedBy: req.staff.id,
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error:'SERVER_ERROR', message:err.message }); }
});

function defaultSettings() {
  return {
    description: '想要攀岩，卻總是不得其門而入？紅石抱石體驗課程專為新手設計，從安全守則、攀爬規則、熱身、手/腳動作技巧到路線示範，由教練全程指導。',
    notice: '請先透過粉絲頁確認日期時間後再填寫。費用含入場、岩鞋租借、教練費及一日活動保險，一經投保恕無法退保。',
    paymentDeadlineDays: 3,
    bankInfo: {
      hsinchu: { bankName: '台新銀行(812)', branch: '關東橋分行', account: '21000100211430', accountName: '紅石攀岩有限公司' },
      shilin:  { bankName: '富邦銀行(012)', branch: '竹北分行', account: '746102003014', accountName: '紅石攀岩有限公司' },
    },
    courseTypes: [
      { id:'general',    label:'抱石體驗課程',           active:true, needsInsurance:true,
        pricingType:'tiered',
        tiers:[{min:1,max:1,price:975},{min:2,max:3,price:875},{min:4,max:5,price:825},{min:6,max:12,price:775}],
        durationNote:'1~2小時' },
      { id:'children',   label:'小蜘蛛人（兒童）',         active:true, needsInsurance:false, pricingType:'fixed', price:600, durationNote:'1小時' },
      { id:'skill_fri',  label:'抱石技巧班（週五20:00）',   active:true, needsInsurance:true, pricingType:'fixed', price:1075, durationNote:'2小時' },
      { id:'skill_sun14',label:'抱石技巧班（週日14:00）',   active:true, needsInsurance:true, pricingType:'fixed', price:900,  durationNote:'1.5小時' },
    ],
    // 保險名冊一鍵寄送設定
    insuranceRecipientEmail: '',   // 全館共用收件人 email
    insuranceEmailTemplate: '{title}', // 信件內容公版（可用 {title} {gym} {date} {name} {count}）
    hsinchu: { bankInfo: null }, // 新竹館可覆蓋匯款帳號
  };
}

// ── POST /experience-bookings/expire-unpaid - 到期未付款自動取消 ──
// 可設定 cron 每天執行，或加入待辦總覽手動觸發
router.post('/expire-unpaid', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const settings = await db.collection('systemSettings').doc('experienceCourses').get();
    const deadlineDays = settings.exists ? (settings.data().paymentDeadlineDays || 3) : 3;
    const cutoff = new Date(Date.now() - deadlineDays * 24 * 3600000);

    const snap = await db.collection('experienceBookings').where('status', '==', 'pending').get();
    let cancelled = 0;
    for (const doc of snap.docs) {
      const createdAt = doc.data().createdAt?.toDate?.() || new Date(0);
      if (createdAt < cutoff) {
        await doc.ref.update({ status: 'cancelled', cancelReason: `超過 ${deadlineDays} 日未付款自動取消`, cancelledAt: new Date(), updatedAt: new Date() });
        cancelled++;
      }
    }
    res.json({ success: true, cancelled, message: `已取消 ${cancelled} 筆逾期未付款預約` });
  } catch(err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});
