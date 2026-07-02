/**
 * 士林館商品庫存「對齊匯入」
 * 讀「商品存貨.xlsx」的「販售裝備列表」→ 對齊現有商品目錄（跨館共用結構，gymId:null）
 * 士林剩餘庫存寫進 variant.gymStock['gym-shilin']；價格不覆蓋既有變體（保留新竹匯入的權威價）。
 *
 *   已對映到現有商品/變體 → 只更新該變體 gymStock['gym-shilin']
 *   現有商品但士林多出的尺寸 → 對現有商品 append 新變體（hc:0, sl:剩餘）
 *   現有目錄沒有的商品     → 建新商品（gymId:null, gymStock['gym-shilin']=剩餘）
 *
 * 排除「租用岩鞋列表」「岩友寄賣商品」（比照新竹，寄賣/租鞋不匯入）。
 *
 * 用法：
 *   預覽：GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/importShilinProducts.js "/path/商品存貨.xlsx"
 *   寫入：...同上... --commit
 */
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const GYM = 'gym-shilin';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const COMMIT = args.includes('--commit');
if (!file) { console.error('請提供 xlsx 路徑'); process.exit(1); }

// ── 類別整併（對齊現有 6 類：岩鞋 / 其他 / 粉袋岩粉 / 訓練器 / 鉤環 / 書）──
function mapCategory(rawCat, brand, model, prevMapped) {
  const c = String(rawCat || '').trim();
  const m = String(model || '').trim();
  const text = `${brand} ${model}`;
  if (/磨皮棒/.test(m)) return '其他';                // 例外：跟在書後面但屬其他
  if (c === '岩鞋') return '岩鞋';
  if (c === '鉤環') return '鉤環';
  if (c === '書') return '書';
  if (['按摩環', '彈力帶', '手指拉力圈', '腕力球', '訓練器'].includes(c)) return '訓練器';
  if (['粉球', '粉袋'].includes(c)) return '粉袋岩粉';
  if (c.includes('豬鬃刷')) return '其他';
  if (c.includes('貼布')) return '其他';
  if (c === '除臭活性碳') return '其他';
  if (c) return '其他';
  // 空類別 = 上一列的延續，沿用上一列的整併結果（例外已在最前處理）
  if (/Make or Break|路線圖|龍洞|gimme kraft|Injuries|教本|Manual/i.test(text)) return '書';
  return prevMapped || '其他';
}

// ── 尺寸正規化（供對映比對）──
function normSize(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.split(' - ')[0].trim();          // "UK5.1/2 - CM24 - EU.." → "UK5.1/2"
  s = s.replace(/\([^)]*\)/g, '').trim(); // 去 (23.5) / (紅) / (無現貨)
  s = s.replace(/-\s*[一-鿿].*$/, '').trim(); // 去 "-黑灰"
  s = s.replace(/\.?1\/2/, '.5');         // UK5.1/2 → UK5.5
  s = s.replace(/\s+/g, '');
  s = s.replace(/^us/i, 'US').replace(/^uk/i, 'UK');
  return s;
}
const normKey = (brand, name) =>
  `${String(brand || '').toLowerCase().replace(/\s+/g, '')}|${String(name || '').toLowerCase().replace(/\s+/g, '')}`;

// ── 讀 Excel ──
const wb = XLSX.readFile(file);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['販售裝備列表'], { header: 1, defval: '' }).slice(2)
  .filter(r => r[0] || r[1] || r[2] || r[3]);

