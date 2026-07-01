/**
 * 新竹館商品庫存匯入
 * 讀「新竹紅石 商品資料.xlsx」的「商品」工作表 → 分組成 products（品牌+型號=商品、尺寸=變體）
 * 庫存記在 gymStock['gym-hsinchu'] = 剩餘。
 *
 * 用法：
 *   預覽：  GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importHsinchuProducts.js "/path/新竹紅石 商品資料.xlsx"
 *   寫入：  ...同上... --commit
 *   缺價品(小蜘蛛人/隊服)預設以價格 0 匯入並標「待補價」；加 --skip-nopricing 則略過不匯。
 */
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const GYM = 'gym-hsinchu';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const COMMIT = args.includes('--commit');
const SKIP_NOPRICE = args.includes('--skip-nopricing');
if (!file) { console.error('請提供 xlsx 路徑'); process.exit(1); }

const wb = XLSX.readFile(file);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['商品'], { header: 1, defval: '' }).slice(1)
  .filter(r => r[0] || r[1] || r[2]);

// 分組：類別|品牌|型號 → 商品
const groups = {};
let skippedMeta = 0, noPriceCount = 0;
for (const r of rows) {
  const cat = String(r[0] || '其他').trim();
  const brand = String(r[1] || '').trim();
  const model = String(r[2] || '').trim();
  const size = String(r[3] || '').trim();
  const price = Number(r[5]) || 0;
  const promo = Number(r[6]) || 0;
  const rem = r[9] === '' ? 0 : (Number(r[9]) || 0);
  const note = String(r[10] || '').trim();
  // 排除備註列（如「盤點完成日：…」出現在品牌或型號欄）
  if (`${brand}${model}`.includes('盤點') || (!size && /[：:]\s*20\d\d/.test(`${brand}${model}`))) { skippedMeta++; continue; }
  if (!price) noPriceCount++;
  if (!price && SKIP_NOPRICE) continue;

  const name = model || brand || cat;
  const key = `${cat}|${brand}|${name}`;
  if (!groups[key]) groups[key] = { cat, brand, name, variants: [], needsPricing: false };
  const finalNote = price ? note : (note ? `${note} | 待補價` : '待補價');
  if (!price) groups[key].needsPricing = true;
  groups[key].variants.push({
    id: uuidv4(), size, color: '',
    price, ...(promo ? { promoPrice: promo } : {}),
    stock: rem, gymStock: { [GYM]: rem },
    ...(finalNote ? { note: finalNote } : {}),
  });
}

const products = Object.values(groups).map(g => ({
  id: uuidv4(),
  gymId: null,                 // 商品跨館共用結構，庫存以 gymStock 分館
  name: g.name, brand: g.brand,
  description: g.needsPricing ? '⚠️ 部分尺寸售價待補' : '',
  category: g.cat,
  lowStockAlert: 3,
  isActive: true,
  variants: g.variants,
  createdBy: 'import-hsinchu',
  createdAt: new Date(), updatedAt: new Date(),
}));

const totalVariants = products.reduce((s, p) => s + p.variants.length, 0);
const totalStock = products.reduce((s, p) => s + p.variants.reduce((a, v) => a + (v.stock || 0), 0), 0);
console.log(`分組後：${products.length} 商品 / ${totalVariants} 變體 / 新竹館庫存合計 ${totalStock} 件`);
console.log(`排除備註列 ${skippedMeta}；缺售價變體 ${noPriceCount}${SKIP_NOPRICE ? '（已略過）' : '（以價格 0 匯入，待補）'}`);
console.log('\n各類別：');
const byCat = {};
products.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + 1; });
Object.entries(byCat).forEach(([k, v]) => console.log(`  ${k}: ${v} 商品`));
console.log('\n範例（前 5 商品）：');
products.slice(0, 5).forEach(p => console.log(`  [${p.category}] ${p.brand} ${p.name} — ${p.variants.map(v => `${v.size || '單一'}×${v.stock}$${v.price}`).join(', ')}`));

if (!COMMIT) { console.log('\n（預覽模式，未寫入。確認後加 --commit）'); process.exit(0); }

(async () => {
  const { initFirebase, getDb } = require('../src/config/firebase');
  initFirebase(); const db = getDb();
  let n = 0;
  for (let i = 0; i < products.length; i += 400) {
    const batch = db.batch();
    products.slice(i, i + 400).forEach(p => { batch.set(db.collection('products').doc(p.id), p); n++; });
    await batch.commit();
  }
  console.log(`\n✅ 已寫入 products ${n} 筆`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
