/**
 * 員工練習用測試會員 seed
 * 建立涵蓋各身分別/狀態的測試會員（名稱一律「【練習】」前綴、電話 090090xxxx 保留段），
 * 直接寫 members + 關聯集合（waivers / fallTests / memberPasses / legacyBlackCards /
 * discountBonuses / discountCards / singleEntryTickets / vipMembers / fallTestSignatures），
 * 讓這些會員在員工端「以電話搜尋入場」流程真的能跑通對應情境。
 *
 * 場館固定 gym-hsinchu（新竹館）。所有欄位對齊 checkinService 的資格判定（實測欄位）。
 *
 * 用法：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/seedTestMembers.js
 *   寫入：...同上... --commit         （會先清掉舊的【練習】測試會員再重建，可重複執行）
 *   只清：...同上... --clean          （只刪除【練習】測試會員與其關聯資料）
 */
const { v4: uuidv4 } = require('uuid');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const CLEAN_ONLY = args.includes('--clean');
const GYM = 'gym-hsinchu';
const PREFIX = '【練習】';

// ── 日期工具（台灣時區）──
const dstr = (offDays) => new Date(Date.now() + 8 * 3600000 + offDays * 86400000).toISOString().slice(0, 10);
const dobj = (offDays) => new Date(Date.now() + offDays * 86400000);
const today = dstr(0), FUTURE_1Y = dstr(365), FUTURE_6M = dstr(180), PAST_EXPIRED = dstr(-30);

// ── 會員定義（builder 產生 member doc + 關聯 docs）──
let seq = 0;
const phone = () => '09009' + String(100 + (++seq)).padStart(5, '0').slice(-5); // 0900910001 起
const rel = [];     // 關聯 docs：{ col, id, data }
const members = [];  // member docs
const notes = [];    // 情境說明（給練習手冊）

function baseMember(name, extra = {}) {
  const id = uuidv4();
  const ph = extra.phone || phone();
  const m = {
    id, name: PREFIX + name, phone: ph, email: null,
    birthday: extra.birthday || '1995-06-15', gender: extra.gender || 'male',
    emergencyContact: null, qrCode: null, qrCodeId: 'RR-PRAC' + String(seq).padStart(3, '0'),
    isMinor: !!extra.isMinor, isChildAccount: !!extra.isChildAccount,
    parentMemberId: extra.parentMemberId || null, memberType: extra.memberType || 'general',
    registeredBy: 'staff', emailVerified: true, isBlocked: !!extra.isBlocked,
    blockReasons: extra.blockReasons || [], notes: '員工練習測試帳號，可安全刪除',
    isTeamMember: !!extra.isTeamMember,
    ...(extra.isTeamMember ? { teamMemberSince: dstr(-30), teamMemberUntil: FUTURE_1Y, teamMemberSetBy: 'seed', teamMemberSetAt: dobj(0) } : {}),
    createdAt: dobj(0), updatedAt: dobj(0),
  };
  members.push(m);
  return m;
}
function addWaiver(m, complete = true) {
  rel.push({ col: 'waivers', id: m.id, data: {
    memberId: m.id, memberName: m.name, isComplete: complete,
    memberSignedAt: dobj(-10), memberSignedBy: 'seed', parentRequired: false,
    source: 'new', createdAt: dobj(-10),
  }});
}
function addFallTest(m, state) { // 'valid' | 'expired'
  rel.push({ col: 'fallTests', id: uuidv4(), data: {
    memberId: m.id, gymId: GYM, result: 'passed',
    testedAt: dobj(state === 'expired' ? -400 : -30),
    currentExpiresAt: state === 'expired' ? PAST_EXPIRED : FUTURE_1Y,
    extensionCount: 0, confirmedBy: 'seed', source: 'new', createdAt: dobj(-30),
  }});
}
function addFallTestSignature(m) {
  rel.push({ col: 'fallTestSignatures', id: uuidv4(), data: { memberId: m.id, signedAt: dobj(-1), source: 'seed' } });
}
// 大多數會員：已簽 waiver + 墜測有效（可入場的基本條件）
function ready(m) { addWaiver(m, true); addFallTest(m, 'valid'); return m; }

// ═══════════ 各身分別 ═══════════

// 1. 一般會員（資格完整、無票券）→ 現場購票單次入場
{ const m = ready(baseMember('王小明一般'));
  notes.push([m.name, m.phone, '一般會員（可入場、無票券）', '電話搜尋→無免費資格→選「單次入場」+付款方式→確認入場']); }

// 2. 未簽 waiver → 入場被擋
{ const m = baseMember('陳美麗未簽', { isBlocked: true, blockReasons: ['waiver_unsigned'] });
  addFallTest(m, 'valid'); // 有墜測但沒 waiver
  notes.push([m.name, m.phone, '未簽免責同意書', '電話搜尋→系統紅字擋「需簽署 Waiver」，無法入場（練習：引導會員先簽）']); }

