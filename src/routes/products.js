/**
 * 商品管理（含變體，庫存按館別分開）
 * 庫存結構：variant.gymStock = { 'gym-hsinchu': 10, 'gym-shilin': 5 }
 * 向下相容：若無 gymStock，fallback 到舊的 variant.stock
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, checkPermission, auditLog } = require('../middleware/auth');
const { getDb } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { isActiveTeamMember, applyTeamDiscount } = require('../services/teamMemberService');
const { getMember } = require('../services/memberService');

// 取得指定館的庫存
const getGymStock = (variant, gymId) => {
  if (gymId === 'warehouse') return variant.warehouseStock ?? 0; // 倉庫（中央庫存）
  if (variant.gymStock && gymId) return variant.gymStock[gymId] ?? 0;
  return variant.stock ?? 0; // fallback 舊資料
};

// 設定指定館的庫存（回傳新 variant）；gymId='warehouse' 作用於倉庫庫存
const setGymStock = (variant, gymId, qty) => {
  if (gymId === 'warehouse') return { ...variant, warehouseStock: qty };
  const gymStock = { ...(variant.gymStock || {}) };
  if (!gymId) {
    // 無館別模式（舊相容）
    return { ...variant, stock: qty };
  }
  gymStock[gymId] = qty;
  // 總庫存 = 各館加總（讓舊的 stock 欄位仍有意義）
  const total = Object.values(gymStock).reduce((a, b) => a + b, 0);
  return { ...variant, gymStock, stock: total };
};

// ── GET /products ─────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.query.gymId || req.staff?.gymId;
    // 商品是全館共用，但庫存按館別顯示。?inactive=1 → 只回已停用商品（供「重新啟用」）
    const wantInactive = req.query.inactive === '1' || req.query.inactive === 'true';
    let ref = db.collection('products').where('isActive', '==', !wantInactive);
    const snap = await ref.get();
    const products = snap.docs.map(d => {
      const p = { id: d.id, ...d.data() };
      if (gymId) {
        // 注入當前館別的庫存數字到 variant.stock（前端相容）
        p.variants = (p.variants || []).map(v => ({
          ...v,
          stock: getGymStock(v, gymId),
        }));
      }
      return p;
    });
    res.json({ products });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products ────────────────────────────────────────────────
router.post('/', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    const id = uuidv4();
    const now = new Date();
    const gymId = req.body.gymId || req.staff?.gymId || null;
    const { name, brand, description, category, lowStockAlert, variants } = req.body;
    const product = {
      id,
      brand: brand || '',
      name,
      description: description || '',
      category: category || '一般',
      lowStockAlert: parseInt(lowStockAlert) || 5,
      variants: (variants || []).map(v => {
        const stockQty = parseInt(v.stock) || 0;
        const gymStock = gymId ? { [gymId]: stockQty } : {};
        return {
          id: uuidv4(),
          size: v.size || '',
          color: v.color || '',
          price: parseInt(v.price) || 0,
          promoPrice: v.promoPrice ? parseInt(v.promoPrice) : null,
          promoActive: false,
          stock: stockQty,
          gymStock,
          warehouseStock: parseInt(v.warehouseStock) || 0,
        };
      }),
      isActive: true,
      createdBy: req.staff.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection('products').doc(id).set(product);
    res.status(201).json({ product, message: '商品已建立' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /products/:id ─────────────────────────────────────────────
router.put('/:id', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    const allowed = ['name', 'brand', 'description', 'category', 'lowStockAlert', 'variants', 'isActive'];
    const updates = { updatedAt: new Date() };
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    await db.collection('products').doc(req.params.id).update(updates);
    res.json({ message: '商品已更新' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /products/:id/permanent - 永久刪除（僅管理員 super_admin / gym_manager）──
router.delete('/:id/permanent', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    if (!['super_admin', 'gym_manager'].includes(req.staff?.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '僅管理員可永久刪除商品' });
    }
    const db = getDb();
    await db.collection('products').doc(req.params.id).delete();
    res.json({ message: '商品已永久刪除' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── DELETE /products/:id ──────────────────────────────────────────
router.delete('/:id', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    await db.collection('products').doc(req.params.id).update({ isActive: false, updatedAt: new Date() });
    res.json({ message: '商品已停用' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /products/:id/variants/:variantId/promo ───────────────────
router.put('/:id/variants/:variantId/promo', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });
    const variants = doc.data().variants.map(v =>
      v.id === req.params.variantId ? { ...v, promoActive: req.body.promoActive } : v
    );
    await ref.update({ variants, updatedAt: new Date() });
    res.json({ message: '促銷狀態已更新' });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products/:id/restock - 入庫（指定館別）────────────────
router.post('/:id/restock', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    const { variantId, quantity, note } = req.body;
    const gymId = req.body.gymId || req.staff?.gymId;
    const qty = parseInt(quantity) || 0;
    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });

    const variants = doc.data().variants.map(v => {
      if (v.id !== variantId) return v;
      const currentStock = getGymStock(v, gymId);
      return setGymStock(v, gymId, currentStock + qty);
    });

    await ref.update({ variants, updatedAt: new Date() });
    await db.collection('stockLogs').add({
      productId: req.params.id, productName: doc.data().name,
      variantId, gymId,
      type: 'restock', quantity: qty, note: note || '',
      staffId: req.staff.id, createdAt: new Date(),
    });
    res.json({ message: `已入庫 ${qty} 件（${gymId}）` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── PUT /products/:id/variants/:variantId/warehouse-stock - 設定倉庫庫存（僅總管理人員）──
router.put('/:id/variants/:variantId/warehouse-stock', authenticate, checkPermission('products.warehouse'), async (req, res) => {
  try {
    const db = getDb();
    const qty = parseInt(req.body.quantity);
    if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'INVALID_QUANTITY', message: '請輸入有效的數量' });

    const ref = db.collection('products').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'NOT_FOUND' });

    let previousStock = 0;
    const variants = doc.data().variants.map(v => {
      if (v.id !== req.params.variantId) return v;
      previousStock = v.warehouseStock || 0;
      return { ...v, warehouseStock: qty };
    });

    await ref.update({ variants, updatedAt: new Date() });
    await db.collection('stockLogs').add({
      productId: req.params.id, productName: doc.data().name,
      variantId: req.params.variantId, gymId: null,
      type: 'warehouse_adjust', quantity: qty,
      previousStock, diff: qty - previousStock,
      staffId: req.staff.id, createdAt: new Date(),
    });
    res.json({ message: `倉庫庫存已更新為 ${qty} 件` });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products/sell - 銷售（扣指定館庫存）───────────────────
router.post('/sell', authenticate, auditLog('product.sell'), async (req, res) => {
  try {
    const db = getDb();
    const { items, memberId, memberName, paymentMethod, gymId: bodyGymId } = req.body;
    const gymId = bodyGymId || req.staff?.gymId;
    if (!items?.length) return res.status(400).json({ error: 'NO_ITEMS' });
    const now = new Date();
    const saleId = uuidv4();
    let totalAmount = 0;
    let totalDiscount = 0;
    const saleItems = [];

    // 查詢隊員身份（若有指定會員），決定是否套用隊員折扣
    let isTeam = false;
    if (memberId) {
      try {
        const member = await getMember(memberId);
        isTeam = isActiveTeamMember(member);
      } catch (e) { /* 找不到會員不影響銷售，視為非隊員 */ }
    }

    // 先檢查所有品項庫存，避免前面已扣、後面不足才中止造成庫存洩漏
    for (const item of items) {
      const doc = await db.collection('products').doc(item.productId).get();
      if (!doc.exists) continue;
      const variant = doc.data().variants.find(v => v.id === item.variantId);
      if (!variant) continue;
      const stock = getGymStock(variant, gymId);
      if (stock < item.quantity)
        return res.status(400).json({ error: 'INSUFFICIENT_STOCK', message: `${doc.data().name} ${variant.size} ${variant.color} 庫存不足（${gymId} 剩 ${stock} 件）` });
    }

    for (const item of items) {
      const ref = db.collection('products').doc(item.productId);
      const doc = await ref.get();
      if (!doc.exists) continue;
      const product = doc.data();
      const variant = product.variants.find(v => v.id === item.variantId);
      if (!variant) continue;
      const currentStock = getGymStock(variant, gymId);
      if (currentStock < item.quantity)
        return res.status(400).json({ error: 'INSUFFICIENT_STOCK', message: `${product.name} ${variant.size} ${variant.color} 庫存不足（${gymId} 剩 ${currentStock} 件）` });
      const unitPrice = (variant.promoActive && variant.promoPrice) ? variant.promoPrice : variant.price;
      const rawSubtotal = unitPrice * item.quantity;
      const discountResult = applyTeamDiscount(rawSubtotal, isTeam);
      const subtotal = discountResult.discounted;
      totalAmount += subtotal;
      totalDiscount += discountResult.discount;
      saleItems.push({
        productId: item.productId, productName: product.name, brand: product.brand,
        variantId: item.variantId, size: variant.size, color: variant.color,
        price: variant.price, promoPrice: variant.promoPrice ?? null, unitPrice,
        quantity: item.quantity, subtotal,
        teamDiscountApplied: discountResult.applied, teamDiscountAmount: discountResult.discount,
      });
      const updatedVariants = product.variants.map(v => {
        if (v.id !== item.variantId) return v;
        return setGymStock(v, gymId, getGymStock(v, gymId) - item.quantity);
      });
      await ref.update({ variants: updatedVariants, updatedAt: now });
    }

    const sale = {
      id: saleId, gymId,
      items: saleItems, totalAmount, totalDiscount,
      isTeamMemberSale: isTeam,
      memberId: memberId || null, memberName: memberName || '匿名',
      paymentMethod: paymentMethod || 'cash',
      staffId: req.staff.id, staffName: req.staff.name,
      soldAt: now, createdAt: now,
    };
    await db.collection('productSales').doc(saleId).set(sale);

    // 記錄交易（供 /revenue 統一報表使用，dailySettlements 仍直接讀 productSales）
    if (totalAmount > 0) {
      const { recordTransaction } = require('../utils/revenueLedger');
      await recordTransaction(db, {
        gymId,
        type: 'product',
        totalAmount,
        paymentMethod: paymentMethod || 'cash',
        memberId: memberId || null,
        memberName: memberName || '匿名',
        relatedId: saleId,
        notes: `商品銷售：${saleItems.map(i => i.productName).join('、')}`,
        staffId: req.staff.id,
        staffName: req.staff.name,
      });
    }

    res.status(201).json({
      sale,
      message: isTeam && totalDiscount > 0
        ? `銷售完成，總計 NT$${totalAmount}（已套用攀岩隊員折扣，折抵 NT$${totalDiscount}）`
        : `銷售完成，總計 NT$${totalAmount}`,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products/sales/:saleId/return - 商品退貨（整筆）──────────
// 還原庫存 + 建立負額退貨紀錄（供結算/報表沖銷）+ 記負向交易 + 標記原銷售已退
router.post('/sales/:saleId/return', authenticate, checkPermission('products.sell'), auditLog('product.return'), async (req, res) => {
  try {
    const db = getDb();
    const saleRef = db.collection('productSales').doc(req.params.saleId);
    const saleDoc = await saleRef.get();
    if (!saleDoc.exists) return res.status(404).json({ error: 'NOT_FOUND', message: '找不到此銷售紀錄' });
    const sale = saleDoc.data();
    if (sale.isReturn) return res.status(400).json({ error: 'IS_RETURN', message: '此為退貨紀錄，不可再退' });
    if (sale.returned) return res.status(400).json({ error: 'ALREADY_RETURNED', message: '此筆銷售已退貨' });
    const now = new Date();
    const gymId = sale.gymId;

    // 還原庫存（各品項加回原銷售館別）
    for (const item of (sale.items || [])) {
      const ref = db.collection('products').doc(item.productId);
      const doc = await ref.get();
      if (!doc.exists) continue;
      const variants = doc.data().variants.map(v =>
        v.id === item.variantId ? setGymStock(v, gymId, getGymStock(v, gymId) + item.quantity) : v);
      await ref.update({ variants, updatedAt: now });
    }

    // 負額退貨紀錄（結算/報表以 totalAmount 加總，負額自動沖銷；付款別沿用原單）
    const refundId = uuidv4();
    await db.collection('productSales').doc(refundId).set({
      id: refundId, gymId, isReturn: true, originalSaleId: sale.id,
      items: (sale.items || []).map(i => ({ ...i, quantity: -i.quantity, subtotal: -(i.subtotal || 0) })),
      totalAmount: -(sale.totalAmount || 0), totalDiscount: -(sale.totalDiscount || 0),
      isTeamMemberSale: sale.isTeamMemberSale || false,
      memberId: sale.memberId || null, memberName: sale.memberName || '匿名',
      paymentMethod: sale.paymentMethod || 'cash',
      staffId: req.staff.id, staffName: req.staff.name,
      reason: req.body.reason || '', soldAt: now, createdAt: now,
    });

    // 記負向交易（供 /revenue）
    if ((sale.totalAmount || 0) > 0) {
      const { recordTransaction } = require('../utils/revenueLedger');
      await recordTransaction(db, {
        gymId, type: 'product_refund', totalAmount: -(sale.totalAmount || 0),
        paymentMethod: sale.paymentMethod || 'cash',
        memberId: sale.memberId || null, memberName: sale.memberName || '匿名',
        relatedId: refundId, notes: `商品退貨：${(sale.items || []).map(i => i.productName).join('、')}`,
        staffId: req.staff.id, staffName: req.staff.name,
      });
    }

    await saleRef.update({ returned: true, returnedAt: now, returnedBy: req.staff.id, returnRefId: refundId, returnReason: req.body.reason || '', updatedAt: now });
    res.json({ message: `已退貨，退款 NT$${sale.totalAmount || 0}（庫存已還原）`, refundId });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /products/sales ───────────────────────────────────────────
router.get('/sales', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.query.gymId || (req.staff?.role !== 'super_admin' ? req.staff?.gymId : null);
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 366); // clamp 1..366，避免超大範圍查詢
    const fromDate = dayjs().subtract(days, 'day').toDate();
    let ref = db.collection('productSales').where('soldAt', '>=', fromDate);
    if (gymId) ref = ref.where('gymId', '==', gymId);
    const snap = await ref.orderBy('soldAt', 'desc').get();
    res.json({ sales: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products/import - Excel 匯入 ───────────────────────────
router.post('/import', authenticate, checkPermission('products.manage'), upload.single('file'), async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const db = getDb();
    const gymId = req.body.gymId || req.staff?.gymId || null;
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    const productMap = {};
    for (const row of rows) {
      const key = `${row['品牌']||''}_${row['名稱']||''}_${row['類別']||''}`;
      if (!productMap[key]) {
        productMap[key] = {
          id: uuidv4(),
          brand: row['品牌'] || '', name: row['名稱'] || '',
          category: row['類別'] || '一般', description: row['說明'] || '',
          lowStockAlert: parseInt(row['低庫存警示']) || 5,
          variants: [], isActive: true,
          createdBy: req.staff.id, createdAt: new Date(), updatedAt: new Date(),
        };
      }
      const stockQty = parseInt(row['庫存']) || 0;
      const gymStock = gymId ? { [gymId]: stockQty } : {};
      productMap[key].variants.push({
        id: uuidv4(),
        size: String(row['尺寸'] || ''), color: String(row['顏色'] || ''),
        price: parseInt(row['原價']) || 0,
        promoPrice: row['促銷價'] ? parseInt(row['促銷價']) : null,
        promoActive: false, stock: stockQty, gymStock,
      });
    }
    const products = Object.values(productMap);
    const batch = db.batch();
    products.forEach(p => batch.set(db.collection('products').doc(p.id), p));
    await batch.commit();
    res.json({ message: `已匯入 ${products.length} 個商品`, count: products.length });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /products/export ──────────────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const db = getDb();
    const gymId = req.query.gymId || req.staff?.gymId;
    const snap = await db.collection('products').where('isActive', '==', true).get();
    const rows = [];
    snap.docs.forEach(d => {
      const p = d.data();
      (p.variants || []).forEach(v => {
        rows.push({
          '品牌': p.brand || '', '名稱': p.name,
          '類別': p.category || '', '說明': p.description || '',
          '尺寸': v.size || '', '顏色': v.color || '',
          '原價': v.price || 0, '促銷價': v.promoPrice || '',
          '促銷狀態': v.promoActive ? '促銷中' : '未促銷',
          '庫存': getGymStock(v, gymId),
          '低庫存警示': p.lowStockAlert || 5,
        });
      });
    });
    const ws = require('../utils/xlsxSafe').sanitizeSheet(XLSX.utils.json_to_sheet(rows));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '庫存');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=inventory.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

// ── POST /products/stocktake - 庫存盤點（按館別）────────────────
router.post('/stocktake', authenticate, checkPermission('products.manage'), async (req, res) => {
  try {
    const db = getDb();
    const gymId = req.body.gymId || req.staff?.gymId;
    const { items } = req.body;
    const discrepancies = [];
    const now = new Date();

    for (const item of items) {
      const ref = db.collection('products').doc(item.productId);
      const doc = await ref.get();
      if (!doc.exists) continue;
      const product = doc.data();
      const variant = product.variants.find(v => v.id === item.variantId);
      if (!variant) continue;
      const systemStock = getGymStock(variant, gymId);
      const diff = item.actualStock - systemStock;
      if (diff !== 0) {
        discrepancies.push({
          productId: item.productId, productName: product.name,
          variantId: item.variantId, size: variant.size, color: variant.color,
          systemStock, actualStock: item.actualStock, diff,
        });
      }
      const updatedVariants = product.variants.map(v =>
        v.id === item.variantId ? setGymStock(v, gymId, item.actualStock) : v
      );
      await ref.update({ variants: updatedVariants, updatedAt: now });
      await db.collection('stockLogs').add({
        productId: item.productId, productName: product.name,
        variantId: item.variantId, gymId,
        type: 'stocktake', quantity: item.actualStock,
        previousStock: systemStock, diff,
        staffId: req.staff.id, createdAt: now,
      });
    }

    if (discrepancies.length > 0) {
      const managersSnap = await db.collection('staff').where('role', 'in', ['super_admin', 'gym_manager']).get();
      const notifBatch = db.batch();
      managersSnap.docs.forEach(m => {
        const notifRef = db.collection('notifications').doc();
        notifBatch.set(notifRef, {
          type: 'stocktake_discrepancy', title: '庫存盤點差異',
          message: `發現 ${discrepancies.length} 項庫存差異，請確認`,
          targetStaffId: m.id, data: { discrepancies }, isRead: false, createdAt: now,
        });
      });
      await notifBatch.commit();
    }

    res.json({
      message: discrepancies.length > 0
        ? `盤點完成，發現 ${discrepancies.length} 項差異，已通知管理員`
        : '盤點完成，庫存無差異',
      discrepancies,
    });
  } catch (err) { res.status(500).json({ error: 'SERVER_ERROR', message: err.message }); }
});

module.exports = router;
