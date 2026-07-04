/**
 * 循環邏輯回歸測試（卡片 / 紅利 / 入場）
 * ───────────────────────────────────────────────────────────────
 * 用「記憶體版 Firestore mock」把真實的 service 檔案載進來跑，
 * 完全不連任何正式 Firebase，可安全在本機/CI 重複執行。
 *
 * 執行： npm run test:loop      （或  node scripts/loop-test.js ）
 * 回傳： 全數通過 exit 0；有失敗 exit 1；harness 自身崩潰 exit 2。
 *
 * 涵蓋的 loop：
 *   A. 新優惠卡  discountCardService        買→用滿→紅利→移轉→顯示
 *   B. 舊優惠卡  legacyDiscountCardService  bind→用滿→移轉（含首次移轉）
 *   C. 黑卡      legacyCardService          bind→用→移轉（含首次移轉）→退回
 *   D. 入場      checkinService             紅利/黑卡 confirm 扣點 + cancel 還原
 *   E. 課程      courseService              報名/候補→請假→補課→退費取消→插班計費
 *   F. 分期      installmentService         建計畫/頭款→繳款→逾期→擋入場→補繳→結清
 */
const path = require('path');
const { v4: uuid } = require('uuid');
const dayjs = require('dayjs');

const SRC = path.join(__dirname, '..', 'src');

// ── Timestamp stub（模擬 Firestore 讀回來的 Timestamp，有 .toDate()）──
function tsStub(d) {
  return { _ts: true, _d: new Date(d.getTime()), toDate() { return this._d; } };
}
function toStore(v) {
  if (v instanceof Date) return tsStub(v);
  if (v && typeof v === 'object' && v._ts && typeof v.toDate === 'function') return v; // 已是 stub
  if (Array.isArray(v)) return v.map(toStore);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = toStore(v[k]);
    return o;
  }
  return v;
}
function tsVal(v) {
  if (v && v._ts) return v._d.getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return v;
}

// ── 記憶體版 Firestore（支援本專案 service 用到的 API 子集）──
function makeDb() {
  const store = {};
  const col = (n) => (store[n] ||= new Map());
  function docRef(cname, id) {
    return {
      id,
      async get() {
        const m = col(cname);
        const raw = m.get(id);
        return { exists: m.has(id), id, data: () => raw, ref: docRef(cname, id) };
      },
      async set(obj) { col(cname).set(id, toStore(obj)); },
      async update(obj) {
        const cur = col(cname).get(id) || {};
        col(cname).set(id, { ...cur, ...toStore(obj) });
      },
      async delete() { col(cname).delete(id); },
    };
  }
  function query(cname, filters = [], order = null, lim = null) {
    return {
      where(f, op, val) { return query(cname, [...filters, { f, op, val }], order, lim); },
      orderBy(f, dir = 'asc') { return query(cname, filters, { f, dir }, lim); },
      limit(n) { return query(cname, filters, order, n); },
      async get() {
        let docs = [...col(cname).entries()].map(([id, raw]) => ({ id, raw }));
        for (const { f, op, val } of filters) {
          docs = docs.filter(({ raw }) => {
            const a = tsVal(raw[f]);
            const b = tsVal(val);
            switch (op) {
              case '==': return raw[f] === val;
              case '>=': return a >= b;
              case '>': return a > b;
              case '<=': return a <= b;
              case '<': return a < b;
              case 'in': return Array.isArray(val) && val.includes(raw[f]);
              default: return true;
            }
          });
        }
        if (order) {
          const { f, dir } = order;
          docs.sort((a, b) => {
            const av = tsVal(a.raw[f]), bv = tsVal(b.raw[f]);
            return dir === 'desc' ? bv - av : av - bv;
          });
        }
        if (lim != null) docs = docs.slice(0, lim);
        return {
          size: docs.length, empty: docs.length === 0,
          docs: docs.map(({ id, raw }) => ({ id, data: () => raw, ref: docRef(cname, id) })),
        };
      },
    };
  }
  const collection = (name) => ({
    doc(id) { return docRef(name, id ?? uuid()); },
    async add(obj) { const id = uuid(); await docRef(name, id).set(obj); return docRef(name, id); },
    where(f, op, val) { return query(name).where(f, op, val); },
    orderBy(f, dir) { return query(name).orderBy(f, dir); },
    limit(n) { return query(name).limit(n); },
    async get() { return query(name).get(); },
  });
  return {
    collection,
    // 可運作的 batch：暫存操作、commit 時逐一套用到真實 docRef（分期逾期批次等需要）
    batch() {
      const ops = [];
      return {
        set: (ref, obj) => ops.push(() => ref.set(obj)),
        update: (ref, obj) => ops.push(() => ref.update(obj)),
        delete: (ref) => ops.push(() => ref.delete()),
        async commit() { for (const op of ops) await op(); },
      };
    },
    _store: store,
  };
}

