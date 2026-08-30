/**
 * 單日結帳路由
 * GET  /daily-settlements/today          取得今日結帳資料（自動帶入）
 * POST /daily-settlements                建立結帳
 * GET  /daily-settlements                查詢結帳紀錄
 * PUT  /daily-settlements/:id/unlock     管理員解鎖重新結帳
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const { authenticate, checkPermission, requireStationAuth, requireManager } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

// ── 偶數月最後一個營業日提醒（換發票本／設定下一期發票號碼）──────────────────
// 判斷：今天是偶數月 && 今天有營業 && 「明天到月底」都沒有營業日（=今天是這個月最後一次結帳機會）。
// 只在偶數月且距月底 ≤6 天時才展開逐日查詢（getGymStatusForDate 內部各查一次 Firestore），
// 平時（奇數月、或偶數月但離月底還遠）直接短路回 false，不產生額外查詢成本。
async function checkInvoiceRolloverDue(gymId, todayStr) {
  const d = dayjs(todayStr);
  if ((d.month() + 1) % 2 !== 0) return false; // 僅偶數月（月底提醒下一期＝奇數月開始）
  const daysInMonth = d.daysInMonth();
  const dayOfMonth = d.date();
  if (daysInMonth - dayOfMonth > 6) return false; // 離月底還遠，不可能是最後營業日
  const { getGymStatusForDate } = require('./gyms');
  const todayStatus = await getGymStatusForDate(gymId, todayStr);
  if (!todayStatus.isOpen) return false; // 今天本身沒營業，不算「最後一個營業日」
  for (let dd = dayOfMonth + 1; dd <= daysInMonth; dd++) {
    const st = await getGymStatusForDate(gymId, d.date(dd).format('YYYY-MM-DD'));
    if (st.isOpen) return false; // 後面還有營業日
  }
  return true;
}

// ── 入場費六分類（結帳摘要 GET /today 與月銷售 Excel monthly-export 共用）──────────
// 折扣為 checkIn 旗標（隊員 isTeamDiscount、優惠券＝舊折扣卡 legacyDiscount 或優惠折扣券卡
// discount_card 入場），疊加另拆「隊員＋優惠券」；無折扣才依原入場類型（成人/學生/兒童/…）。
const ENTRY_LABEL = { single_ticket:'成人', single_entry_ticket:'單次入場券', pass:'定期票', competition: '比賽報到', buy_pass:'購買定期票', buy_discount_card:'購買優惠折扣券', vip:'VIP', course_access:'課程學員', discount_card:'優惠折扣券', black_card:'黑卡', child_free:'兒童', student_free:'學生', bonus:'紅利', experience:'體驗' };
const ENTRY_ORDER = ['成人', '學生', '兒童', '成人使用優惠券', '學生使用優惠券', '隊員折扣', '隊員＋優惠券'];
const entryCategory = (data) => {
  const team = data.isTeamDiscount === true;
  const coupon = data.legacyDiscount === true || data.entryType === 'discount_card';
  if (team && coupon) return '隊員＋優惠券';
  if (team) return '隊員折扣';
  // 優惠券依基礎身分拆（舊折扣卡8折看 entryType 本身即為 student_free；優惠折扣券入場 entryType
  // 固定是 discount_card、真正身分存在 baseEntryType，兩者都要檢查才不會把學生誤歸成人）
  if (coupon) return (data.entryType === 'student_free' || data.baseEntryType === 'student_free') ? '學生使用優惠券' : '成人使用優惠券';

  return ENTRY_LABEL[data.entryType] || data.entryType || '其他入場';
};
const entryOrderSort = (a, b) => {
  const ia = ENTRY_ORDER.indexOf(a), ib = ENTRY_ORDER.indexOf(b);
  return ((ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)) || String(a).localeCompare(String(b));
};

// ── 線上預付單次入場券的入場費/租借費還原（2026-08-23，真實案例：街口 pay-first 入場）──────────
// 會員線上付款（entry orderType，見 paymentService.js）當下就已經把入場費＋租借費一次收清、記進
// singleEntryTickets 這張票；之後會員用這張票 redeem（產生 QR→掃碼→確認入場）走的是「免費入場」
// 分支，該次 checkIn 的 amountPaid/entryFee/shoesPrice/chalkPrice 全部是 0（錢不是這次收的）。
// 若不還原，入場費/租借費統計（結帳今日收入六分類、月銷售 Excel）看不到這筆早就收過的真實收入，
// 整筆從報表消失。orderResolvers.entry 現已擴及 buy_discount_card/buy_pass/discount_card
// （購買或使用優惠折扣券、購買定期票），下方 resolveEntryRental 依 ticket.baseEntryType /
// usesDiscountCardId 各自還原正確分類（購買優惠折扣券/購買定期票/成人・學生使用優惠券），
// 尚不含隊員折扣（線上付款目前不記 isTeamDiscount 到票上，與現場既有的同一項限制一致）。
const resolveOnlineTicketMap = async (db, checkinDataList) => {
  const ticketIds = [...new Set(checkinDataList
    .filter(c => c.entryType === 'single_entry_ticket' && c.singleEntryTicketId)
    .map(c => c.singleEntryTicketId))];
  const map = {};
  if (!ticketIds.length) return map;
  const docs = await db.getAll(...ticketIds.map(id => db.collection('singleEntryTickets').doc(id)));
  docs.forEach(d => { if (d.exists) map[d.id] = d.data(); });
  return map;
};
// 給定一筆 checkIn（onlineTicketMap 由上面批次查好）：命中「線上付款且金額>0」的票券才還原真實
// 金額/分類，其餘（一般現金/現場付款/免費贈券等）維持原本 checkIn 欄位計算，行為不變。
const resolveEntryRental = (data, onlineTicketMap) => {
  const ticket = data.singleEntryTicketId ? onlineTicketMap[data.singleEntryTicketId] : null;
  if (ticket && ticket.paymentMethod && ticket.paymentMethod !== 'cash' && Number(ticket.amount) > 0) {
    const rentalAmt = (ticket.rentShoes ? 100 : 0) + (ticket.rentChalk ? 50 : 0);
    const entryAmt = Math.max(0, Number(ticket.amount) - rentalAmt);
    // 2026-08-27：使用（已持有的）優惠折扣券——ticket.baseEntryType 恆為頂層 'discount_card'
    // （供追蹤用、非身分），改走 entryCategory() 同一套 coupon 分類邏輯（成人/學生使用優惠券），
    // 與現場（非線上）discount_card 入場分類一致；真正身分存在 discountCardBaseEntryType。
    const cat = ticket.usesDiscountCardId
      ? entryCategory({ entryType: 'discount_card', baseEntryType: ticket.discountCardBaseEntryType })
      : (ENTRY_LABEL[ticket.baseEntryType] || ticket.baseEntryType || '其他入場');
    return { entryAmt, rentalAmt, cat, paymentMethod: ticket.paymentMethod };
  }
  const rentalAmt = (data.shoesPrice || 0) + (data.chalkPrice || 0);
  const entryAmt = Math.max(0, (data.amountPaid || 0) - rentalAmt);
  return { entryAmt, rentalAmt, cat: entryCategory(data), paymentMethod: data.paymentMethod };
};

// ── 轉換期手動輸入「發票總金額」計算（與前端 DailySettlementPage.jsx 的同名函式逐字對齊，
//    勿只改一邊——這是「現金」推算的權威來源，後端獨立算一次、不信任前端傳來的手動現金值）──
const ENTRY_CATS = ['成人', '學生', '兒童', '成人使用優惠券', '學生使用優惠券', '隊員折扣', '隊員＋優惠券'];
const sysEntryVal = (income, cat) => (income?.entryItems || []).find(x => x.label === cat)?.value || 0;
const entryCatList = (income) => {
  const extra = (income?.entryItems || []).map(x => x.label).filter(l => l && !ENTRY_CATS.includes(l));
  return [...ENTRY_CATS, ...extra];
};
const manEntryVal = (im, cat) => im?.entryItems?.[cat];
const entryManualTotal = (income, im) => {
  if (im?.entryItems && typeof im.entryItems === 'object') {
    return entryCatList(income).reduce((s, cat) => {
      const m = manEntryVal(im, cat);
      return s + ((m !== '' && m != null) ? (Number(m) || 0) : sysEntryVal(income, cat));
    }, 0);
  }
  return (im?.entry !== '' && im?.entry != null) ? (Number(im.entry) || 0) : (income?.entry || 0);
};
const manualIncomeTotal = (income, im) => im
  ? entryManualTotal(income, im) + ['shoeRental', 'equipmentRental', 'product', 'course', 'pass', 'competition']
      .reduce((s, k) => s + ((im[k] !== '' && im[k] != null) ? (Number(im[k]) || 0) : (income?.[k] || 0)), 0)
  : null;

// ── 真列印權威資料（該館開啟「發票列印」後，今日收入/發票起訖/作廢一律由 invoices 集合權威決定，
//    不再手動輸入、也不信任前端送來的值——比照加減項鎖定原則，見 findRemovedOrAlteredAutoDeductions）──
// 由 GET /today（顯示用）與 POST /（結帳權威計算+持久化）共用同一份查詢與分段邏輯，避免各自維護一份。
// 依字軌分段（同日內若因換捲換字軌，依出現順序拆成多段，對齊既有 invoiceSegments 多段 UI 概念）；
// 作廢號碼/作廢總金額直接取 invoices 的 status:'void' 紀錄，不再由店員手動輸入。
async function computeTodayInvoiceAuthority(db, gymId, todayStart, todayEnd) {
  const result = { printingEnabled: false, segments: [], voidNumbers: [], voidTotalAmount: 0, actualTotal: 0, count: 0, voidCount: 0, bySourceType: {}, amountModifiedList: [], noSourceByMethod: {}, byMethod: {} };
  try {
    const gymDoc = await db.collection('gyms').doc(gymId).get();
    result.printingEnabled = !!(gymDoc.exists && gymDoc.data().invoicePrintingEnabled === true);
    if (!result.printingEnabled) return result;
    const invSnap = await db.collection('invoices').where('gymId', '==', gymId).get();
    const tsOf = (v) => v?.toDate ? v.toDate().getTime() : ((v?._seconds || 0) * 1000);
    const todayInvoices = invSnap.docs
      .map(d => d.data())
      .filter(inv => { const t = tsOf(inv.issuedAt); return t >= todayStart.getTime() && t <= todayEnd.getTime(); })
      .sort((a, b) => tsOf(a.issuedAt) - tsOf(b.issuedAt));
    if (!todayInvoices.length) return result;
    // 依字軌分組，組內再依號碼排序找出連續區段——號碼不連續就視為換過捲，即使字軌相同也拆成新一段
    // （同字軌換捲很常見：字軌不見得每次換捲都會變，若純粹「同字軌合併成一段、取最小~最大號」，
    // 換捲造成的號碼斷層會被誤呈現成「這中間全部印過」，對發票號碼這種要對稅務/會計交代的紀錄不精確）。
    // 段落間的顯示順序依該段最早列印時間排序，反映當天實際使用先後。
    const byTrack = new Map(); // track -> invoices[]
    todayInvoices.forEach(inv => {
      const trk = inv.track || '';
      if (!byTrack.has(trk)) byTrack.set(trk, []);
      byTrack.get(trk).push(inv);
    });
    const segments = [];
    byTrack.forEach((invs, trk) => {
      const sorted = [...invs].sort((a, b) => Number(a.number) - Number(b.number));
      let seg = null;
      sorted.forEach(inv => {
        const num = Number(inv.number);
        const ts = tsOf(inv.issuedAt);
        if (seg && num === seg.lastNum + 1) {
          seg.last = inv.number; seg.lastNum = num;
          seg.firstTs = Math.min(seg.firstTs, ts);
        } else {
          seg = { track: trk, start: inv.number, last: inv.number, lastNum: num, firstTs: ts };
          segments.push(seg);
        }
      });
    });
    segments.sort((a, b) => a.firstTs - b.firstTs);
    result.segments = segments.map(({ track, start, last }) => ({ track, start, last }));
    const voids = todayInvoices.filter(i => i.status === 'void');
    result.voidNumbers = voids.map(i => (i.track ? `${i.track}-${i.number}` : i.number));
    result.voidTotalAmount = voids.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const issued = todayInvoices.filter(i => i.status === 'issued');
    result.actualTotal = issued.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    result.count = issued.length;
    result.voidCount = voids.length;
    // 依 sourceType 分組的今日已開立發票總額（供「以開立發票為準」的個別分類覆寫，如課程收入——
    // 課程/比賽發票延後開立(見 checkInvoiceIssuanceTiming)，實際列印日常晚於服務認列日，此分組讓
    // 對應分類可改用「今天實際印了多少」而非「今天認列多少」）
    issued.forEach(i => {
      const st = i.sourceType || '_unknown';
      result.bySourceType[st] = (result.bySourceType[st] || 0) + (Number(i.amount) || 0);
    });
    // 「無來源手動發票」（sourceType 為空，見 SettingsPage 手動開立發票）依付款方式分組——供 GET /today
    // 併入 payByMethod（2026-08-15 新增，見 invoices.js print-record 同一批改動的說明）：這類發票的
    // 金額本就已算進上面 result.actualTotal（供 effectiveCash＝發票總金額－線上支付合計 使用），若付款
    // 方式是 LinePay/街口/台灣Pay/轉帳，要讓「線上支付合計」也正確吃到這筆，才不會被誤算成現金。
    // paymentMethod 是 2026-08-15 才開始存的新欄位，這之前印的無來源發票沒有這欄，一律當現金（fallback
    // 'cash'——維持這批修正之前「現金才特別處理、其餘都無感」的舊行為，不會讓歷史資料無故被歸類成
    // 某個電子支付方式）。
    issued.filter(i => !i.sourceType).forEach(i => {
      const m = i.paymentMethod || 'cash';
      result.noSourceByMethod[m] = (result.noSourceByMethod[m] || 0) + (Number(i.amount) || 0);
    });
    // 2026-08-22：發票開立日（issuedAt）與課程/體驗營收認列日（recognitionDate，通常＝最後一堂課）
    // 是兩個不同的日期基準——真實案例：新竹某日補記一批課程舊生名單認領交易，recognitionDate 落在
    // 當天，但這些課程的發票是「更早的某一天」才開立的（課程/比賽發票延後開立，開立日常晚於服務認列
    // 日，也可能相反、提早開立但服務認列在未來），導致當日結帳「發票總金額－依 recognitionDate 統計
    // 的線上支付合計」兩者其實統計的不是同一批事件，算出的現金落差可能是幾千甚至上萬元的計算假象而非
    // 真的現金短少。改為：真列印館別的付款方式統計全面依「今天開立的發票」為準（依 paymentMethod
    // 分組，涵蓋所有 sourceType，不限無來源發票），與 income 的課程/體驗收入（已於上方改依發票金額）
    // 使用同一個日期基準、同一批事件，兩者才會互相一致。定期票(pass)購買目前無對應真列印發票，此類
    // 收入的付款方式統計仍只能沿用 transactions(recognitionDate) 這條路（見 GET /today 呼叫端）。
    issued.forEach(i => {
      const m = i.paymentMethod || 'cash';
      result.byMethod[m] = (result.byMethod[m] || 0) + (Number(i.amount) || 0);
    });
    // ── 預收款（延後開立發票代表的舊款）併入「其他」（2026-08-27 拍板：轉帳金額維持不動，
    //    現金/LinePay/街口/台灣Pay 補開的舊款改歸「其他」，不獨立一項）────────────────────────
    // 課程/體驗/比賽發票延後開立（見 checkInvoiceIssuanceTiming）——底層報名/預約當初實際收款的那
    // 天，早就已經在那天結算過了；但因為發票是「今天」才補印，上面的 byMethod 會把這筆錢當成「今天
    // 收的」再算一次。現金部分會讓今天的應有現金餘額被灌水（今天抽屜裡本來就不會有這筆錢，點鈔對
    // 不起來是預期中的事、不是現金短少）；LinePay/街口/台灣Pay 部分若拿系統數字去對當日的商家後台
    // 對帳單，一樣會兜不起來（那筆錢商家後台記在真正收款那天，不是今天）。轉帳刻意排除在外——
    // 使用者拍板轉帳金額維持原樣顯示，不做這層排除。
    // 真實案例：新竹某日補印一筆體驗課程發票(現金NT$1,400，實際收款於3個月前)＋兩筆比賽報名發票
    // (現金各NT$721，實際收款於一個月前)，導致當天現金差異從真正的-420被灌到-3,262；另一天補印一筆
    // 體驗課程發票(LinePay NT$2,600，實際收款於3週前)，導致當天 LinePay 總額與商家後台對不起來。
    const moveToOther = (i) => {
      const amt = Number(i.amount) || 0;
      const m = i.paymentMethod || 'cash';
      result.byMethod[m] = (result.byMethod[m] || 0) - amt;
      result.byMethod.other = (result.byMethod.other || 0) + amt;
    };
    // 課程/比賽：一律視為預收款、「無條件」歸「其他」（2026-08-27 再拍板，取代原本「底層記錄建立日
    // ≠ 今天才移」的日期判斷）——這兩類的臨櫃現金在「收款確認當下」就已寫過一筆「+現金補入」加減項
    // （transfers.js / competitions.js confirm，2.77.0 起一律如此），抽屜現金由那筆加減項唯一負責；
    // 發票日的付款方式若還留在 cash，同日「報名+收現+開票」的情境會與加減項重複計算（原日期判斷會
    // 誤認為「今天收的」而保留在 cash）。開票當天也不再另寫沖銷加減項（原 invoices.js print-record 的
    // 「－現金補入沖銷」已一併移除——不同日情境下它與這裡的移出 cash 疊加，反而讓應有現金被雙重扣除）。
    issued.filter(i => i.paymentMethod !== 'transfer' && ['course', 'competition'].includes(i.sourceType)).forEach(moveToOther);
    // 體驗：維持「底層預約建立日 ≠ 今天才移」的日期判斷——體驗現金沒有收款當日寫加減項的機制
    // （2.77.0 只涵蓋課程/比賽/入隊），同日收現+開票時發票的 cash 是這筆錢唯一被計入現金的地方，
    // 無條件移出會讓當天抽屜現金少算。查無底層記錄或缺時間戳時保守視為「就是當天」（不誤標）。
    const prepaidCandidates = issued.filter(i => i.refId && i.paymentMethod !== 'transfer' && i.sourceType === 'experience');
    if (prepaidCandidates.length) {
      const ids = [...new Set(prepaidCandidates.map(i => i.refId))];
      const recordMap = {};
      const docs = await db.getAll(...ids.map(id => db.collection('experienceBookings').doc(id)));
      docs.forEach(d => { if (d.exists) recordMap[d.id] = d.data(); });
      const todayStr = dayjs(todayStart).format('YYYY-MM-DD');
      prepaidCandidates.forEach(i => {
        const rec = recordMap[i.refId];
        if (!rec) return;
        const createdTs = tsOf(rec.registeredAt) || tsOf(rec.createdAt);
        if (!createdTs) return;
        if (dayjs(createdTs).format('YYYY-MM-DD') !== todayStr) moveToOther(i);
      });
    }
    // 列印當下金額被人工改過（見 invoices.js /print-record 的 amountModified 判斷）的清單——
    // 讓結帳頁自動看得到這類異動、不用另外去翻發票紀錄；備註在列印當下已強制必填。
    result.amountModifiedList = issued.filter(i => i.amountModified === true).map(i => ({
      invoiceNo: i.invoiceNo, itemName: i.itemName, originalAmount: i.originalAmount ?? null,
      amount: i.amount, note: i.note || '', staffName: i.staffName || '',
    }));
  } catch (e) { console.error('[今日發票權威資料]', e.message); }
  return result;
}

// 已結帳快照的「發票總金額」正確算法（供月銷售/統一發票明細表 Excel 用；供每日結帳頁本身在
// 結帳當下即時算 income.total 用，日後歷史查詢一律讀這裡、不要各自重寫一份）：
// ⚠️ 2026-08-14 修復：printingEnabled 館別原本沿用舊制「income.total－voidInvoiceAmount」公式，
// 但真列印下 voidInvoiceAmount 是「真實作廢發票」的權威加總——大多數作廢是「印錯金額、作廢後
// 重印正確金額」（同一筆交易），income.total 本就只反映正確一次（216），從沒把作廢那筆錯誤金額
// （251）算進去過，再扣一次會低報實收（真實案例：8/13 新竹館 income.total=13646 已是對的，
// 錯誤地扣掉 voidInvoiceAmount=251 後變 13395，短報了 251 元本來就有收到的錢）。printingEnabled
// 館別改直接用 invoiceActualTotal（已開立、未作廢發票的加總，本就正確排除作廢，來源即真實列印
// 紀錄）；未開真列印（尚用店員手動輸入 voidInvoiceAmount 的舊制館別）維持原公式不變。
const invoiceGrandTotal = (s) => s.printingEnabled ? (s.invoiceActualTotal || 0) : ((s.income?.total || 0) - (s.voidInvoiceAmount || 0));

// ── 系統自動記錄的加減項不可人工刪除/修改（2026-08-10 拍板）────────────────────
// 現金補入/發票開立/發票作廢等（settlementService.addCashAdjustment 寫入的 auto:true 項目）代表一筆
// 真實已發生的金流事件——一旦被結帳頁編輯改掉或刪除，那筆事件在帳上就憑空消失，稽核對不上。
// 後端權威把關：儲存前比對既有 doc 的 auto:true 項目，須「原封不動」仍存在於這次提交的陣列中
// （有 id 精確比對 id；舊資料無 id 則退回比對 sign/type/amount/note 內容）。有錯誤只能用另一筆
// 手動加減項沖銷，不能直接改掉/刪掉原始紀錄。
const AUTO_DEDUCTION_LOCKED_MESSAGE = (d) =>
  `系統自動記錄的加減項（${d.type} ${d.sign === '+' ? '+' : '-'}NT$${d.amount}）不可被刪除或修改，如有錯誤請新增另一筆手動加減項沖銷`;
function findRemovedOrAlteredAutoDeductions(existingDeductions, submittedDeductions) {
  const existingAuto = (existingDeductions || []).filter(x => x.auto === true);
  if (!existingAuto.length) return null;
  const submitted = submittedDeductions || [];
  for (const ex of existingAuto) {
    const stillPresent = submitted.some(sub => (
      sub.auto === true &&
      sub.sign === ex.sign && sub.type === ex.type &&
      Number(sub.amount) === Number(ex.amount) && (sub.note || '') === (ex.note || '') &&
      (ex.id ? sub.id === ex.id : true)
    ));
    if (!stillPresent) return AUTO_DEDUCTION_LOCKED_MESSAGE(ex);
  }
  return null;
}

// ── GET /daily-settlements/today ─────────────────────────────────
router.get('/today', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    // 查今日 gym+date 的結帳 doc（同一 doc 承載 draft / settled）
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '==', today)
      .limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    // 已正式結帳 → 不再 early return：往下照算「即時收入」，最後連同快照一起回傳
    // （否則「當日再次結帳」預填的是結帳當下舊快照，之後新入帳的交易永遠帶不進來）

    // 取前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId)
      .where('date', '<', today)
      .orderBy('date', 'desc')
      .limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);
    // 發票起始號＝前一天結算的最後一張發票號碼 +1（前端可手動修改）
    const prevInvoiceLast = prevSnap.empty ? '' : String(prevSnap.docs[0].data().invoiceLastNumber || '');
    const suggestedInvoiceStart = /^\d+$/.test(prevInvoiceLast)
      ? String(Number(prevInvoiceLast) + 1).padStart(prevInvoiceLast.length, '0')
      : '';
    // 字軌同樣延續前一天最後一段的字軌（換發票本才需要手動改）；舊資料（尚無 invoiceSegments）留空
    const prevSegs = prevSnap.empty ? [] : (prevSnap.docs[0].data().invoiceSegments || []);
    const suggestedInvoiceTrack = prevSegs.length ? String(prevSegs[prevSegs.length - 1].track || '') : '';

    // 統計今日五大類收入
    const todayStart = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();

    // 該館若已開啟「發票列印」（真列印上線）→ 今日收入/發票起訖/作廢一律由 invoices 集合權威帶入
    // （見上方 computeTodayInvoiceAuthority）；未開啟則沿用原本「前一天+1」手動建議 fallback。
    const invAuth = await computeTodayInvoiceAuthority(db, gymId, todayStart, todayEnd);

    // 入場收入（用isCancelled而非status，才能同時涵蓋QR入場與電話入場）
    const checkinSnap = await db.collection('checkIns')
      .where('gymId', '==', gymId)
      .where('isCancelled', '==', false)
      .where('checkedInAt', '>=', todayStart)
      .where('checkedInAt', '<=', todayEnd).get();
    // 線上預付單次入場券還原（見模組頂 resolveOnlineTicketMap 說明）——批次一次查完，避免逐筆查詢
    const onlineTicketMap = await resolveOnlineTicketMap(db, checkinSnap.docs.map(d => d.data()));

    let entryIncome = 0, shoeRentalIncome = 0;
    const entryByType = {};   // 入場收入細項（依折扣分類，見模組頂 entryCategory）
    // 各付款方式收款（跨入場/租借/商品/課程/定期票，含轉帳）；免費入場+租借等無付款方式者預設歸現金（櫃檯實收）
    const payByMethod = {};
    const addPay = (method, amt) => { if (amt) { const m = method || 'cash'; payByMethod[m] = (payByMethod[m] || 0) + amt; } };
    const buyPassAmounts = {}; // buyPassTypeId → 票款（入場購定期票一次付清 → 歸「定期票」大項）
    // 2026-08-16：checkIns 只有單一頂層 paymentMethod 欄位，代表「整筆 amountPaid」的付款方式——但若入場後
    // 又補租器材（addRentalToCheckIn）且用不同付款方式，該函式會把整個欄位覆蓋成 addon 的方式，導致混付時
    // 整筆入場（含原本正確的付款方式那部分）被誤記成同一種（真實案例：入場費 linepay+補租現金，卻整筆被結成現金）。
    // 底層 confirmCheckIn／addRentalToCheckIn／/checkin/phone 三處實際上都各自會建立對應的 type:'checkin'
    // transactions（見 flow.js/checkin.js），且每一筆都各自帶正確的 paymentMethod——改成逐筆用這些交易記錄歸類
    // （下方 txnSnap 迴圈），checkinSnap 這裡只記錄「應收總額＋fallback 付款方式」，供交易記錄涵蓋不到時（理論上
    // 不該發生，例如未來新增的付款路徑忘了記交易）補差額用，確保金額不會被漏算，只有「分類」在精確化。
    const checkinFallback = new Map();     // checkInId → { amount, paymentMethod }
    const checkinAccountedFor = new Map(); // checkInId → 已由 type:'checkin' 交易記錄歸類的金額
    checkinSnap.docs.forEach(d => {
      const data = d.data();
      // 連帶岩鞋/粉袋一律歸「出租」、不算入場（不管哪種入場）。checkIn 分開存 shoesPrice/chalkPrice，
      // 直接 租借＝岩鞋+粉袋、入場＝amountPaid−租借（entryFee 對 buy_pass 未存、故不倚賴）——線上預付
      // 票券的這幾個欄位皆為 0（錢已在線上付款當下收取），resolveEntryRental 命中時改用票券真實金額。
      const { entryAmt, rentalAmt, cat, paymentMethod: effPayMethod } = resolveEntryRental(data, onlineTicketMap);
      const amount = entryAmt + rentalAmt;
      shoeRentalIncome += rentalAmt;
      // 真列印館別：付款方式一律改由下方「今日已開立發票」依 paymentMethod 分組取代（見 invAuth.byMethod
      // 合併處），不再倚賴這裡的 checkIns/transactions（recognitionDate 對入場本身雖無影響，但為了讓
      // 整組付款方式統計單一日期基準、好排查，一併統一改走發票）——故不建立 fallback，避免重複計入。
      if (amount && !invAuth.printingEnabled) checkinFallback.set(d.id, { amount, paymentMethod: effPayMethod });
      if (data.entryType === 'buy_pass') {
        // 入場購買定期票：票款歸「定期票」大項（賣票收入統一一處；分期時 entryAmt=0 首期由分期計畫記）
        if (entryAmt > 0) { const k = data.buyPassTypeId || '_unknown'; buyPassAmounts[k] = (buyPassAmounts[k] || 0) + entryAmt; }
        return;
      }
      entryIncome += entryAmt;
      entryByType[cat] = (entryByType[cat] || 0) + entryAmt;
    });

    // 商品銷售
    const salesSnap = await db.collection('productSales')
      .where('gymId', '==', gymId)
      .where('soldAt', '>=', todayStart)
      .where('soldAt', '<=', todayEnd).get();
    let productIncome = 0;
    salesSnap.docs.forEach(d => {
      const data = d.data();
      productIncome += data.totalAmount || 0;
      // 真列印館別：付款方式改由今日已開立發票統計（見下方 invAuth.byMethod 合併），此處只算收入金額
      if (!invAuth.printingEnabled) addPay(data.paymentMethod, data.totalAmount || 0);
    });

    // 課程／定期票收入：統一從 transactions 撈今日已完成交易，再依type分類
    // （改用單一查詢重用既有索引 transactions(gymId, paymentStatus, paidAt)，
    //   避免為 course_enrollment / pass_purchase 各建一個從未被寫入過的舊索引）
    // 改以認列日 recognitionDate 歸帳（課程預收期間不計入；單欄位範圍＋記憶體過濾避索引）
    const txnSnap = await db.collection('transactions')
      .where('recognitionDate', '>=', todayStart)
      .where('recognitionDate', '<=', todayEnd).get();

    let courseIncome = 0;
    let passIncome = 0;
    let equipmentRentalIncome = 0;   // 器材租借租金（/rentals，type:'rental' 交易；不含押金）
    // 比賽報名收入（type:'competition'）——2026-08-26 補：原本此迴圈完全沒有 competition 分支，
    // 比賽報名的認列金額從未被計進任何一項今日收入，但其發票（sourceType:'competition'）付款方式
    // 卻透過下方 invAuth.byMethod 無條件併入 payByMethod，導致「付款方式」比「收入」多算了整批比賽
    // 報名的錢——真實案例：新竹一次補開 31 張舊比賽發票，income.total 完全沒反映這 NT$22,008，
    // 但 payment.transfer 卻已經算進去。獨立一項，比照課程／體驗（真列印館別改用發票金額，見下方
    // invAuth.bySourceType.competition 覆寫）。
    let competitionIncome = 0;
    const passByType = {};   // 定期票收入細項（依票種，從 notes「定期票購買：xxx」取名）
    txnSnap.docs.forEach(d => {
      const data = d.data();
      if (data.paymentStatus !== 'completed' || data.gymId !== gymId) return;
      const amount = data.totalAmount || 0;
      if (data.type === 'rental') {
        equipmentRentalIncome += amount;
        // 真列印館別：付款方式改由今日已開立發票統計（見下方 invAuth.byMethod 合併）
        if (!invAuth.printingEnabled) addPay(data.paymentMethod, amount);
      } else if (data.type === 'competition') {
        competitionIncome += amount;
        // 真列印館別：付款方式改由今日已開立發票統計（見下方 invAuth.byMethod 合併）；比賽 recognitionDate
        // 常落在賽事前一天（可能是未來日期，見 competitionService.recordCompetitionRevenue），非真列印
        // 館別才需要這裡的 fallback。
        if (!invAuth.printingEnabled) addPay(data.paymentMethod, amount);
      } else if (data.type === 'course') {
        courseIncome += amount;
        // 真列印館別：付款方式改由今日已開立發票統計，不再用 recognitionDate 認列日——這正是本次
        // 修復的核心（課程/體驗發票開立日與 recognitionDate 常不同天，兩基準混用會算出假的現金落差）
        if (!invAuth.printingEnabled) addPay(data.paymentMethod, amount);   // 含轉帳/LinePay/街口/台灣Pay（原本只算現金）
      } else if (data.type === 'pass') {
        passIncome += amount;
        addPay(data.paymentMethod, amount);
        const nm = ((data.notes || '').split('：')[1] || '定期票').trim() || '定期票';
        passByType[nm] = (passByType[nm] || 0) + amount;
      } else if (data.type === 'checkin') {
        // 入場金額本身（entryIncome/shoeRentalIncome）已由 checkinSnap 統計、此處不重複加總；
        // 但付款方式改逐筆用這裡的交易記錄歸類（見上方 checkinFallback 說明），只在此累加 payByMethod。
        if (checkinFallback.has(data.relatedId)) {
          addPay(data.paymentMethod, amount);
          checkinAccountedFor.set(data.relatedId, (checkinAccountedFor.get(data.relatedId) || 0) + amount);
        }
      }
      // type === 'product' / 'single_entry_ticket' / 'refund' 等：入場/商品已分別由 checkinSnap / salesSnap 統計
    });

    // 補上沒有對應 type:'checkin' 交易記錄涵蓋到的差額（理論上應為 0——見上方說明；保留 fallback 只是防呆，
    // 確保即使未來出現漏記交易的路徑，金額也只會退回舊行為的粗略分類，而不會整筆從付款方式統計中消失）
    checkinFallback.forEach((info, id) => {
      const gap = info.amount - (checkinAccountedFor.get(id) || 0);
      if (gap > 0) addPay(info.paymentMethod, gap);
    });

    // buy_pass 票款併入定期票大項（依票種名細項；查無票種名 fallback「購買定期票」）
    const bpIds = Object.keys(buyPassAmounts).filter(k => k !== '_unknown');
    const bpNames = {};
    if (bpIds.length) {
      const refs = bpIds.map(id => db.collection('passTypes').doc(id));
      (await db.getAll(...refs)).forEach(doc => { if (doc.exists) bpNames[doc.id] = doc.data().name; });
    }
    Object.entries(buyPassAmounts).forEach(([k, amt]) => {
      const nm = bpNames[k] || '購買定期票';
      passIncome += amt;
      passByType[nm] = (passByType[nm] || 0) + amt;
    });

    // 已開真列印的館別：課程收入改以「今日實際開立發票金額」為準（不再是「今日認列多少」）——
    // 課程發票延後開立（見 checkInvoiceIssuanceTiming，須等課程結束當天才能開），實際印出的日子
    // 常晚於服務認列日，用認列日會跟真正入帳的那天對不上；改用發票資料才是店員真正在意的
    // 「今天到底開了多少課程發票」。
    // ⚠️ 2026-08-14 補：體驗課程/單堂試上（sourceType:'experience'）收入雖走 type:'course' 記帳
    // （比照課程歸「教學費」大項，見 experienceService.js recordExperienceRevenue），但開立發票時
    // invoices 集合存的 sourceType 是 'experience' 非 'course'——只加 bySourceType.course 會漏算，
    // 這類發票金額整筆消失於「課程」項目。一併加回。
    if (invAuth.printingEnabled) courseIncome = (invAuth.bySourceType.course || 0) + (invAuth.bySourceType.experience || 0);
    // 比賽：與課程同理，真列印館別改以「今日實際開立發票金額」為準（比賽發票同樣延後開立，見
    // checkInvoiceIssuanceTiming 賽前一週才可開），不再依賴 recognitionDate（該日期常是未來的賽事
    // 前一天，非真列印館別才需要上方迴圈的 fallback）。
    if (invAuth.printingEnabled) competitionIncome = invAuth.bySourceType.competition || 0;

    // 真列印館別：付款方式統計改以「今日已開立發票」為單一權威來源（2026-08-22 取代原本逐項從
    // checkIns/productSales/transactions 湊出來的 payByMethod）——invAuth.byMethod 已涵蓋入場/商品/
    // 課程/體驗/租借/比賽等所有走真列印的來源（含原本「無來源手動發票」noSourceByMethod 那個子集，
    // 一併涵蓋不用再另外合併），跟 income 的課程/體驗收入（上方已改依發票金額）用同一個日期基準
    // （issuedAt，非 recognitionDate），兩者才會互相一致、不會再算出「發票開了但認列日不同天」的假現金落差。
    // 定期票(pass)目前無對應真列印發票，其付款方式仍只能靠上方 txnSnap（recognitionDate）那條路，
    // 已在對應分支維持無條件 addPay，故這裡疊加發票總表不會漏算定期票、也不會跟其他來源重複計算
    // （byMethod 的來源 invoices 集合本就不含 pass 的 sourceType）。非真列印館別 invAuth.byMethod 恆空、
    // 此行為 no-op，不影響既有行為。
    Object.entries(invAuth.byMethod).forEach(([m, amt]) => addPay(m, amt));

    const totalIncome = entryIncome + shoeRentalIncome + productIncome + courseIncome + passIncome + equipmentRentalIncome + competitionIncome;
    const totalCash = payByMethod.cash || 0;
    const totalElectronic = (payByMethod.linepay || 0) + (payByMethod.jkopay || 0) + (payByMethod.taiwanpay || 0);
    const totalTransfer = payByMethod.transfer || 0;
    // 「其他」：非現金/轉帳/LinePay/街口/台灣Pay 五種已知付款方式的發票（真實案例：課程發票
    // paymentMethod='migration'／'roster-claim'，來自舊資料轉檔／課程名單認領，並非店員實際收款）——
    // 2026-08-26 修：這筆錢原本完全沒有任何欄位可以裝，就從「付款方式」統計裡憑空消失（income.total
    // 有算、payment 卻找不到），現在獨立歸「其他」，不再無故遺漏。之後若出現更多非標準付款方式字串，
    // 一律自動歸這裡，不會再重演同樣的問題。
    const KNOWN_METHODS = new Set(['cash', 'linepay', 'jkopay', 'taiwanpay', 'transfer']);
    const totalOther = Object.entries(payByMethod).reduce((s, [k, v]) => s + (KNOWN_METHODS.has(k) ? 0 : (v || 0)), 0);

    const settlement = {
      date: today,
      gymId,
      checkinCount: checkinSnap.size,   // 當日 check-in 人數（自動）
      prevCashBalance: prevBalance,
      income: {
        entry: entryIncome,
        shoeRental: shoeRentalIncome,
        product: productIncome,
        course: courseIncome,
        pass: passIncome,
        equipmentRental: equipmentRentalIncome,   // 器材租借（抱石墊/岩盔/吊帶等）
        competition: competitionIncome,   // 比賽報名費（2026-08-26 獨立一項，原本從未計入任何收入分類）
        total: totalIncome,
        // 細項
        entryItems: Object.entries(entryByType).filter(([, v]) => v > 0)
          .map(([k, v]) => ({ label: k, value: v }))   // k 已是分類標籤
          .sort((a, b) => entryOrderSort(a.label, b.label)),
        passItems: Object.entries(passByType).filter(([, v]) => v > 0).map(([k, v]) => ({ label: k, value: v })),
      },
      payment: {
        cash: totalCash,
        linePay: payByMethod.linepay || 0,
        jko: payByMethod.jkopay || 0,
        taiwanPay: payByMethod.taiwanpay || 0,
        transfer: totalTransfer,
        electronic: totalElectronic,
        other: totalOther,   // 非五種已知付款方式（如舊資料轉檔/名單認領標記）＋課程/比賽發票的非轉帳預收款（一律歸此）＋體驗補開舊款（轉帳除外），見上方 computeTodayInvoiceAuthority 註解
      },
      deductions: [],
      expectedCashBalance: prevBalance + totalCash,
      actualCashBalance: null,
      denominations: { d1:0, d5:0, d10:0, d50:0, d100:0, d500:0, d1000:0 },
      invoiceLastNumber: '',
      suggestedInvoiceStart,   // 前一天最後發票號+1（前端帶入，可改；未開真列印的館別用這組）
      suggestedInvoiceTrack,   // 前一天最後一段的字軌（前端帶入，可改；換發票本才需要手動改）
      // 已開真列印的館別：今日收入/發票起訖/作廢一律由 invoices 集合權威帶入、不可手動修改
      // （前端據此隱藏手動輸入欄與發票段落的編輯功能，比照加減項「系統自動記錄不可改」原則）
      printingEnabled: invAuth.printingEnabled,
      invoiceActualTotal: invAuth.actualTotal,
      todayInvoiceSegments: invAuth.segments,
      todayInvoiceVoidNumbers: invAuth.voidNumbers,
      voidInvoiceAmount: invAuth.voidTotalAmount,
      amountModifiedInvoices: invAuth.amountModifiedList,   // 今日列印時金額被人工修改過的發票（含備註）
      difference: null,
      status: 'draft',
    };

    // 已正式結帳 → 回快照（顯示用）＋ live（即時重算收入，供「當日再次結帳」預填最新金額）
    if (existDoc && existDoc.data().status === 'settled') {
      return res.json({ settlement: { id: existDoc.id, ...existDoc.data() }, live: settlement, alreadySettled: true });
    }
    // 有暫存檔（status:'draft'）→ 一併回傳供前端載回續填（收入等仍用即時重算的 settlement）
    if (existDoc && existDoc.data().status === 'draft') {
      return res.json({ settlement, draft: { id: existDoc.id, ...existDoc.data() }, alreadySettled: false });
    }
    res.json({ settlement, alreadySettled: false });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /daily-settlements/draft ── 暫存檔（不擋已結帳判斷、不發差異通知）──
router.put('/draft', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    if (existDoc && existDoc.data().status === 'settled')
      return res.json({ alreadySettled: true, message: '今日已結帳，暫存未儲存（請用「當日再次結帳」）' });

    const lockErr = findRemovedOrAlteredAutoDeductions(existDoc?.data()?.deductions, req.body.deductions);
    if (lockErr) return res.status(400).json({ error: 'AUTO_DEDUCTION_LOCKED', message: lockErr });

    const id = existDoc ? existDoc.id : uuidv4();
    const b = req.body;
    const draft = {
      id, date: today, gymId, status: 'draft',
      // 暫存表單欄位（不做金額權威計算，僅保存續填）
      income: b.income || null, payment: b.payment || null,
      deductions: b.deductions || [], denominations: b.denominations || null,
      invoiceSegments: Array.isArray(b.invoiceSegments) ? b.invoiceSegments : null,
      invoiceStartNumber: b.invoiceStartNumber || '', invoiceLastNumber: b.invoiceLastNumber || '',
      invoiceVoidNumbers: b.invoiceVoidNumbers || '',
      voidInvoiceAmount: Number(b.voidInvoiceAmount) || 0,   // 作廢票號碼總金額（打錯發票金額，總計扣除）
      checkinCount: b.checkinCount ?? null, notes: b.notes || '',
      incomeManual: b.incomeManual || null, paymentManual: b.paymentManual || null,
      savedBy: req.staff.id, savedByName: req.staff.name, updatedAt: new Date(),
      createdAt: existDoc ? (existDoc.data().createdAt || new Date()) : new Date(),
    };
    await db.collection('dailySettlements').doc(id).set(draft);
    res.json({ draft, message: '已暫存' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /daily-settlements ───────────────────────────────────────
router.post('/', authenticate, requireStationAuth, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? (req.body.gymId || req.staff?.gymId) : req.staff?.gymId;
    if (!gymId) return res.status(400).json({ error: 'GYM_REQUIRED', message: '請選擇館別' });
    const today = dayjs().format('YYYY-MM-DD');

    // 今日 gym+date doc（可能是 draft 或已 settled）；當日再次結帳＝更新同一 doc + revisions
    const existSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '==', today).limit(1).get();
    const existDoc = existSnap.empty ? null : existSnap.docs[0];
    const wasSettled = existDoc && existDoc.data().status === 'settled';

    const { income, payment, deductions, denominations, invoiceLastNumber, notes,
      invoiceStartNumber, invoiceVoidNumbers, checkinCount,
      incomeManual, paymentManual, invoiceSegments, resettleReason } = req.body;  // 轉換期手動輸入並列（系統值與手動值都存）

    const lockErr = findRemovedOrAlteredAutoDeductions(existDoc?.data()?.deductions, deductions);
    if (lockErr) return res.status(400).json({ error: 'AUTO_DEDUCTION_LOCKED', message: lockErr });

    // 該館已開真列印 → 今日收入/發票起訖/作廢一律由 invoices 集合權威決定，忽略前端送來的值
    // （比照加減項鎖定原則：系統帶入的資料不信任前端、也不可被覆蓋，見上方 findRemovedOrAlteredAutoDeductions）
    const todayStart = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();
    const invAuth = await computeTodayInvoiceAuthority(db, gymId, todayStart, todayEnd);

    // 發票多段：優先 invoiceSegments 陣列；否則回退舊單段欄位。相容性：仍寫 invoiceStartNumber=首段.start、invoiceLastNumber=末段.last
    // track＝字軌（如 AB），跟著發票捲可能換；舊資料無此欄位一律回退空字串。真列印館別改用系統權威分段。
    const segments = invAuth.printingEnabled ? invAuth.segments : (
      (Array.isArray(invoiceSegments) && invoiceSegments.length
        ? invoiceSegments.map(sg => ({ track: String(sg.track ?? '').trim().toUpperCase(), start: String(sg.start ?? '').trim(), last: String(sg.last ?? '').trim() }))
        : ((invoiceStartNumber || invoiceLastNumber)
          ? [{ track: '', start: String(invoiceStartNumber || '').trim(), last: String(invoiceLastNumber || '').trim() }]
          : [])
      ).filter(sg => sg.track || sg.start || sg.last)
    );
    const firstStart = segments.length ? segments[0].start : (invoiceStartNumber || '');
    const lastLast = segments.length ? segments[segments.length - 1].last : (invoiceLastNumber || '');
    const finalVoidNumbers = invAuth.printingEnabled ? invAuth.voidNumbers.join(', ') : (invoiceVoidNumbers || '');
    const finalVoidAmount = invAuth.printingEnabled ? invAuth.voidTotalAmount : (Number(req.body.voidInvoiceAmount) || 0);

    // 計算實際現金
    const d = denominations || {};
    const actualCash = (d.d1||0)*1 + (d.d5||0)*5 + (d.d10||0)*10 +
      (d.d50||0)*50 + (d.d100||0)*100 + (d.d500||0)*500 + (d.d1000||0)*1000;

    // 前日餘額
    const prevSnap = await db.collection('dailySettlements')
      .where('gymId', '==', gymId).where('date', '<', today)
      .orderBy('date', 'desc').limit(1).get();
    const prevBalance = prevSnap.empty ? 0 : (prevSnap.docs[0].data().closingCashBalance || 0);

    // 計算加減項淨額：sign '+' 加入抽屜（預期上升）、'-' 取出（預期下降）；舊資料無 sign 視為 '-'（減）
    const netAdjust = (deductions || []).reduce((sum, d) => sum + ((d.sign === '+' ? 1 : -1) * (Number(d.amount) || 0)), 0);
    // 付款方式手動輸入（2026-08-15 拆分自 settlementManualInput——原本收入/付款方式共用同一顆開關，
    // 使用者確認系統計算的付款方式已經可信、要求「一切以系統為準」單獨關掉這塊，收入手動輸入維持
    // 不動）。後端權威判斷：即使前端仍送 paymentManual（如舊分頁快取），設定關閉時一律忽略，
    // 只信任即時算出的 payment.* 值——不是只在畫面上藏輸入框而已。
    const transitionDoc = await db.collection('systemSettings').doc('transitionSettings').get();
    const settlementPaymentManualInput = !!(transitionDoc.exists && transitionDoc.data().settlementPaymentManualInput);
    // 線上支付合計（LinePay/街口/台灣Pay/轉帳；缺手動值回退系統）——不論轉換期手動模式或真列印模式，
    // 現金都是「發票總金額（手動輸入或真列印權威）－此線上支付合計」算出，此段兩模式共用。
    const onlineTotal = ['linePay', 'jko', 'taiwanPay', 'transfer'].reduce((sum, k) => {
      const v = settlementPaymentManualInput ? paymentManual?.[k] : undefined;
      const has = v !== undefined && v !== '' && v !== null;
      return sum + (has ? (Number(v) || 0) : (payment?.[k] || 0));
    }, 0);
    // 轉換期手動輸入模式（incomeManual 有帶才算，比照前端只在 settlementManualInput 開啟時才送這欄位）：
    // 現金＝手動發票總金額（依 income/incomeManual 逐項算）－線上支付合計——現金不再靠店員另外獨立填一次。
    const isManualMode = incomeManual != null;
    // ⚠️ 2026-08-23 修正真實案例（新竹單日誤差 -4200，逐筆核對後找到）：已開真列印的館別原本用
    // 「今日實際列印發票總金額（invAuth.actualTotal）－線上支付合計（onlineTotal，只認
    // linePay/jko/taiwanPay/transfer 四種已知電子方式）」推算現金——這個「總額扣掉已知電子方式、
    // 剩下的都當現金」的假設，遇到 paymentMethod 不是「cash」也不是那四種已知電子方式的發票（真實
    // 案例：一筆課程發票 paymentMethod='roster-claim'，來自課程名單認領機制、非店員實際收款）就會
    // 出錯——這 4200 元既不是現金也不是那四種電子支付，卻因為「剩下的」邏輯被誤算進現金，導致
    // 應有現金比實際點鈔多出整整 4200 元（其餘案例逐筆核對皆吻合，唯獨此項有落差）。
    // 已開真列印的館別本就有「精確依 paymentMethod==='cash' 逐筆加總」算出的 payment.cash（見
    // GET /today 的 totalCash，此處 payment 就是前端原封不動送回同一份預覽值）——改直接採用它，
    // 不再用「總額減電子支付」這種容易被未知付款方式污染的推算法，與下方非真列印/非手動模式分支
    // （payment?.cash）用同一套邏輯一致。
    const effectiveCash = invAuth.printingEnabled
      ? (payment?.cash || 0)
      : isManualMode
        ? (manualIncomeTotal(income, incomeManual) || 0) - onlineTotal
        : (payment?.cash || 0);
    const expectedCash = prevBalance + effectiveCash + netAdjust;
    const difference = actualCash - expectedCash;

    const id = existDoc ? existDoc.id : uuidv4();
    const settlement = {
      id, date: today, gymId,
      staffId: req.staff.id, staffName: req.staff.name,
      prevCashBalance: prevBalance,
      income, payment, deductions: deductions || [],
      // 已開真列印的館別不再收 incomeManual（前端不送）
      incomeManual: invAuth.printingEnabled ? null : (incomeManual || null),
      // 付款方式手動輸入關閉時一律存 null（即使前端仍送值也不採用，見上方 settlementPaymentManualInput）
      paymentManual: settlementPaymentManualInput ? (paymentManual || null) : null,
      printingEnabled: invAuth.printingEnabled,   // 該日結帳當下是否為真列印權威模式（供歷史檢視判斷）
      invoiceActualTotal: invAuth.printingEnabled ? invAuth.actualTotal : null,   // 今日實際列印發票總金額
      denominations, actualCashBalance: actualCash,
      expectedCashBalance: expectedCash,
      closingCashBalance: actualCash,
      difference,
      differenceAlert: Math.abs(difference) > 200,
      invoiceSegments: segments,   // 多段發票（真列印館別：系統權威分段，不可手動修改）
      invoiceLastNumber: lastLast || '',
      // 月銷售紀錄用：發票起訖/作廢號、當日 check-in 人數
      invoiceStartNumber: firstStart || '',
      invoiceVoidNumbers: finalVoidNumbers,
      voidInvoiceAmount: finalVoidAmount,   // 作廢票號碼總金額（真列印館別：系統依 invoices 作廢紀錄權威算出）
      checkinCount: checkinCount ?? null,
      amountModifiedInvoices: invAuth.amountModifiedList,   // 今日列印時金額被人工修改過的發票（結帳當下快照，供歷史查詢）
      notes: notes || '',
      status: 'settled',
      settledAt: new Date(),
      createdAt: existDoc ? (existDoc.data().createdAt || new Date()) : new Date(),
    };

    // 當日再次結帳：把上一版存入 revisions（稽核），更新同一 doc、resettleCount+1
    if (wasSettled) {
      const p = existDoc.data();
      const revisions = Array.isArray(p.revisions) ? [...p.revisions] : [];
      revisions.push({
        settledAt: p.settledAt || null, staffId: p.staffId || null, staffName: p.staffName || null,
        income: p.income || null, payment: p.payment || null, deductions: p.deductions || [],
        denominations: p.denominations || null,
        actualCashBalance: p.actualCashBalance ?? null, expectedCashBalance: p.expectedCashBalance ?? null,
        difference: p.difference ?? null,
        invoiceSegments: p.invoiceSegments || null, invoiceStartNumber: p.invoiceStartNumber || '',
        invoiceLastNumber: p.invoiceLastNumber || '', invoiceVoidNumbers: p.invoiceVoidNumbers || '',
      });
      settlement.revisions = revisions;
      settlement.resettleCount = (p.resettleCount || 0) + 1;
      if (resettleReason) settlement.resettleReason = resettleReason;
    } else {
      settlement.revisions = (existDoc && existDoc.data().revisions) || [];
      settlement.resettleCount = 0;
    }

    await db.collection('dailySettlements').doc(id).set(settlement);

    const invoiceRolloverDue = await checkInvoiceRolloverDue(gymId, today).catch(() => false);

    // 警示通知
    if (Math.abs(difference) > 200) {
      const managersSnap = await db.collection('staff').where('role', 'in', ['super_admin', 'gym_manager']).get();
      const batch = db.batch();
      managersSnap.docs.forEach(m => {
        const ref = db.collection('notifications').doc();
        batch.set(ref, {
          type: 'settlement_difference',
          title: '結帳差異警示',
          message: `${gymId === 'gym-hsinchu' ? '新竹館' : '士林館'} ${today} 結帳差異 NT$${difference}，請確認`,
          targetStaffId: m.id,
          isRead: false,
          createdAt: new Date(),
        });
      });
      await batch.commit();
    }

    const doneWord = wasSettled ? '已更新今日結帳' : '結帳完成';
    res.status(201).json({ settlement, resettled: wasSettled, invoiceRolloverDue, message: Math.abs(difference) > 200 ? `${doneWord}，差異 NT$${difference} 已通知管理員` : `${doneWord}！` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /daily-settlements/:id ── 僅 super_admin，供清理測試資料 ──
router.delete('/:id', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const db = getDb();
    await db.collection('dailySettlements').doc(req.params.id).delete();
    res.json({ message: '已刪除結帳紀錄' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /daily-settlements/sweep-stale-drafts（super_admin，手動補跑/測試）──
// 清理逾期暫存檔（date < 今天−3 的 status:'draft'）；settled 永不刪。與每日排程同一函式。
router.post('/sweep-stale-drafts', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const r = await require('../services/settlementService').sweepStaleSettlementDrafts();
    res.json(r);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /daily-settlements ────────────────────────────────────────
router.get('/', authenticate, requireManager, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.staff?.role === 'super_admin' ? req.query.gymId : req.staff?.gymId;
    const days = parseInt(req.query.days) || 30;
    const fromDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    let ref = db.collection('dailySettlements').where('date', '>=', fromDate);
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.orderBy('date', 'desc').get();
    res.json({ settlements: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /daily-settlements/:id/unlock ────────────────────────────
router.put('/:id/unlock', authenticate, checkPermission('super_admin'), async (req, res) => {
  try {
    const db = getDb();
    await db.collection('dailySettlements').doc(req.params.id).update({
      status: 'unlocked',
      unlockedBy: req.staff.id,
      unlockedAt: new Date(),
    });
    res.json({ message: '結帳已解鎖，可重新結帳' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /daily-settlements/monthly-export?month=YYYY-MM ──────────────
// 管理員下載「月銷售紀錄」Excel：整月每日一欄，照原版型自動帶入每日結帳
router.get('/monthly-export', authenticate, requireManager, async (req, res) => {
  try {
    const role = req.staff?.role;
    if (!['super_admin', 'gym_manager'].includes(role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可下載月銷售紀錄' });
    }
    const db = getDb();
    const XLSX = require('xlsx');
    const gymId = role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : dayjs().format('YYYY-MM');
    const start = `${month}-01`;
    const daysInMonth = dayjs(start).daysInMonth();
    const end = dayjs(start).endOf('month').format('YYYY-MM-DD');

    // 單欄位範圍 + 記憶體過濾 gym（避複合索引）
    const snap = await db.collection('dailySettlements').where('date', '>=', start).where('date', '<=', end).get();
    const byDate = {};
    snap.docs.forEach(d => { const s = d.data(); if (!gymId || s.gymId === gymId) byDate[s.date] = s; });

    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const dates = [];
    for (let i = 1; i <= daysInMonth; i++) dates.push(dayjs(start).date(i).format('YYYY-MM-DD'));
    const dayCols = dates.map(dt => dayjs(dt).format('M/D'));
    const wdCols = dates.map(dt => WD[dayjs(dt).day()]);

    const val = (dt, fn) => { const s = byDate[dt]; return s ? (fn(s) ?? '') : ''; };
    const dedSum = (s, type) => { const v = (s.deductions || []).filter(x => x.type === type).reduce((a, x) => a + (Number(x.amount) || 0), 0); return v || ''; };
    const itemVal = (s, arr, label) => { const it = (s.income?.[arr] || []).find(x => x.label === label); return it ? it.value : ''; };

    // 票種細項（沿用結帳已存的 passItems）
    const passLabels = [];
    dates.forEach(dt => { const s = byDate[dt]; if (!s) return;
      (s.income?.passItems || []).forEach(it => { if (!passLabels.includes(it.label)) passLabels.push(it.label); });
    });

    // 入場細項「拆分」：依模組頂 entryCategory 六分類（成人/學生/兒童/個別使用優惠券/隊員折扣/
    // 隊員＋優惠券/…）逐日彙整，與結帳摘要 income.entryItems 同一套分類。
    const ciSnap = await db.collection('checkIns')
      .where('checkedInAt', '>=', new Date(`${start}T00:00:00+08:00`))
      .where('checkedInAt', '<=', new Date(`${end}T23:59:59+08:00`)).get();
    // 線上預付單次入場券還原（見模組頂 resolveOnlineTicketMap 說明）——這份月報表的入場費是獨立從
    // checkIns 重新彙整（非讀取已存的 income.entryItems），故此處也要同樣套用，否則整月的線上預付
    // 入場（含租借）會在此表徹底消失，即使結帳頁本身已經正確顯示。
    const onlineTicketMapMonth = await resolveOnlineTicketMap(db, ciSnap.docs.map(d => d.data()).filter(c => !c.isCancelled && (!gymId || c.gymId === gymId)));
    const entryGroups = {}; // category -> { label, byDate }
    ciSnap.docs.forEach(d => {
      const c = d.data();
      if (c.isCancelled) return;
      if (gymId && c.gymId !== gymId) return;
      if (!c.checkedInAt) return;
      if (c.entryType === 'buy_pass') return; // 入場購定期票票款歸「定期票」列（結帳存檔 passItems），不列入場費
      const dt = new Date(c.checkedInAt.toDate().getTime() + 8 * 3600000).toISOString().slice(0, 10);
      const { entryAmt, cat } = resolveEntryRental(c, onlineTicketMapMonth);
      if (!entryGroups[cat]) entryGroups[cat] = { label: cat, byDate: {} };
      entryGroups[cat].byDate[dt] = (entryGroups[cat].byDate[dt] || 0) + entryAmt;
    });
    // 只列有金額的分類（比照結帳摘要 value>0）；固定六分類序在前、其餘 fallback 依名稱
    const entryKeys = Object.keys(entryGroups)
      .filter(k => Object.values(entryGroups[k].byDate).some(v => v > 0))
      .sort(entryOrderSort);

    // 該日發票號碼帶字軌前綴（比照 invoice-export 的 numCell 處理）：首段字軌用於起始號碼、末段字軌用於結束號碼
    const segTrack = (s, pos) => {
      const segs = Array.isArray(s.invoiceSegments) ? s.invoiceSegments : [];
      if (!segs.length) return '';
      return (pos === 'first' ? segs[0] : segs[segs.length - 1])?.track || '';
    };
    const withTrack = (s, pos, num) => (num && segTrack(s, pos)) ? `${segTrack(s, pos)}-${num}` : (num || '');

    const R = (a, b, c, fn) => [a, b, c, ...dates.map(dt => fn ? val(dt, fn) : '')];
    const aoa = [];
    aoa.push(['項目', '', '', ...dayCols]);
    aoa.push(['', '星期', '', ...wdCols]);
    aoa.push(R('check-in 人數', '', '', s => s.checkinCount));
    aoa.push(R('發票', '起始號碼', '', s => withTrack(s, 'first', s.invoiceStartNumber)));
    aoa.push(R('', '結束號碼', '', s => withTrack(s, 'last', s.invoiceLastNumber)));
    aoa.push(R('', '作廢號碼', '', s => s.invoiceVoidNumbers));
    aoa.push(R('', '作廢票號碼總金額', '', s => s.voidInvoiceAmount || ''));
    aoa.push(R('結帳報表', '實收總額', '', s => invoiceGrandTotal(s)));
    aoa.push(R('', '退貨總額', '', s => dedSum(s, '其他退款')));
    aoa.push(R('收支', '定線費', '', s => dedSum(s, '定線費')));
    aoa.push(R('', '教練費', '', s => dedSum(s, '教練費')));
    aoa.push(R('', '領取現金', '', s => dedSum(s, '現金領取')));
    aoa.push(R('行動支付', '台灣Pay', '', s => s.payment?.taiwanPay));
    aoa.push(R('', 'Line Pay', '', s => s.payment?.linePay));
    aoa.push(R('', '街口', '', s => s.payment?.jko));
    aoa.push(R('', '轉帳', '', s => s.payment?.transfer));
    aoa.push(R('', '現金', '', s => s.payment?.cash));
    aoa.push(R('', '其他', '', s => s.payment?.other));
    aoa.push(R('收銀機應有餘額', '', '', s => s.expectedCashBalance));
    aoa.push(['現金清點', '面額', '']);
    [['1', 'd1'], ['5', 'd5'], ['10', 'd10'], ['50', 'd50'], ['100', 'd100'], ['500', 'd500'], ['1000', 'd1000']]
      .forEach(([lbl, key]) => aoa.push(R('', lbl, '', s => s.denominations?.[key])));
    aoa.push(R('', '清點總計', '', s => s.actualCashBalance));
    aoa.push(R('差異(清點-應有)', '', '', s => s.difference));
    aoa.push(R('說明', '', '', s => s.notes));
    aoa.push(['品項銷售明細', '', '']);
    entryKeys.forEach(k => { const g = entryGroups[k]; aoa.push(['入場費', g.label, '', ...dates.map(dt => g.byDate[dt] || '')]); });
    aoa.push(R('租借費', '岩鞋', '', s => s.income?.shoeRental));
    aoa.push(R('器材租借', '抱石墊/岩盔等', '', s => s.income?.equipmentRental));
    aoa.push(R('商品販售', '商品', '', s => s.income?.product));
    passLabels.forEach(lb => aoa.push(R('定期票', lb, '', s => itemVal(s, 'passItems', lb))));
    aoa.push(R('教學費', '課程', '', s => s.income?.course));
    aoa.push(R('比賽報名', '', '', s => s.income?.competition));
    aoa.push(R('總計', '', '', s => invoiceGrandTotal(s)));

    // ── 手動輸入金額（轉換期 settlementManualInput 逐項手動值；當月任一天有填才輸出此區）──
    const manVal = (st, key) => { const v = st.incomeManual?.[key]; return (v !== '' && v != null) ? (Number(v) || 0) : ''; };
    const manEntry = (st, label) => { const v = st.incomeManual?.entryItems?.[label]; return (v !== '' && v != null) ? (Number(v) || 0) : ''; };
    // 手計總額（與前端 manualIncomeTotal 同邏輯）：入場逐類 手動??系統，其餘項 手動??系統
    const manualTotalOf = (st) => {
      const im = st.incomeManual;
      if (!im || typeof im !== 'object') return '';
      const income = st.income || {};
      let entrySum = 0;
      if (im.entryItems && typeof im.entryItems === 'object') {
        const labels = new Set([...(income.entryItems || []).map(x => x.label), ...Object.keys(im.entryItems)]);
        labels.forEach(lb => {
          const m = im.entryItems[lb];
          entrySum += (m !== '' && m != null) ? (Number(m) || 0)
            : ((income.entryItems || []).find(x => x.label === lb)?.value || 0);
        });
      } else {
        entrySum = (im.entry !== '' && im.entry != null) ? (Number(im.entry) || 0) : (income.entry || 0);
      }
      return entrySum + ['shoeRental', 'equipmentRental', 'product', 'course', 'pass', 'competition']
        .reduce((sum, k) => sum + ((im[k] !== '' && im[k] != null) ? (Number(im[k]) || 0) : (income[k] || 0)), 0);
    };
    const anyManual = dates.some(dt => byDate[dt]?.incomeManual && typeof byDate[dt].incomeManual === 'object');
    if (anyManual) {
      // 入場手動分類列：當月出現過的手動分類聯集（固定序排列）
      const manualEntryLabels = [];
      dates.forEach(dt => { const st = byDate[dt]; if (!st?.incomeManual?.entryItems) return;
        Object.keys(st.incomeManual.entryItems).forEach(lb => {
          const v = st.incomeManual.entryItems[lb];
          if (v !== '' && v != null && !manualEntryLabels.includes(lb)) manualEntryLabels.push(lb);
        });
      });
      manualEntryLabels.sort(entryOrderSort);
      aoa.push(['手動輸入金額', '', '']);
      manualEntryLabels.forEach(lb => aoa.push(['入場費(手動)', lb, '', ...dates.map(dt => val(dt, st => manEntry(st, lb)))]));
      aoa.push(R('租借費(手動)', '岩鞋', '', st => manVal(st, 'shoeRental')));
      aoa.push(R('商品販售(手動)', '商品', '', st => manVal(st, 'product')));
      aoa.push(R('定期票(手動)', '', '', st => manVal(st, 'pass')));
      aoa.push(R('教學費(手動)', '課程', '', st => manVal(st, 'course')));
      aoa.push(R('比賽報名(手動)', '', '', st => manVal(st, 'competition')));
      aoa.push(R('手計總額', '', '', st => { const v = manualTotalOf(st); return v === '' ? '' : v - (st.voidInvoiceAmount || 0); }));
    }

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.aoa_to_sheet(aoa));
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 6 }, ...dates.map(() => ({ wch: 8 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, month);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymName = gymId === 'gym-hsinchu' ? '新竹' : gymId === 'gym-shilin' ? '士林' : '全館';
    const gymSlug = gymId === 'gym-hsinchu' ? 'hsinchu' : gymId === 'gym-shilin' ? 'shilin' : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // HTTP header 必須 ASCII：ASCII fallback filename + RFC 5987 filename*（中文館名 percent-encode）
    res.setHeader('Content-Disposition',
      `attachment; filename="sales_${gymSlug}_${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(`月銷售紀錄_${gymName}_${month}.xlsx`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /daily-settlements/invoice-export?year=YYYY&bimonth=1..6 ──────
// 管理員下載「統一發票明細表（FOR 記帳士）」：每兩個月一期，逐日列發票資料
const GYM_TAX = {
  'gym-hsinchu': { taxId: '87549069', bizName: '紅石攀岩有限公司新竹館' },
  'gym-shilin':  { taxId: '',         bizName: '紅石攀岩有限公司士林館' },
};
router.get('/invoice-export', authenticate, requireManager, async (req, res) => {
  try {
    const role = req.staff?.role;
    if (!['super_admin', 'gym_manager'].includes(role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可下載' });
    }
    const db = getDb();
    const XLSX = require('xlsx');
    const gymId = role === 'super_admin' ? (req.query.gymId || req.staff?.gymId) : req.staff?.gymId;
    const year = parseInt(req.query.year, 10) || dayjs().year();
    const bimonth = Math.min(6, Math.max(1, parseInt(req.query.bimonth, 10) || 1));
    const m1 = (bimonth - 1) * 2 + 1, m2 = m1 + 1;
    const start = `${year}-${String(m1).padStart(2, '0')}-01`;
    const end = dayjs(`${year}-${String(m2).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD');
    const track = (req.query.track || '').trim();
    const def = GYM_TAX[gymId] || { taxId: '', bizName: '紅石攀岩有限公司' };
    const taxId = req.query.taxId || def.taxId || '';
    const bizName = req.query.bizName || def.bizName;

    const snap = await db.collection('dailySettlements').where('date', '>=', start).where('date', '<=', end).get();
    const byDate = {};
    snap.docs.forEach(d => { const s = d.data(); if (!gymId || s.gymId === gymId) byDate[s.date] = s; });

    // 未帶 track query param 時，若整段期間所有有填字軌的段落都同一個字軌 → 自動帶入表頭；不同字軌混用則留空由人工填
    let headerTrack = track;
    if (!headerTrack) {
      const tracksSeen = new Set();
      Object.values(byDate).forEach(s => {
        (Array.isArray(s.invoiceSegments) ? s.invoiceSegments : []).forEach(sg => { if (sg.track) tracksSeen.add(sg.track); });
      });
      if (tracksSeen.size === 1) headerTrack = [...tracksSeen][0];
    }

    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const rocYear = year - 1911;
    const aoa = [];
    aoa.push(['', '', '', '營業人使用二聯式收銀機統一發票明細表']);
    aoa.push(['', '', '', '中 華 民 國', '', `${rocYear}年`, `${m1}/${m2}月`]);
    aoa.push(['統一編號', '', '', taxId]);
    aoa.push(['營業人名稱', '', '', bizName]);
    aoa.push(['發票字軌', '', '', headerTrack]);
    aoa.push(['開立日期', '星期', '交易客次', '開立發票起號', '開立發票迄號', '發票總金額', '作廢發票號碼', '作廢票號碼總金額']);

    const segCount = (st, en) => (/^\d+$/.test(String(st)) && /^\d+$/.test(String(en))) ? (parseInt(en, 10) - parseInt(st, 10) + 1) : 0;
    let d = dayjs(start); const last = dayjs(end);
    while (d.isBefore(last.add(1, 'day'))) {
      const dt = d.format('YYYY-MM-DD'); const s = byDate[dt];
      if (!s) { aoa.push([d.format('YYYY/MM/DD'), WD[d.day()], '', '', '', '', '']); d = d.add(1, 'day'); continue; }
      // 多段發票逐段列（無 invoiceSegments 則回退舊單段）；日彙總（客次/金額/卡號）放第一段列
      const segs = (Array.isArray(s.invoiceSegments) && s.invoiceSegments.length)
        ? s.invoiceSegments : [{ track: '', start: s.invoiceStartNumber || '', last: s.invoiceLastNumber || '' }];
      const totalCnt = segs.reduce((a, sg) => a + segCount(sg.start, sg.last), 0) || '';
      // 起迄號單元格若段落自己有字軌 → 前綴字軌-號碼，避免跨日換捲/多字軌混用時看不出區別
      const numCell = (sg, val) => (sg.track && val) ? `${sg.track}-${val}` : (val || '');
      segs.forEach((sg, idx) => {
        aoa.push([
          idx === 0 ? d.format('YYYY/MM/DD') : '', idx === 0 ? WD[d.day()] : '', idx === 0 ? totalCnt : '',
          numCell(sg, sg.start), numCell(sg, sg.last), idx === 0 ? invoiceGrandTotal(s) : '',
          idx === 0 ? (s.invoiceVoidNumbers || '') : '',
          idx === 0 ? (s.voidInvoiceAmount || '') : '',
        ]);
      });
      d = d.add(1, 'day');
    }

    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.aoa_to_sheet(aoa));
    ws['!cols'] = [{ wch: 12 }, { wch: 5 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    const sheetName = `${year}${String(m1).padStart(2, '0')}${String(m2).padStart(2, '0')}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const gymName = gymId === 'gym-hsinchu' ? '新竹' : gymId === 'gym-shilin' ? '士林' : '全館';
    const gymSlug = gymId === 'gym-hsinchu' ? 'hsinchu' : gymId === 'gym-shilin' ? 'shilin' : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // HTTP header 必須 ASCII：ASCII fallback + RFC 5987 filename*（中文館名 percent-encode）
    res.setHeader('Content-Disposition',
      `attachment; filename="invoice_${gymSlug}_${sheetName}.xlsx"; filename*=UTF-8''${encodeURIComponent(`發票明細_${gymName}_${sheetName}.xlsx`)}`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
