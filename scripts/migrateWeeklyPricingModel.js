/**
 * 週課計費模式改造：批次遷移既有課程「梯次總價」→「單堂價×場次」
 *
 * 只處理 `type !== 'workshop'`（週課）的課程；工作坊完全不動（維持 price/midpointSurcharge 模式）。
 * 每筆課程：
 *   - pricePerSession = round(price / totalSessions)（totalSessions 缺值/0 → 跳過、列入「需人工確認」）
 *   - price 依 pricePerSession × totalSessions 重算，dry-run 逐筆列出與原價的落差（不管多少都列，不默默接受偏差）
 *   - fullTermRenewalDiscount/alumniDiscount（舊：NT$ 折抵）→ 算「隱含比率」（1 - 折抵/原價），
 *     四捨五入到整數百分比；落在 90%/95% 附近（±2 個百分點）吸附成標準值，否則保留隱含值並標記「非標準」供人工確認比率。
 *     Enabled = 原本的 flat 金額 > 0。
 *   - trialPrice／midpointSurcharge：完全不動（trialPrice 為 null 者跑時自動走新公式；工作坊本就不受影響）。
 *   - 不動 courseEnrollments/courseRegistrations（會員歷史報名的 enrollmentFee 是快照，不追溯）。
 *   - 舊的 fullTermRenewalDiscount/alumniDiscount 欄位留在文件上不刪，只是程式碼不再讀。
 *
 * 用法（redrock-api 目錄下）：
 *   預覽（全部）：      GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/migrateWeeklyPricingModel.js
 *   預覽（指定幾筆）：   ... node scripts/migrateWeeklyPricingModel.js --only=courseId1,courseId2
 *   實際寫入：          ... node scripts/migrateWeeklyPricingModel.js --commit
 */
const { initFirebase, getDb } = require('../src/config/firebase');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const onlyIds = ONLY ? ONLY.split(',').map(s => s.trim()).filter(Boolean) : null;

// 隱含折扣比率：算出來的百分比若落在 90/95 附近（±2 點）就吸附成標準值，否則保留原值並標記非標準。
function resolveImpliedRate(flatAmount, price) {
  const amt = Number(flatAmount) || 0;
  if (amt <= 0 || !price) return { enabled: false, rate: null, impliedPercent: null, flagged: false };
  const impliedPercent = Math.round((1 - amt / price) * 100);
  const candidates = [90, 95];
  let snapped = candidates[0], minDist = Infinity;
  candidates.forEach(c => { const d = Math.abs(impliedPercent - c); if (d < minDist) { minDist = d; snapped = c; } });
  const flagged = minDist > 2;
  const rate = flagged ? impliedPercent / 100 : snapped / 100;
  return { enabled: true, rate, impliedPercent, flagged };
}

(async () => {
  initFirebase();
  const db = getDb();

  const snap = await db.collection('courses').get();
  let courses = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.type !== 'workshop');
  if (onlyIds) courses = courses.filter(c => onlyIds.includes(c.id));

  console.log(`\n===== 週課計費模式遷移 ${COMMIT ? '【寫入】' : '（預覽）'} =====`);
  console.log(`符合條件（type!=='workshop'）課程共 ${courses.length} 筆\n`);

  const plan = []; // { id, ref, updates, logLines }
  const needsReview = [];

  for (const c of courses) {
    const name = c.name || c.id;
    const price = Number(c.price) || 0;
    const totalSessions = Number(c.totalSessions) || 0;

    if (!totalSessions) {
      needsReview.push(`⚠ ${name}（${c.id}）：totalSessions 缺值/0，無法算單堂價，請人工確認（原價 NT$${price}）`);
      continue;
    }

    const pricePerSession = Math.round(price / totalSessions);
    const newPrice = pricePerSession * totalSessions;
    const priceDiff = newPrice - price;

    const renewal = resolveImpliedRate(c.fullTermRenewalDiscount, price);
    const alumni = resolveImpliedRate(c.alumniDiscount, price);

    const updates = {
      pricePerSession,
      price: newPrice,
      fullTermRenewalDiscountEnabled: renewal.enabled,
      fullTermRenewalDiscountRate: renewal.enabled ? renewal.rate : 0.9,
      alumniDiscountEnabled: alumni.enabled,
      alumniDiscountRate: alumni.enabled ? alumni.rate : 0.95,
      updatedAt: new Date(),
    };

    const lines = [];
    lines.push(`● ${name}（${c.id}）`);
    lines.push(`   原價 NT$${price} ÷ ${totalSessions} 堂 = 單堂 NT$${pricePerSession}（四捨五入）→ 新總價 NT$${newPrice}${priceDiff !== 0 ? `　⚠ 價差 ${priceDiff > 0 ? '+' : ''}${priceDiff}` : ''}`);
    if (renewal.enabled) {
      lines.push(`   續報優惠：原 NT$${c.fullTermRenewalDiscount} 折抵 → 隱含 ${renewal.impliedPercent}% → 套用 ${Math.round(renewal.rate * 100)}%${renewal.flagged ? '　⚠ 非標準折扣，請人工確認比率' : ''}`);
    }
    if (alumni.enabled) {
      lines.push(`   舊生優惠：原 NT$${c.alumniDiscount} 折抵 → 隱含 ${alumni.impliedPercent}% → 套用 ${Math.round(alumni.rate * 100)}%${alumni.flagged ? '　⚠ 非標準折扣，請人工確認比率' : ''}`);
    }
    if (c.trialPrice != null) lines.push(`   試上費：已明確覆寫 NT$${c.trialPrice}，維持不動`);

    plan.push({ id: c.id, ref: db.collection('courses').doc(c.id), updates, lines });
  }

  plan.forEach(p => { p.lines.forEach(l => console.log(l)); console.log(''); });

  if (needsReview.length) {
    console.log(`\n===== 需人工確認（${needsReview.length} 筆，未納入本次遷移）=====`);
    needsReview.forEach(l => console.log(l));
  }

  console.log(`\n===== 合計：可遷移 ${plan.length} 筆、需人工確認 ${needsReview.length} 筆 =====`);

  if (!COMMIT) {
    console.log('\n（預覽模式，未寫入。確認金額/比率合理後加 --commit）');
    process.exit(0);
  }

  let n = 0;
  for (let i = 0; i < plan.length; i += 400) {
    const batch = db.batch();
    plan.slice(i, i + 400).forEach(p => { batch.update(p.ref, p.updates); n++; });
    await batch.commit();
  }
  console.log(`\n✅ 已寫入 ${n} 筆課程`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