// 原始類別清理成可讀的品牌前綴（去引號/括號補述），供品牌空白的雜項辨識用
const cleanCat = (c) => String(c || '').replace(/["「」]/g, '').replace(/\([^)]*\)/g, '').trim();

// 分組：整併類別 | 品牌 | 型號(=名稱)
const groups = {};
let prevMapped = '其他', prevRawCat = '';
for (const r of rows) {
  let rawCat = String(r[0] || '').trim();
  const brand0 = String(r[1] || '').trim();
  const model = String(r[2] || '').trim();
  const size = String(r[3] || '').trim();
  const price = Number(r[4]) || 0;
  const rem = r[7] === '' ? 0 : (Number(r[7]) || 0);
  if (!rawCat) rawCat = prevRawCat;                 // 空類別沿用上一列原始類別（辨識用）
  else prevRawCat = rawCat;
  const cat = mapCategory(rawCat, brand0, model, prevMapped);
  prevMapped = cat;
  // 品牌空白時用原始類別當品牌前綴，避免「豬鬃刷白色 vs 貼布白色」碰撞、名稱可讀
  const brand = brand0 || cleanCat(rawCat);
  const name = model || brand || cat;
  const key = `${cat}|${normKey(brand, name)}`;
  if (!groups[key]) groups[key] = { cat, brand, name, variants: [] };
  // 同商品同正規化尺寸合併剩餘（例：Drifter US7.5 一般 + 黑灰rem0）
  const ns = normSize(size);
  const exist = groups[key].variants.find(v => v._ns === ns);
  if (exist) { exist.rem += rem; }
  else groups[key].variants.push({ _ns: ns, rawSize: size, price, rem });
}
const shilinProducts = Object.values(groups);

(async () => {
  const { initFirebase, getDb } = require('../src/config/firebase');
  initFirebase(); const db = getDb();
  const snap = await db.collection('products').get();
  const existing = [];
  snap.forEach(d => existing.push({ id: d.id, ...d.data() }));
  // 索引（只配對啟用中的商品，避開停用重複品）
  const idx = {};
  existing.forEach(p => { if (p.isActive !== false) idx[normKey(p.brand, p.name)] = p; });

  const plan = { updateVariant: [], addVariant: [], newProduct: [], priceDiff: [] };
  const productWrites = {}; // productId → 變更後的 variants（就地更新 gymStock）
  const newDocs = [];

  for (const sp of shilinProducts) {
    const match = idx[normKey(sp.brand, sp.name)];
    if (match) {
      const variants = productWrites[match.id] || match.variants.map(v => ({ ...v, gymStock: { ...(v.gymStock || {}) } }));
      for (const sv of sp.variants) {
        const cands = variants.filter(v => normSize(v.size) === sv._ns);
        if (cands.length === 1) {
          cands[0].gymStock = { ...(cands[0].gymStock || {}), [GYM]: sv.rem };
          plan.updateVariant.push(`${sp.brand} ${sp.name} [${cands[0].size}] ← 士林 ${sv.rem}`);
          if (sv.price && cands[0].price && sv.price !== cands[0].price)
            plan.priceDiff.push(`${sp.brand} ${sp.name} ${cands[0].size}: 現有 $${cands[0].price} vs 士林 $${sv.price}`);
        } else if (cands.length === 0) {
          variants.push({ id: uuidv4(), size: sv.rawSize.replace(/\s*-\s*(CM|EU).*$/i, '').trim(), color: '',
            price: sv.price, stock: 0, gymStock: { [GYM]: sv.rem } });
          plan.addVariant.push(`${sp.brand} ${sp.name} [${sv.rawSize}] ＝新變體 士林 ${sv.rem}`);
        } else {
          plan.addVariant.push(`⚠ 多重對映 ${sp.brand} ${sp.name} ${sv._ns}（${cands.map(c=>c.size).join('/')}）— 已略過待人工`);
        }
      }
      productWrites[match.id] = variants;
    } else {
      const doc = {
        id: uuidv4(), gymId: null, name: sp.name, brand: sp.brand,
        description: '', category: sp.cat, lowStockAlert: 3, isActive: true,
        variants: sp.variants.map(v => ({ id: uuidv4(),
          size: v.rawSize.replace(/\s*-\s*(CM|EU).*$/i, '').trim(), color: '',
          price: v.price, stock: 0, gymStock: { [GYM]: v.rem } })),
        createdBy: 'import-shilin', createdAt: new Date(), updatedAt: new Date(),
      };
      newDocs.push(doc);
      plan.newProduct.push(`[${sp.cat}] ${sp.brand} ${sp.name} — ${sp.variants.map(v=>`${v.rawSize||'單一'}×${v.rem}`).join(', ')}`);
    }
  }

  // ── 報告 ──
  const catCount = {}; shilinProducts.forEach(p => catCount[p.cat] = (catCount[p.cat]||0)+1);
  const totalRem = shilinProducts.reduce((s,p)=>s+p.variants.reduce((a,v)=>a+v.rem,0),0);
  console.log(`\n===== 士林對齊匯入 ${COMMIT ? '【寫入】' : '（預覽）'} =====`);
  console.log(`士林商品群組 ${shilinProducts.length}（含變體剩餘合計 ${totalRem} 件）`);
  console.log('類別分布：', Object.entries(catCount).map(([k,v])=>`${k}:${v}`).join('  '));
  console.log(`\n── 對映到現有商品：更新 ${Object.keys(productWrites).length} 個商品，共 ${plan.updateVariant.length} 個變體 ──`);
  plan.updateVariant.forEach(l=>console.log('  ✓', l));
  console.log(`\n── 現有商品 append 新變體 ${plan.addVariant.length} ──`);
  plan.addVariant.forEach(l=>console.log('  ＋', l));
  console.log(`\n── 建立新商品 ${newDocs.length} ──`);
  plan.newProduct.forEach(l=>console.log('  ●', l));
  if (plan.priceDiff.length) {
    console.log(`\n── ⚠ 價格差異 ${plan.priceDiff.length}（保留現有價，未覆蓋；供核對）──`);
    plan.priceDiff.forEach(l=>console.log('   ', l));
  }

  if (!COMMIT) { console.log('\n（預覽模式，未寫入。確認後加 --commit）'); process.exit(0); }

  // ── 寫入 ──
  let upd = 0, cre = 0;
  const ids = Object.keys(productWrites);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    ids.slice(i, i+400).forEach(id => { batch.update(db.collection('products').doc(id), { variants: productWrites[id], updatedAt: new Date() }); upd++; });
    await batch.commit();
  }
  for (let i = 0; i < newDocs.length; i += 400) {
    const batch = db.batch();
    newDocs.slice(i, i+400).forEach(d => { batch.set(db.collection('products').doc(d.id), d); cre++; });
    await batch.commit();
  }
  console.log(`\n✅ 已更新 ${upd} 個現有商品、新建 ${cre} 個商品`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
