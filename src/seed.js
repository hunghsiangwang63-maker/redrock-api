/**
 * Seed Script — 建立初始測試資料
 *
 * 執行方式：
 *   node src/seed.js
 *
 * 建立內容：
 *   - 2個場館（新竹館、竹北館）
 *   - 1個總管理員
 *   - 各館1個場館管理員、1個正職、1個兼職
 *   - 票種定義
 *   - 測試會員3位（含1名未成年）
 */

require('dotenv').config();
const { initFirebase, getDb, COLLECTIONS } = require('./config/firebase');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

initFirebase();
const db = getDb();

const log = (msg) => console.log(`  ${msg}`);
const ok = (msg) => console.log(`  ✅ ${msg}`);
const err = (msg) => console.error(`  ❌ ${msg}`);

// ── 建立場館 ─────────────────────────────────────────────────────
async function seedGyms() {
  console.log('\n🏟️  建立場館...');
  const gyms = [
    {
      id: 'gym-hsinchu',
      name: '紅石攀岩館 新竹館',
      shortName: '新竹館',
      address: '新竹市東區○○路123號',
      phone: '03-123-4567',
      status: 'active',
      paymentSettings: {
        ecpayMerchantId: '3002607',
        ecpayHashKey: 'test-hash-key',
        ecpayHashIv: 'test-hash-iv',
        bankName: '玉山銀行',
        bankCode: '808',
        bankAccount: '1234-567-890123',
        bankAccountName: '紅石攀岩有限公司',
        jkoPayEnabled: true,
        linePayChannelId: '',
        linePayChannelSecret: '',
        paymentDeadlineHours: 48,
        refundRules: { fullRefundDays: 7, partialRefundDays: 3, partialRefundPct: 50, noRefundDays: 1 },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'gym-zhubei',
      name: '紅石攀岩館 竹北館',
      shortName: '竹北館',
      address: '新竹縣竹北市○○路456號',
      phone: '03-234-5678',
      status: 'active',
      paymentSettings: {
        ecpayMerchantId: '3002608',
        ecpayHashKey: 'test-hash-key-2',
        ecpayHashIv: 'test-hash-iv-2',
        bankName: '玉山銀行',
        bankCode: '808',
        bankAccount: '9876-543-210987',
        bankAccountName: '紅石攀岩有限公司',
        jkoPayEnabled: true,
        linePayChannelId: '',
        paymentDeadlineHours: 48,
        refundRules: { fullRefundDays: 7, partialRefundDays: 3, partialRefundPct: 50, noRefundDays: 1 },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  for (const gym of gyms) {
    await db.collection(COLLECTIONS.GYMS).doc(gym.id).set(gym);
    ok(`場館：${gym.name}`);
  }
  return gyms;
}

// ── 建立工作人員 ─────────────────────────────────────────────────
async function seedStaff() {
  console.log('\n👤  建立工作人員帳號...');
  const password = await bcrypt.hash('redrock123', 10);

  const staffList = [
    // 總管理員
    { id: 'staff-super', email: 'admin@redrock.app', name: '系統管理員', role: 'super_admin', gymId: null, gymName: null },
    // 新竹館
    { id: 'staff-mgr-hc', email: 'manager.hc@redrock.app', name: '陳館長', role: 'gym_manager', gymId: 'gym-hsinchu', gymName: '新竹館' },
    { id: 'staff-ft-hc',  email: 'wang@redrock.app',       name: '王小明', role: 'full_time',  gymId: 'gym-hsinchu', gymName: '新竹館' },
    { id: 'staff-pt-hc',  email: 'lee@redrock.app',        name: '李志成', role: 'part_time',  gymId: 'gym-hsinchu', gymName: '新竹館' },
    // 竹北館
    { id: 'staff-mgr-zb', email: 'manager.zb@redrock.app', name: '林館長', role: 'gym_manager', gymId: 'gym-zhubei', gymName: '竹北館' },
    { id: 'staff-ft-zb',  email: 'chen.zb@redrock.app',    name: '陳雅玲', role: 'full_time',  gymId: 'gym-zhubei', gymName: '竹北館' },
  ];

  for (const s of staffList) {
    await db.collection(COLLECTIONS.STAFF).doc(s.id).set({
      ...s,
      passwordHash: password,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ok(`${s.role.padEnd(12)} ${s.email}`);
  }

  console.log('\n  📋 登入帳號一覽：');
  log('  角色          Email                      密碼');
  log('  ─────────────────────────────────────────────');
  staffList.forEach(s => log(`  ${s.role.padEnd(12)} ${s.email.padEnd(28)} redrock123`));
}

// ── 建立票種 ─────────────────────────────────────────────────────
async function seedPassTypes() {
  console.log('\n🎫  建立票種...');
  const types = [
    { id: 'pt-shared-monthly', gymId: null, name: '月票（全館）', scope: 'shared', targetGymId: null, price: 1800, durationDays: 30, credits: null },
    { id: 'pt-hc-monthly',     gymId: 'gym-hsinchu', name: '月票（新竹館）', scope: 'single', targetGymId: 'gym-hsinchu', price: 1500, durationDays: 30, credits: null },
    { id: 'pt-zb-monthly',     gymId: 'gym-zhubei',  name: '月票（竹北館）', scope: 'single', targetGymId: 'gym-zhubei',  price: 1500, durationDays: 30, credits: null },
    { id: 'pt-hc-10x',         gymId: 'gym-hsinchu', name: '10次回數票（新竹）', scope: 'single', targetGymId: 'gym-hsinchu', price: 2800, durationDays: 90, credits: 10 },
    { id: 'pt-zb-10x',         gymId: 'gym-zhubei',  name: '10次回數票（竹北）', scope: 'single', targetGymId: 'gym-zhubei',  price: 2800, durationDays: 90, credits: 10 },
    { id: 'pt-child-hc',       gymId: 'gym-hsinchu', name: '兒童月票（新竹）',   scope: 'single', targetGymId: 'gym-hsinchu', price: 1200, durationDays: 30, credits: null },
  ];

  for (const t of types) {
    await db.collection(COLLECTIONS.PASS_TYPES).doc(t.id).set({
      ...t, isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });
    ok(`NT$${t.price} · ${t.name}`);
  }
}

// ── 建立測試會員 ─────────────────────────────────────────────────
async function seedMembers() {
  console.log('\n👥  建立測試會員...');
  const pw = await bcrypt.hash('member123', 10);
  const dayjs = require('dayjs');

  const members = [
    {
      id: 'member-001',
      name: '林怡君', phone: '0912345678', email: 'yi@example.com',
      birthday: '1990-01-14', gender: 'female',
      isMinor: false, isChildAccount: false, parentMemberId: null,
      registeredBy: 'migration', emailVerified: true,
    },
    {
      id: 'member-002',
      name: '陳建宏', phone: '0923456789', email: 'chen@example.com',
      birthday: '1988-04-15', gender: 'male',
      isMinor: false, isChildAccount: false, parentMemberId: null,
      registeredBy: 'staff', emailVerified: true,
    },
    {
      id: 'member-003',
      name: '林小明', phone: '0912345678', email: 'yi@example.com', // 共用家長電話
      birthday: '2013-06-20', gender: 'male',
      isMinor: true, isChildAccount: true, parentMemberId: 'member-001',
      registeredBy: 'staff', emailVerified: true,
    },
  ];

  for (const m of members) {
    // 產生 QR Code（簡化版，不上傳 Storage）
    const qrCodeId = `RR-${m.id.slice(-6).toUpperCase()}`;
    const qrBase64 = await QRCode.toDataURL(JSON.stringify({ type:'member', id:m.id, qrCodeId }), { width:200 });

    await db.collection(COLLECTIONS.MEMBERS).doc(m.id).set({
      ...m,
      qrCode: qrBase64,
      qrCodeId,
      passwordHash: pw,
      emergencyContact: { name: '緊急聯絡人', phone: '0900000000', relation: '家人' },
      isBlocked: m.isMinor, // 未成年先封鎖（等待 Waiver）
      blockReasons: m.isMinor ? ['waiver_unsigned'] : [],
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ok(`${m.name.padEnd(8)} ${m.phone} ${m.isMinor ? '（未成年）' : ''}`);
  }

  // 為林怡君建立 Waiver
  await db.collection(COLLECTIONS.WAIVERS).doc('member-001').set({
    memberId: 'member-001', memberName: '林怡君',
    memberSignatureUrl: 'seed-signature',
    memberSignedAt: new Date(), memberSignedIp: '127.0.0.1', memberSignedBy: 'migration',
    parentRequired: false, isComplete: true,
    source: 'migration', lockedAt: new Date(), createdAt: new Date(),
  });
  ok('Waiver 已建立（林怡君）');

  // 為林怡君建立墜落測驗
  await db.collection(COLLECTIONS.FALL_TESTS).doc(uuidv4()).set({
    memberId: 'member-001', gymId: 'gym-hsinchu',
    result: 'pass', testedAt: new Date(Date.now() - 30 * 86400000),
    confirmedBy: 'staff-ft-hc', notes: '', createdAt: new Date(),
  });
  ok('墜落測驗已建立（林怡君 · 通過）');

  // 為林怡君建立定期票
  const dayEnd = dayjs().add(30, 'day').format('YYYY-MM-DD');
  await db.collection(COLLECTIONS.MEMBER_PASSES).doc(uuidv4()).set({
    memberId: 'member-001', gymId: 'gym-hsinchu',
    passTypeId: 'pt-shared-monthly', passTypeName: '月票（全館）',
    scope: 'shared', targetGymId: null,
    startDate: dayjs().format('YYYY-MM-DD'), endDate: dayEnd,
    credits: null, originalCredits: null, status: 'active',
    soldByStaffId: 'staff-ft-hc', notes: '',
    createdAt: new Date(), updatedAt: new Date(),
  });
  ok('定期票已建立（林怡君 · 月票共用）');

  // 更新林怡君封鎖狀態（現在已完成 Waiver + 墜落測驗）
  await db.collection(COLLECTIONS.MEMBERS).doc('member-001').update({ isBlocked: false, blockReasons: [] });
  ok('林怡君帳號已解除封鎖');
}

// ── 建立測試優惠卡 ────────────────────────────────────────────────
async function seedDiscountCards() {
  console.log('\n🃏  建立測試優惠卡...');
  await db.collection('discountCards').doc('dc-test-001').set({
    id: 'dc-test-001',
    ownerMemberId: 'member-002',
    purchasePrice: 600,
    originalCredits: 10,
    remainingCredits: 7,
    bonusEarned: false, bonusUsed: false,
    purchasedAt: new Date(),
    expiresAt: new Date(Date.now() + 365 * 86400000),
    gymId: 'gym-hsinchu',
    soldByStaffId: 'staff-ft-hc',
    isActive: true, source: 'original', transferHistory: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  ok('優惠卡已建立（陳建宏 · 剩餘7次）');
}

// ── 建立測試黑卡 ──────────────────────────────────────────────────
async function seedBlackCards() {
  console.log('\n🖤  建立測試黑卡...');
  await db.collection('legacyBlackCards').doc('bc-test-001').set({
    id: 'bc-test-001',
    barcode: 'BC-2024-00123',
    memberId: 'member-002',
    originalCredits: 12,
    remainingCredits: 5,
    gymId: 'gym-hsinchu',
    boundAt: new Date(), boundBy: 'staff-ft-hc',
    expiresAt: null, // 原始卡無期限
    isActive: true, source: 'original', transferHistory: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  ok('黑卡已建立（陳建宏 · 剩餘5次 · BC-2024-00123）');
}

// ── 主程式 ────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏔  RedRock 初始資料建立');
  console.log('═'.repeat(44));

  try {
    await seedGyms();
    await seedStaff();
    await seedPassTypes();
    await seedMembers();
    await seedDiscountCards();
    await seedBlackCards();

    console.log('\n\n✅ Seed 完成！\n');
    console.log('  測試帳號：');
    console.log('  工作人員  POST /auth/staff/login');
    console.log('            Email: wang@redrock.app');
    console.log('            Password: redrock123\n');
    console.log('  會員      POST /auth/member/login');
    console.log('            Phone: 0912345678');
    console.log('            Password: member123\n');
    console.log('  驗票測試  POST /checkin/verify');
    console.log('            { identifier: "0912345678", gymId: "gym-hsinchu" }');
    console.log('\n');
  } catch (e) {
    err('Seed 失敗：' + e.message);
    console.error(e);
  }

  process.exit(0);
}

main();

// ── 建立標準營業時間 + 測試公告 ──────────────────────────────────
async function seedGymHoursAndAnnouncements() {
  console.log('\n🕐  建立營業時間與公告...');
  const db = getDb();

  const regularHours = {
    mon: { open: '14:00', close: '22:00', closed: false },
    tue: { open: '14:00', close: '22:00', closed: false },
    wed: { open: '14:00', close: '22:00', closed: false },
    thu: { open: '14:00', close: '22:00', closed: false },
    fri: { open: '14:00', close: '22:00', closed: false },
    sat: { open: '10:00', close: '22:00', closed: false },
    sun: { open: '10:00', close: '21:00', closed: false },
  };

  for (const gymId of ['gym-hsinchu', 'gym-zhubei']) {
    await db.collection('gyms').doc(gymId).update({
      regularHours,
      googleMapsUrl: 'https://maps.google.com',
      parkingInfo: '館內附設停車場，免費停車2小時',
      transitInfo: '搭乘公車至○○站下車步行5分鐘',
      facilities: ['抱石牆', '訓練區', '更衣室', '淋浴間', '粉袋販售'],
      updatedAt: new Date(),
    });
    ok(`${gymId} 營業時間已設定`);
  }

  // 測試公告
  const announcements = [
    {
      id: uuidv4(),
      gymId: null, // 兩館
      type: 'general',
      title: '2026 紅石兒童抱石賽開放報名！',
      content: '報名截止 7/7，歡迎踴躍參加。',
      showOnBanner: true,
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-07-07',
      publishAt: null,
      isPublished: true,
      createdBy: 'staff-mgr-hc',
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: uuidv4(),
      gymId: 'gym-hsinchu',
      type: 'route_change',
      title: '本週六路線更換，B區暫停使用',
      content: '6/14（六）進行路線更換，B區上午10:00-14:00暫停使用，其餘區域正常開放。',
      showOnBanner: true,
      effectiveFrom: '2026-06-14',
      effectiveTo: '2026-06-14',
      publishAt: null,
      isPublished: true,
      createdBy: 'staff-mgr-hc',
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: uuidv4(),
      gymId: null,
      type: 'special_hours',
      title: '端午連假（6/28-6/30）特殊營業時間',
      content: '連假期間每日 10:00 - 21:00 營業。',
      showOnBanner: false,
      effectiveFrom: '2026-06-28',
      effectiveTo: '2026-06-30',
      specialOpen: '10:00',
      specialClose: '21:00',
      publishAt: null,
      isPublished: true,
      createdBy: 'staff-super',
      createdAt: new Date(), updatedAt: new Date(),
    },
  ];

  for (const a of announcements) {
    await db.collection('gymAnnouncements').doc(a.id).set(a);
    ok(`公告：${a.title}`);
  }
}

// 在 main() 裡加入呼叫
const _originalMain = main;
// re-export with extra seed
module.exports = { seedGymHoursAndAnnouncements };