const db = makeDb();

// ── 注入 mock 模組（覆蓋 require.cache，需在載入 service 前）──
function inject(rel, exports) {
  const p = require.resolve(path.join(SRC, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
inject('config/firebase.js', {
  getDb: () => db, getStorage: () => ({}), getAuth: () => ({}),
  initFirebase: () => {},
  COLLECTIONS: {
    MEMBERS: 'members', WAIVERS: 'waivers', FALL_TESTS: 'fallTests',
    CHECK_INS: 'checkIns', PENDING_CHECK_INS: 'pendingCheckIns',
    SINGLE_ENTRY_TICKETS: 'singleEntryTickets', DISCOUNT_CARDS: 'discountCards',
    INSTALLMENT_PLANS: 'installmentPlans',
  },
});
inject('services/emailService.js', {
  sendBonusTriggered: async () => {}, sendBonusExpiryWarning: async () => {},
});
inject('services/memberService.js', {
  getMember: async (id) => {
    const d = await db.collection('members').doc(id).get();
    return d.exists ? { id, ...d.data() } : null;
  },
  getMemberByPhone: async () => null,
});
inject('services/notificationService.js', {
  createNotification: async () => {}, notifyRoleInGym: async () => {},
});

// ── 載入真實 service ──
const dcs = require(path.join(SRC, 'services/discountCardService.js'));
const ldcs = require(path.join(SRC, 'services/legacyDiscountCardService.js'));
const lcs = require(path.join(SRC, 'services/legacyCardService.js'));
const bonus = require(path.join(SRC, 'services/bonusService.js'));
const checkin = require(path.join(SRC, 'services/checkinService.js'));
const course = require(path.join(SRC, 'services/courseService.js'));
const inst = require(path.join(SRC, 'services/installmentService.js'));
const { restoreEntryCredits } = require(path.join(SRC, 'routes/cancelCheckin.js'));

// ── 測試框架 ──
let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function seedMember(id, extra = {}) {
  await db.collection('members').doc(id).set({ id, name: id, email: null, ...extra });
}
// 每個情境前重置：清空所有集合，重新種 A/B/C（避免情境間互相污染）
async function reset() {
  for (const k of Object.keys(db._store)) db._store[k].clear();
  await seedMember('A'); await seedMember('B'); await seedMember('C');
}
async function expectThrow(fn) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, code: e.code, message: e.message }; }
}
const section = (t) => console.log(`\n=== ${t} ===`);

// 直接種一張待確認入場（略過 waiver/墜測/entryTypes 等前置驗證，聚焦扣點/還原 loop）
async function seedPending(over) {
  const qrToken = uuid();
  await db.collection('pendingCheckIns').doc(qrToken).set({
    qrToken, memberId: 'A', gymId: 'gym-hsinchu', entryType: 'bonus',
    baseEntryType: null, passId: null, discountCardId: null, blackCardId: null,
    singleEntryTicketId: null, bonusId: null, paymentMethod: null,
    amount: 0, originalAmount: 0, isTeamDiscount: false,
    rentShoes: false, shoesPrice: 0, rentChalk: false, chalkPrice: 0,
    status: 'pending', createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    confirmedAt: null, confirmedBy: null, cancelledAt: null, cancelledBy: null,
    checkInId: null, memberName: 'A', memberType: 'general', isTeamMember: false,
    ...over,
  });
  return qrToken;
}

// 課程 / 場次 seeders
const dstr = (d) => dayjs(d).format('YYYY-MM-DD');
async function seedCourse(id, over = {}) {
  await db.collection('courses').doc(id).set({
    id, name: `課程${id}`, gymId: 'gym-hsinchu', price: 6000,
    totalSessions: 8, maxLeaves: 2, leaveDeadlineHours: 2, makeupDeadlineDays: 60,
    allowMakeup: true, categoryId: 'cat-lead', gymAccessDaysBefore: 0, gymAccessDaysAfter: 1,
    startDate: dstr(dayjs().subtract(1, 'day')), midpointSurcharge: 1.05,
    ...over,
  });
}
async function seedSession(id, over = {}) {
  await db.collection('courseSessions').doc(id).set({
    id, courseId: 'C1', courseName: '課程C1', gymId: 'gym-hsinchu',
    date: dstr(dayjs().add(10, 'day')), startTime: '10:00', endTime: '12:00',
    maxStudents: 2, enrolledCount: 0, waitlistCount: 0, status: 'active',
    ...over,
  });
}