// 3. 墜測逾期 → 擋
{ const m = baseMember('林志明墜測過期'); addWaiver(m, true); addFallTest(m, 'expired');
  notes.push([m.name, m.phone, '墜落測驗已逾期', '電話搜尋→紅字擋「墜測已逾期」，無法入場（練習：安排重測）']); }

// 4. 墜測未測 → 擋
{ const m = baseMember('張家豪未墜測'); addWaiver(m, true); // 無 fallTest
  notes.push([m.name, m.phone, '尚未做墜落測驗', '電話搜尋→紅字擋「需完成墜落測驗」，無法入場']); }

// 5. 定期票（月票，全館通用，有效）→ 免費入場
{ const m = ready(baseMember('李定期月票'));
  rel.push({ col: 'memberPasses', id: uuidv4(), data: {
    memberId: m.id, gymId: GYM, passTypeId: 'seed-monthly', passTypeName: '月票',
    scope: 'shared', startDate: dstr(-10), endDate: FUTURE_1Y, status: 'active',
    credits: null, createdAt: dobj(0), updatedAt: dobj(0) }});
  notes.push([m.name, m.phone, '持有效定期票（月票）', '電話搜尋→顯示「持有效定期票，免費入場」→確認入場（不扣款）']); }

// 6. 黑卡（剩餘 8 次）→ 確認才扣次
{ const m = ready(baseMember('黑卡王'));
  rel.push({ col: 'legacyBlackCards', id: uuidv4(), data: {
    memberId: m.id, remainingCredits: 8, originalCredits: 12, expiresAt: null,
    isActive: true, source: 'original', transferHistory: [], createdAt: dobj(0) }});
  notes.push([m.name, m.phone, '持黑卡（剩 8 次）', '電話搜尋→選「黑卡」入場→確認才扣 1 次（剩 7）；可練習取消入場回補次數']); }

// 7. 紅利（1 張未用）→ 免費入場
{ const m = ready(baseMember('紅利妹'));
  rel.push({ col: 'discountBonuses', id: uuidv4(), data: {
    ownerMemberId: m.id, originalOwnerMemberId: m.id, sourceType: 'discount_card',
    isUsed: false, isActive: true, expiresAt: dobj(180), validityMonths: 6, createdAt: dobj(0) }});
  notes.push([m.name, m.phone, '持紅利（免費入場 1 次）', '電話搜尋→選「紅利」→確認才用掉；用完後不再出現']); }

// 8. 優惠卡 8 折（剩餘次數）
{ const m = ready(baseMember('折扣卡姊'));
  rel.push({ col: 'discountCards', id: uuidv4(), data: {
    ownerMemberId: m.id, originalOwnerMemberId: m.id, purchasePrice: 1600,
    originalCredits: 10, remainingCredits: 6, totalIssuedCredits: 10, totalUsedCredits: 4,
    bonusTriggered: false, source: 'new', transferHistory: [], expiresAt: dobj(180),
    purchasedAt: dobj(-30), gymId: GYM, isActive: true, createdAt: dobj(-30), updatedAt: dobj(0) }});
  notes.push([m.name, m.phone, '持優惠卡（8 折，剩 6 次）', '電話搜尋→選「優惠券 8 折」→原價×0.8 收款→確認才扣次']); }

// 9. 單次入場券（一般，未指定日期）
{ const m = ready(baseMember('券券子'));
  rel.push({ col: 'singleEntryTickets', id: uuidv4(), data: {
    memberId: m.id, originalMemberId: m.id, gymId: GYM, ticketType: 'standard',
    issuedAt: today, expiresAt: FUTURE_1Y, validDate: null, status: 'active',
    usedAt: null, usedCheckInId: null, createdAt: dobj(0), updatedAt: dobj(0) }});
  notes.push([m.name, m.phone, '持單次入場券', '電話搜尋→選「單次入場券」免費入場→確認才標記已用']); }

// 10. VIP → 永久免費
{ const m = ready(baseMember('VIP尊爵'));
  rel.push({ col: 'vipMembers', id: uuidv4(), data: {
    memberId: m.id, memberName: m.name, note: '練習測試 VIP', createdBy: 'seed',
    createdAt: dobj(0), updatedAt: dobj(0) }});
  notes.push([m.name, m.phone, 'VIP 會員', '電話搜尋→顯示「👑 VIP 免費入場」→直接確認']); }

// 11. 攀岩隊員（有效）→ 入場/銷售 9 折
{ const m = ready(baseMember('隊員阿凱', { isTeamMember: true }));
  notes.push([m.name, m.phone, '攀岩隊員（9 折）', '入場顯示「隊員 9 折」；到「商品銷售」搜尋此會員，購買 ≥100 元商品自動 9 折']); }

