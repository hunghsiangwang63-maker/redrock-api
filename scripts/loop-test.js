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
 */
const path = require('path');
const { v4: uuid } = require('uuid');

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
    where(f, op, val) { return query(name).where(f, op, val); },
    orderBy(f, dir) { return query(name).orderBy(f, dir); },
    limit(n) { return query(name).limit(n); },
    async get() { return query(name).get(); },
  });
  return {
    collection,
    batch() { const ops = []; return { set: () => {}, update: () => {}, async commit() {} }; },
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

// ── 載入真實 service ──
const dcs = require(path.join(SRC, 'services/discountCardService.js'));
const ldcs = require(path.join(SRC, 'services/legacyDiscountCardService.js'));
const lcs = require(path.join(SRC, 'services/legacyCardService.js'));
const bonus = require(path.join(SRC, 'services/bonusService.js'));
const checkin = require(path.join(SRC, 'services/checkinService.js'));
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

  // ── 總結 ──
  console.log(`\n──────── 結果：${pass} 通過 / ${fail} 失敗 ────────`);
  if (fails.length) { console.log('失敗項目：'); fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