(async () => {
  // ═══════════════ A. 新優惠卡 ═══════════════
  await reset();
  section('A1 新卡：買→用滿10→紅利觸發並可顯示');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'gym-hsinchu', staffId: 's', price: 1000 });
    let lastTrig = false;
    for (let i = 0; i < 10; i++) lastTrig = (await dcs.useDiscountCard(card.id, 'gym-hsinchu')).bonusTriggered;
    ok(lastTrig === true, '第10次使用觸發紅利');
    const bonuses = await bonus.getMemberBonuses('A');
    ok(bonuses.length === 1, 'getMemberBonuses(A) 顯示 1 筆紅利', `實際=${bonuses.length}`);
    ok(bonuses[0] && bonuses[0].expiresAtFormatted, '紅利有 expiresAtFormatted 可顯示');
  }

  await reset();
  section('A2 新卡移轉：母子卡合計用滿→紅利只觸發一次、歸原購買者');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    const t = await dcs.transferDiscountCard({ fromCardId: card.id, toMemberId: 'B', credits: 4, staffId: 's' });
    let trigCount = 0;
    for (let i = 0; i < 6; i++) if ((await dcs.useDiscountCard(card.id, 'g')).bonusTriggered) trigCount++;
    for (let i = 0; i < 4; i++) if ((await dcs.useDiscountCard(t.newCard.id, 'g')).bonusTriggered) trigCount++;
    ok(trigCount === 1, '合計第10次只觸發一次紅利', `trigCount=${trigCount}`);
    ok((await bonus.getMemberBonuses('A')).length === 1, '紅利歸原購買者 A（1 筆）');
    ok((await bonus.getMemberBonuses('B')).length === 0, '受贈者 B 無紅利');
  }

  await reset();
  section('A3 新卡：超用防護（第11次被擋）');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const r = await expectThrow(() => dcs.useDiscountCard(card.id, 'g'));
    ok(r.threw && ['CARD_NO_CREDITS', 'CARD_INACTIVE'].includes(r.code), '第11次使用被擋', `code=${r.code}`);
  }

  await reset();
  section('A4 紅利移轉：A→C 繼承到期日、A 消失、C 顯示');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const b = (await bonus.getMemberBonuses('A'))[0];
    const res = await bonus.transferBonus({ bonusId: b.id, toMemberId: 'C', staffId: 's' });
    ok(res.expiresAt === b.expiresAtFormatted, '移轉後到期日繼承不變', `${res.expiresAt} vs ${b.expiresAtFormatted}`);
    ok((await bonus.getMemberBonuses('A')).length === 0, '移轉後 A 不再顯示');
    ok((await bonus.getMemberBonuses('C')).length === 1, '移轉後 C 顯示 1 筆');
  }

  await reset();
  section('A5 紅利使用後：不可再用、不可移轉');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const bId = (await bonus.getMemberBonuses('A'))[0].id;
    await bonus.useBonus(bId, 'gym-hsinchu');
    ok((await bonus.getMemberBonuses('A')).length === 0, '使用後不再顯示於有效紅利');
    const r1 = await expectThrow(() => bonus.useBonus(bId, 'g'));
    ok(r1.threw && r1.code === 'BONUS_USED', '重複使用被擋 BONUS_USED', `code=${r1.code}`);
    const r2 = await expectThrow(() => bonus.transferBonus({ bonusId: bId, toMemberId: 'C', staffId: 's' }));
    ok(r2.threw && r2.code === 'BONUS_UNAVAILABLE', '已用紅利移轉被擋', `code=${r2.code}`);
  }

  // ═══════════════ B. 舊優惠卡 ═══════════════
  await reset();
  section('B1 舊優惠卡：bind→用滿→觸發紅利');
  {
    const card = await ldcs.bindLegacyDiscountCard({ memberId: 'B', remainingCredits: 3, gymId: 'g', staffId: 's' });
    let trig = false;
    for (let i = 0; i < 3; i++) trig = (await ldcs.useLegacyDiscountCard(card.id, 'g')).bonusTriggered;
    ok(trig === true, '舊卡用滿觸發紅利');
    ok((await bonus.getMemberBonuses('B')).length === 1, '舊卡紅利顯示於 B');
  }

  await reset();
  section('B2 舊優惠卡「首次」移轉（expiresAt=null → 設定1年）');
  {
    const card = await ldcs.bindLegacyDiscountCard({ memberId: 'A', remainingCredits: 5, gymId: 'g', staffId: 's' });
    const r = await expectThrow(() => ldcs.transferLegacyDiscountCard({ fromCardId: card.id, toMemberId: 'B', credits: 2, staffId: 's' }));
    ok(!r.threw, '首次移轉不應拋錯', r.threw ? `拋錯 msg=${r.message}` : '');
    if (!r.threw) {
      const b = await ldcs.getMemberLegacyDiscountCards('B');
      ok(b.length === 1 && b[0].remainingCredits === 2, '受贈者 B 取得 2 次子卡');
    }
  }

  await reset();
  section('B3 舊卡移轉後：母子卡合計用滿→紅利歸原持有者一次');
  {
    const card = await ldcs.bindLegacyDiscountCard({ memberId: 'A', remainingCredits: 5, gymId: 'g', staffId: 's' });
    const res = await ldcs.transferLegacyDiscountCard({ fromCardId: card.id, toMemberId: 'C', credits: 2, staffId: 's' });
    for (let i = 0; i < 3; i++) await ldcs.useLegacyDiscountCard(card.id, 'g');
    let trig = false;
    for (let i = 0; i < 2; i++) trig = (await ldcs.useLegacyDiscountCard(res.newCard.id, 'g')).bonusTriggered;
    ok(trig === true, '合計第5次觸發紅利');
    ok((await bonus.getMemberBonuses('A')).length === 1 && (await bonus.getMemberBonuses('C')).length === 0,
      '紅利歸原持有者 A、C 無');
  }

  // ═══════════════ C. 黑卡（legacyCardService）═══════════════
  await reset();
  section('C1 黑卡：bind→用滿→第N+1次被擋');
  {
    const card = await lcs.bindBlackCard({ memberId: 'A', remainingCredits: 3, gymId: 'g', staffId: 's' });
    for (let i = 0; i < 3; i++) await lcs.useBlackCard(card.id);
    const r = await expectThrow(() => lcs.useBlackCard(card.id));
    ok(r.threw && ['CARD_NO_CREDITS', 'CARD_INACTIVE'].includes(r.code), '用滿後被擋', `code=${r.code}`);
  }

  await reset();
  section('C2 黑卡「首次」移轉（expiresAt=null → 設定1年）');
  {
    const card = await lcs.bindBlackCard({ memberId: 'A', remainingCredits: 8, gymId: 'g', staffId: 's' });
    const r = await expectThrow(() => lcs.transferBlackCard({ fromCardId: card.id, toMemberId: 'B', credits: 3, staffId: 's' }));
    ok(!r.threw, '黑卡首次移轉不應拋錯', r.threw ? `拋錯 msg=${r.message}` : '');
    if (!r.threw) {
      const b = await lcs.getMemberBlackCards('B');
      ok(b.length === 1 && b[0].remainingCredits === 3, '受贈者 B 取得 3 次子卡');
      ok(b[0].expiresAtFormatted && b[0].daysLeft > 300, '子卡到期日約 1 年', `daysLeft=${b[0] && b[0].daysLeft}`);
    }
  }

  await reset();
  section('C3 黑卡「再次」移轉：繼承到期日不延長');
  {
    const r = await expectThrow(async () => {
      const card = await lcs.bindBlackCard({ memberId: 'A', remainingCredits: 8, gymId: 'g', staffId: 's' });
      const t1 = await lcs.transferBlackCard({ fromCardId: card.id, toMemberId: 'B', credits: 4, staffId: 's' });
      const t2 = await lcs.transferBlackCard({ fromCardId: t1.newCard.id, toMemberId: 'C', credits: 2, staffId: 's' });
      ok(t2.expiresAt === t1.expiresAt, '再次移轉到期日繼承（不延長）', `${t1.expiresAt} vs ${t2.expiresAt}`);
      ok(t2.isFirstTransfer === false, '再次移轉 isFirstTransfer=false');
    });
    if (r.threw) ok(false, '黑卡兩段移轉不應拋錯', `msg=${r.message}`);
  }

  await reset();
  section('C4 黑卡：退回 1 次（入場取消還原）');
  {
    const card = await lcs.bindBlackCard({ memberId: 'A', remainingCredits: 2, gymId: 'g', staffId: 's' });
    await lcs.useBlackCard(card.id);       // 剩 1
    await lcs.useBlackCard(card.id);       // 剩 0 → isActive false
    const r = await lcs.refundBlackCard(card.id);
    ok(r && r.creditsAfter === 1, '退回後剩餘 +1', `creditsAfter=${r && r.creditsAfter}`);
    const cards = await lcs.getMemberBlackCards('A');
    ok(cards.length === 1 && cards[0].isActive === true, '退回後卡片重新啟用');
  }

  // ═══════════════ D. 入場 loop（confirm 扣點 + cancel 還原）═══════════════
  await reset();
  section('D1 紅利入場：confirm 消耗紅利、建立入場紀錄');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const bId = (await bonus.getMemberBonuses('A'))[0].id;
    const qr = await seedPending({ entryType: 'bonus', bonusId: bId });
    const res = await checkin.confirmCheckIn(qr, 's', 'Staff');
    ok(res.checkIn && res.checkIn.entryType === 'bonus', 'confirm 建立紅利入場紀錄');
    ok((await bonus.getMemberBonuses('A')).length === 0, 'confirm 後紅利已消耗（不再顯示）');
  }

  await reset();
  section('D2 紅利入場「取消」→ 應還原紅利（/checkin/cancel 路徑）');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const bId = (await bonus.getMemberBonuses('A'))[0].id;
    const qr = await seedPending({ entryType: 'bonus', bonusId: bId });
    const { checkIn } = await checkin.confirmCheckIn(qr, 's', 'Staff');
    await checkin.cancelCheckIn(checkIn.id, 's');
    ok((await bonus.getMemberBonuses('A')).length === 1, '取消入場後紅利應還原（可再次使用）',
      '若失敗＝checkinService.cancelCheckIn 缺 bonus 還原分支');
  }

  await reset();
  section('D3 對照組：restoreEntryCredits（/cancel-checkins）確實會還原紅利');
  {
    const card = await dcs.purchaseDiscountCard({ memberId: 'A', gymId: 'g', staffId: 's', price: 1000 });
    for (let i = 0; i < 10; i++) await dcs.useDiscountCard(card.id, 'g');
    const bId = (await bonus.getMemberBonuses('A'))[0].id;
    await bonus.useBonus(bId, 'g'); // 模擬已入場消耗
    ok((await bonus.getMemberBonuses('A')).length === 0, '消耗後紅利不顯示（前置）');
    await restoreEntryCredits(db, { entryType: 'bonus', bonusId: bId });
    ok((await bonus.getMemberBonuses('A')).length === 1, 'restoreEntryCredits 還原紅利成功');
  }

  await reset();
  section('D4 黑卡入場：confirm 扣點 + cancel 還原');
  {
    const card = await lcs.bindBlackCard({ memberId: 'A', remainingCredits: 5, gymId: 'gym-hsinchu', staffId: 's' });
    const qr = await seedPending({ entryType: 'black_card', blackCardId: card.id });
    const { checkIn } = await checkin.confirmCheckIn(qr, 's', 'Staff');
    ok((await lcs.getBlackCardById(card.id)).remainingCredits === 4, 'confirm 後黑卡扣 1 次（剩 4）');
    await checkin.cancelCheckIn(checkIn.id, 's');
    ok((await lcs.getBlackCardById(card.id)).remainingCredits === 5, '取消後黑卡還原（剩 5）');
  }

  // ═══════════════ E. 課程（報名 / 請假 / 補課 / 退費）═══════════════
  const getSession = async (id) => (await db.collection('courseSessions').doc(id).get()).data();
  const getEnroll = async (memberId, sessionId) => {
    const s = await db.collection('courseEnrollments')
      .where('memberId', '==', memberId).where('sessionId', '==', sessionId).get();
    return s.docs.map(d => d.data())[0] || null;
  };

  await reset();
  section('E1 報名：未滿→confirmed、名額+1');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 2 });
    const r = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    ok(r.isWaitlist === false && r.enrollment.status === 'confirmed', '報名成功為 confirmed');
    ok((await getSession('S1')).enrolledCount === 1, '場次 enrolledCount=1');
  }

  await reset();
  section('E2 報名：額滿→waitlist、候補+1');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 2 });
    await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    await course.enrollCourse({ memberId: 'B', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' }); // 滿 2
    const r = await course.enrollCourse({ memberId: 'C', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    ok(r.isWaitlist === true && r.enrollment.status === 'waitlist', '第3人進候補');
    ok((await getSession('S1')).waitlistCount === 1, '場次 waitlistCount=1');
  }

  await reset();
  section('E3 報名：重複報名被擋');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 5 });
    await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    const r = await expectThrow(() => course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' }));
    ok(r.threw && r.code === 'ALREADY_ENROLLED', '重複報名被擋', `code=${r.code}`);
  }

  await reset();
  section('E4 請假：confirmed→leave、釋放名額、產生補課資格');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 3 });
    const e = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    const r = await course.requestLeave({ enrollmentId: e.enrollment.id, memberId: 'A', reason: '臨時有事' });
    ok(!!r.makeup, '請假後產生補課資格');
    ok((await getEnroll('A', 'S1')).status === 'leave', '報名狀態轉為 leave');
    ok((await getSession('S1')).enrolledCount === 0, '請假後釋放名額（enrolledCount=0）');
    ok((await course.getMemberMakeupRights('A')).length === 1, '補課資格顯示於會員');
  }

  await reset();
  section('E5 請假：達上限被擋（maxLeaves=1）');
  {
    await seedCourse('C1', { maxLeaves: 1 });
    await seedSession('S1', { courseId: 'C1', maxStudents: 5 });
    await seedSession('S2', { courseId: 'C1', maxStudents: 5, date: dstr(dayjs().add(12, 'day')) });
    const e1 = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    const e2 = await course.enrollCourse({ memberId: 'A', sessionId: 'S2', gymId: 'gym-hsinchu', staffId: 's' });
    await course.requestLeave({ enrollmentId: e1.enrollment.id, memberId: 'A', reason: 'x' });
    const r = await expectThrow(() => course.requestLeave({ enrollmentId: e2.enrollment.id, memberId: 'A', reason: 'y' }));
    ok(r.threw && r.code === 'MAX_LEAVES_EXCEEDED', '第2次請假達上限被擋', `code=${r.code}`);
  }

  await reset();
  section('E6 請假：超過截止時間被擋（場次在過去）');
  {
    await seedCourse('C1');
    await seedSession('S1', { courseId: 'C1', maxStudents: 5, date: dstr(dayjs().subtract(1, 'day')) });
    const e = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    const r = await expectThrow(() => course.requestLeave({ enrollmentId: e.enrollment.id, memberId: 'A', reason: 'x' }));
    ok(r.threw && r.code === 'LEAVE_DEADLINE_PASSED', '逾請假截止被擋', `code=${r.code}`);
  }

  await reset();
  section('E7 候補自動遞補：confirmed 請假→候補遞補為 confirmed');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 1 });
    const eA = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' }); // confirmed
    await course.enrollCourse({ memberId: 'B', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });          // waitlist
    await course.requestLeave({ enrollmentId: eA.enrollment.id, memberId: 'A', reason: 'x' });
    ok((await getEnroll('B', 'S1')).status === 'confirmed', '候補 B 自動遞補為 confirmed');
    ok((await getSession('S1')).enrolledCount === 1 && (await getSession('S1')).waitlistCount === 0, '名額/候補數正確');
  }

  await reset();
  section('E8 補課：請假資格→補到另一場次');
  {
    await seedCourse('C1');
    await seedSession('S1', { courseId: 'C1', maxStudents: 5 });
    await seedSession('S2', { courseId: 'C1', maxStudents: 5, date: dstr(dayjs().add(12, 'day')) });
    const e = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    await course.requestLeave({ enrollmentId: e.enrollment.id, memberId: 'A', reason: 'x' });
    const mkId = (await course.getMemberMakeupRights('A'))[0].id;
    const r = await course.enrollMakeup({ makeupId: mkId, memberId: 'A', targetSessionId: 'S2' });
    ok(!!r, '補課報名成功');
    ok((await course.getMemberMakeupRights('A')).length === 0, '補課資格已標記 used（不再顯示）');
    ok((await getEnroll('A', 'S2')).status === 'confirmed', '補課後於 S2 為 confirmed');
    ok((await getSession('S2')).enrolledCount === 1, 'S2 名額+1');
  }

  await reset();
  section('E9 補課：資格過期被擋');
  {
    await seedCourse('C1'); await seedSession('S2', { courseId: 'C1', maxStudents: 5 });
    await db.collection('courseMakeupRights').doc('M1').set({
      id: 'M1', memberId: 'A', courseId: 'C1', categoryId: 'cat-lead', gymId: 'gym-hsinchu',
      status: 'available', expiresAt: dayjs().subtract(1, 'day').toDate(),
    });
    const r = await expectThrow(() => course.enrollMakeup({ makeupId: 'M1', memberId: 'A', targetSessionId: 'S2' }));
    ok(r.threw && r.code === 'MAKEUP_EXPIRED', '過期補課資格被擋', `code=${r.code}`);
  }

  await reset();
  section('E10 補課：目標場次額滿被擋');
  {
    await seedCourse('C1'); await seedSession('S2', { courseId: 'C1', maxStudents: 1, enrolledCount: 1 });
    await db.collection('courseMakeupRights').doc('M1').set({
      id: 'M1', memberId: 'A', courseId: 'C1', categoryId: 'cat-lead', gymId: 'gym-hsinchu',
      status: 'available', expiresAt: dayjs().add(30, 'day').toDate(),
    });
    const r = await expectThrow(() => course.enrollMakeup({ makeupId: 'M1', memberId: 'A', targetSessionId: 'S2' }));
    ok(r.threw && r.code === 'SESSION_FULL', '額滿場次補課被擋', `code=${r.code}`);
  }

  await reset();
  section('E11 補課：跨類別 / 跨館被擋');
  {
    await seedCourse('C1', { categoryId: 'cat-lead', gymId: 'gym-hsinchu' });
    await seedCourse('C2', { categoryId: 'cat-boulder', gymId: 'gym-hsinchu' });
    await seedCourse('C3', { categoryId: 'cat-lead', gymId: 'gym-shilin' });
    await seedSession('S_cat', { courseId: 'C2', maxStudents: 5, gymId: 'gym-hsinchu' });
    await seedSession('S_gym', { courseId: 'C3', maxStudents: 5, gymId: 'gym-shilin' });
    const mk = () => db.collection('courseMakeupRights').doc('M1').set({
      id: 'M1', memberId: 'A', courseId: 'C1', categoryId: 'cat-lead', gymId: 'gym-hsinchu',
      status: 'available', expiresAt: dayjs().add(30, 'day').toDate(),
    });
    await mk();
    const rCat = await expectThrow(() => course.enrollMakeup({ makeupId: 'M1', memberId: 'A', targetSessionId: 'S_cat' }));
    ok(rCat.threw && rCat.code === 'DIFFERENT_CATEGORY', '跨類別補課被擋', `code=${rCat.code}`);
    await mk(); // 重置為 available
    const rGym = await expectThrow(() => course.enrollMakeup({ makeupId: 'M1', memberId: 'A', targetSessionId: 'S_gym' }));
    ok(rGym.threw && rGym.code === 'DIFFERENT_GYM', '跨館補課被擋', `code=${rGym.code}`);
  }

  await reset();
  section('E12 退費取消：confirmed 釋放名額並遞補候補');
  {
    await seedCourse('C1'); await seedSession('S1', { courseId: 'C1', maxStudents: 1 });
    await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' }); // confirmed
    await course.enrollCourse({ memberId: 'B', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' }); // waitlist
    const cancelled = await course.cancelCourseEnrollments({ courseId: 'C1', memberId: 'A', reason: '退費' });
    ok(cancelled === 1, '取消 1 筆報名');
    ok((await getEnroll('A', 'S1')).status === 'cancelled', 'A 報名轉為 cancelled');
    ok((await getEnroll('B', 'S1')).status === 'confirmed', '候補 B 遞補為 confirmed');
    ok((await getSession('S1')).enrolledCount === 1, '名額釋放後由候補補上（=1）');
  }

  await reset();
  section('E13 插班計費：完課過半→照比例計費（ratio=0.5）');
  {
    await seedCourse('C1', { price: 8000, totalSessions: 8 });
    // 4 堂已過（date < 目標場次），目標場次在未來
    for (let i = 0; i < 4; i++) await seedSession(`P${i}`, { courseId: 'C1', date: dstr(dayjs().subtract(20 - i, 'day')) });
    await seedSession('S1', { courseId: 'C1', maxStudents: 5, date: dstr(dayjs().add(10, 'day')) });
    const r = await course.enrollCourse({ memberId: 'A', sessionId: 'S1', gymId: 'gym-hsinchu', staffId: 's' });
    ok(r.feeInfo.remaining === 4 && r.feeInfo.fee === 4000,
      '剩 4 堂、費用=8000×0.5=4000', `remaining=${r.feeInfo.remaining} fee=${r.feeInfo.fee}`);
    ok(r.feeInfo.installment === false, '4 堂不分期');
  }

  // ═══════════════ F. 課程分期付款計畫 ═══════════════
  // installmentService：建計畫→頭款→繳款→逾期→擋入場→補繳→結清
  const mkPlan = (over = {}) => inst.createInstallmentPlan({
    memberId: 'A', memberName: 'A', gymId: 'gym-hsinchu',
    relatedType: 'course', relatedId: 'C1', itemName: '課程C1',
    recognitionDate: dstr(dayjs().add(30, 'day')),
    installments: [
      { amount: 3000, dueDate: dstr(dayjs()) },
      { amount: 3000, dueDate: dstr(dayjs().add(30, 'day')) },
    ],
    firstPaymentMethod: 'cash', staffId: 's', staffName: 'S',
    ...over,
  });

  await reset();
  section('F1 分期建立：頭款自動收、狀態 active、總額＝各期加總');
  {
    const plan = await mkPlan();
    ok(plan.status === 'active', '建立後 status=active', `實際=${plan.status}`);
    ok(plan.totalAmount === 6000, '總額＝各期加總（6000）', `實際=${plan.totalAmount}`);
    ok(plan.installments[0].status === 'paid' && plan.installments[0].paymentMethod === 'cash',
      '第1期簽約頭款自動 paid');
    ok(plan.installments[1].status === 'pending', '第2期 pending');
    ok(plan.recognitionDate === dstr(dayjs().add(30, 'day')), '課程認列日＝最後一堂(recognitionDate)');
    // 頭款進帳一筆 transaction
    const txns = (await db.collection('transactions').get()).docs.map(d => d.data());
    ok(txns.length === 1 && txns[0].type === 'course' && txns[0].totalAmount === 3000,
      '頭款記一筆 course 營收（3000）', `txns=${txns.length}`);
  }

  await reset();
  section('F2 分期繳清：markPaid 最後一期→ allPaid、completed');
  {
    const plan = await mkPlan();
    const r = await inst.markInstallmentPaid({ planId: plan.id, seq: 2, paymentMethod: 'cash', staffId: 's', staffName: 'S' });
    ok(r.allPaid === true, '繳完最後一期 allPaid=true');
    const p = (await inst.getMemberInstallmentPlans('A'))[0];
    ok(p.status === 'completed', '結清後 status=completed', `實際=${p.status}`);
    ok(await inst.hasOverdueInstallment('A') === false, '結清後不擋入場');
  }

  await reset();
  section('F3 逾期：runOverdueCheck 標記過期未繳→ hasOverdueInstallment 擋入場');
  {
    // 第2期到期日在昨天、未繳 → 應被標為逾期
    const plan = await mkPlan({
      installments: [
        { amount: 3000, dueDate: dstr(dayjs().subtract(5, 'day')) },  // 頭款已收
        { amount: 3000, dueDate: dstr(dayjs().subtract(1, 'day')) },  // 已過到期未繳
      ],
    });
    ok(await inst.hasOverdueInstallment('A') === false, '逾期批次前尚未擋入場');
    const r = await inst.runOverdueCheck();
    ok(r.overdueCount === 1, 'runOverdueCheck 標記 1 筆逾期', `實際=${r.overdueCount}`);
    const p = (await inst.getMemberInstallmentPlans('A'))[0];
    ok(p.status === 'overdue', '計畫 status=overdue');
    ok(p.installments.find(i => i.seq === 2).status === 'overdue', '第2期 status=overdue');
    ok(await inst.hasOverdueInstallment('A') === true, '逾期→ hasOverdueInstallment 擋入場');
  }

  await reset();
  section('F4 補繳不解限：仍有他期逾期→維持 overdue；補齊最後一期才結清');
  {
    const plan = await mkPlan({
      installments: [
        { amount: 2000, dueDate: dstr(dayjs().subtract(5, 'day')) },  // 頭款已收
        { amount: 2000, dueDate: dstr(dayjs().subtract(3, 'day')) },  // 逾期
        { amount: 2000, dueDate: dstr(dayjs().subtract(1, 'day')) },  // 逾期
      ],
    });
    await inst.runOverdueCheck();
    const r2 = await inst.markInstallmentPaid({ planId: plan.id, seq: 2, paymentMethod: 'cash', staffId: 's' });
    ok(r2.allPaid === false, '補繳第2期後尚未全清');
    let p = (await inst.getMemberInstallmentPlans('A'))[0];
    ok(p.status === 'overdue', '仍有第3期逾期→計畫維持 overdue（補一期不解限）');
    ok(await inst.hasOverdueInstallment('A') === true, '補一期未解除入場限制');
    await inst.markInstallmentPaid({ planId: plan.id, seq: 3, paymentMethod: 'cash', staffId: 's' });
    p = (await inst.getMemberInstallmentPlans('A'))[0];
    ok(p.status === 'completed', '補齊最後一期→ completed');
    ok(await inst.hasOverdueInstallment('A') === false, '全繳清後解除入場限制');
  }

  await reset();
  section('F5 分期驗證：期數/金額/重複繳/付款方式');
  {
    const one = await expectThrow(() => mkPlan({ installments: [{ amount: 6000, dueDate: dstr(dayjs()) }] }));
    ok(one.threw && one.code === 'INVALID_INSTALLMENTS', '單期被擋（請走一般付款）', `code=${one.code}`);
    const bad = await expectThrow(() => mkPlan({ installments: [{ amount: 0, dueDate: dstr(dayjs()) }, { amount: 3000, dueDate: dstr(dayjs()) }] }));
    ok(bad.threw && bad.code === 'INVALID_AMOUNT', '每期金額須 >0');
    const plan = await mkPlan();
    const dup = await expectThrow(() => inst.markInstallmentPaid({ planId: plan.id, seq: 1, paymentMethod: 'cash', staffId: 's' }));
    ok(dup.threw && dup.code === 'ALREADY_PAID', '已繳期數不可重複繳');
    const pm = await expectThrow(() => inst.markInstallmentPaid({ planId: plan.id, seq: 2, paymentMethod: 'bitcoin', staffId: 's' }));
    ok(pm.threw && pm.code === 'INVALID_PAYMENT_METHOD', '非法付款方式被擋');
  }

  section('F6 buildPeriodsFromConfig：比例拆分、末期吸收餘數、到期日、單期回 null');
  {
    const periods = inst.buildPeriodsFromConfig(
      { enabled: true, periods: [{ percent: 30, dueOffsetDays: 0 }, { percent: 30, dueOffsetDays: 30 }, { percent: 40, dueOffsetDays: 60 }] },
      5000, '2026-07-04');
    ok(periods.length === 3, '產出 3 期');
    ok(periods.reduce((s, p) => s + p.amount, 0) === 5000, '各期合計＝總額（末期吸收餘數）',
      `實際=${periods.map(p => p.amount).join('+')}`);
    ok(periods[0].amount === 1500 && periods[2].amount === 2000, '30%/30%/40%→1500/1500/2000');
    ok(periods[0].dueDate === '2026-07-04' && periods[2].dueDate === '2026-09-02', '到期日＝起始日+offset');
    ok(inst.buildPeriodsFromConfig({ enabled: true, periods: [{ percent: 100, dueOffsetDays: 0 }] }, 5000, '2026-07-04') === null,
      '少於2期→回 null（走一般付款）');
    ok(inst.buildPeriodsFromConfig({ enabled: true, periods: [{ percent: 50 }, { percent: 50 }] }, 0, '2026-07-04') === null,
      '總額為0→回 null');
  }

  // ── 總結 ──
  console.log(`\n──────── 結果：${pass} 通過 / ${fail} 失敗 ────────`);
  if (fails.length) { console.log('失敗項目：'); fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