// 12. 家長 + 2 名子女（親子共用電話）
{ const parent = ready(baseMember('家長爸爸'));
  const cphone = parent.phone;
  const c1 = baseMember('小孩安安', { phone: cphone, isChildAccount: true, parentMemberId: parent.id, isMinor: true, memberType: 'child', birthday: '2016-03-01' });
  addWaiver(c1, true); addFallTest(c1, 'valid');
  const c2 = baseMember('小孩貝貝', { phone: cphone, isChildAccount: true, parentMemberId: parent.id, isMinor: true, memberType: 'child', birthday: '2018-08-20' });
  addWaiver(c2, true); addFallTest(c2, 'valid');
  notes.push([parent.name + ' + 2 子女', cphone, '親子共用電話', '電話搜尋→家長＋安安＋貝貝三顆按鈕，務必點對入場者本人；子女為兒童入場']); }

// 13. 體驗學員（今日體驗券、墜測未過但可入場）
{ const m = baseMember('體驗生今日'); addWaiver(m, true); addFallTestSignature(m); // 有簽同意書、但無 passed 墜測
  rel.push({ col: 'singleEntryTickets', id: uuidv4(), data: {
    memberId: m.id, originalMemberId: m.id, gymId: GYM, ticketType: 'experience',
    issuedAt: today, expiresAt: FUTURE_1Y, validDate: today, status: 'active',
    usedAt: null, usedCheckInId: null, createdAt: dobj(0), updatedAt: dobj(0) }});
  notes.push([m.name, m.phone, '體驗學員（當日體驗券）', '電話搜尋→持當日體驗券，雖未通過墜測仍可入場（已簽同意書豁免）→確認才用券']); }

// 14. 一般會員（第二位，供銷售/退費/雙人情境）
{ const m = ready(baseMember('周銷售'));
  notes.push([m.name, m.phone, '一般會員（銷售/收款練習用）', '到「商品銷售」搜尋此會員，練習加入購物車、選付款方式、完成銷售、扣庫存']); }

// ═══════════ 清理 + 寫入 ═══════════
(async () => {
  const { initFirebase, getDb } = require('../src/config/firebase');
  initFirebase(); const db = getDb();

  async function cleanExisting() {
    const snap = await db.collection('members').get();
    const ids = [];
    snap.forEach(d => { if ((d.data().name || '').startsWith(PREFIX)) ids.push(d.id); });
    if (!ids.length) { console.log('（無既有【練習】會員可清）'); return 0; }
    let del = 0;
    for (const id of ids) {
      const batch = db.batch();
      batch.delete(db.collection('members').doc(id));
      batch.delete(db.collection('waivers').doc(id));
      for (const col of ['fallTests', 'memberPasses', 'legacyBlackCards', 'singleEntryTickets', 'vipMembers', 'fallTestSignatures']) {
        const s = await db.collection(col).where('memberId', '==', id).get();
        s.forEach(x => batch.delete(x.ref));
      }
      for (const col of ['discountBonuses', 'discountCards']) {
        const s = await db.collection(col).where('ownerMemberId', '==', id).get();
        s.forEach(x => batch.delete(x.ref));
      }
      await batch.commit(); del++;
    }
    console.log(`🧹 已清除 ${del} 位既有【練習】會員及其關聯資料`);
    return del;
  }

  console.log(`\n===== 測試會員 seed ${CLEAN_ONLY ? '【只清理】' : COMMIT ? '【寫入】' : '（預覽）'} =====`);
  if (CLEAN_ONLY) { await cleanExisting(); process.exit(0); }

  console.log(`預計建立 ${members.length} 位會員（含 ${members.filter(m => m.isChildAccount).length} 位子女）＋ ${rel.length} 筆關聯資料，全在新竹館`);
  console.log('\n── 情境清單 ──');
  notes.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n[0]}｜${n[1]}｜${n[2]}`));

  if (!COMMIT) { console.log('\n（預覽模式，未寫入。確認後加 --commit；會先清舊再重建）'); process.exit(0); }

  await cleanExisting();
  for (let i = 0; i < members.length; i += 400) {
    const batch = db.batch();
    members.slice(i, i + 400).forEach(m => batch.set(db.collection('members').doc(m.id), m));
    await batch.commit();
  }
  for (let i = 0; i < rel.length; i += 400) {
    const batch = db.batch();
    rel.slice(i, i + 400).forEach(r => batch.set(db.collection(r.col).doc(r.id), r.data));
    await batch.commit();
  }
  console.log(`\n✅ 已建立 ${members.length} 位測試會員 + ${rel.length} 筆關聯資料`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
