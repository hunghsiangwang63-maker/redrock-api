/**
 * checkin/pricing.js — 票價 / 會員身份 / 折扣計算（隊員9折・舊折扣卡8折・特約廠商）
 * 由 checkinService.js 拆分（2026-07-13 refactor）；函式本體逐字搬移、行為不變。
 * 對外 API 仍經 services/checkinService.js 門面 re-export。
 */
const { getDb } = require('../../config/firebase');
const { isActiveTeamMember, TEAM_DISCOUNT_MIN_AMOUNT } = require('../teamMemberService');
const dayjs = require('dayjs');

const PRICES = {
  single_general: 350,
  single_child: 0,       // 兒童免費（未滿13歲）
  single_student: 0,     // 學生免費（13~22歲或已驗證學生證）
  discount_card: 600,    // 購買優惠折扣券（含本次入場）
  shoes_rental: 100,     // 岩鞋租借
  team_discount_rate: 0.9,
  team_discount_min: 100,
};

// 使用優惠折扣券入場：原價 8 折（兒童不適用）。原價依會員身份取 entryTypes 價格。
const DISCOUNT_CARD_RATE = 0.8;
// 特約廠商入場優惠：全票/學生票在「無其他折扣」時定額 −N（兒童不適用；與隊員9折/舊折扣卡8折互斥）。
// 金額與啟用開關可於員工端「系統設定 → 入場規則」設定（systemSettings/partnerVendor）；讀不到 fallback 啟用+20。
const PARTNER_VENDOR_DISCOUNT = 20;   // fallback 預設
const getPartnerVendorConfig = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('partnerVendor').get();
    const d = doc.exists ? doc.data() : {};
    return { enabled: d.enabled !== false, discount: Number.isFinite(d.discount) ? d.discount : PARTNER_VENDOR_DISCOUNT };
  } catch { return { enabled: true, discount: PARTNER_VENDOR_DISCOUNT }; }
};

// 友館隊員入場優惠：全額入場費 ×rate（預設 9 折），自行出示證明、櫃檯查驗（比照特約廠商）。
// 可於員工端「系統設定 → 入場規則」設定（systemSettings/partnerGymMember）；讀不到 fallback 啟用+0.9。
const PARTNER_GYM_MEMBER_RATE = 0.9;
const getPartnerGymMemberConfig = async () => {
  try {
    const doc = await getDb().collection('systemSettings').doc('partnerGymMember').get();
    const d = doc.exists ? doc.data() : {};
    return { enabled: d.enabled !== false, rate: (Number.isFinite(d.rate) && d.rate > 0 && d.rate < 1) ? d.rate : PARTNER_GYM_MEMBER_RATE };
  } catch { return { enabled: true, rate: PARTNER_GYM_MEMBER_RATE }; }
};

// 取得「原價」（折扣券 8 折的基準）：一般→single_ticket，學生→student_free
const getOriginalEntryPrice = async (memberType) => {
  const id = memberType === 'student' ? 'student_free' : 'single_ticket';
  const fallback = memberType === 'student' ? 250 : PRICES.single_general;
  return getEntryTypePrice(id, fallback);
};

// ── 墜落測驗：有效期 1 年；到期前2個月~前1天入場時，回看過去1年若≥2次入場則自動延長1年（見 checkin/gates.js tryExtendFallTest）──
const getMemberType = (member) => {
  if (member.memberType === 'vip') return 'vip';
  if (member.memberType === 'climbing_team') return 'climbing_team';
  if (!member.birthday) return 'general';
  const age = dayjs().diff(dayjs(member.birthday), 'year');
  if (age < 13) return 'child';
  if (age <= 22) return 'student';
  if (member.memberType === 'student' && member.studentVerified) return 'student';
  return 'general';
};

const isFreeEntry = (memberType) => memberType === 'child' || memberType === 'student';

// 入場價由 systemSettings/entryTypes 設定（可隨時調整；找不到用 fallback）
const getEntryTypePrice = async (entryTypeId, fallback) => {
  try {
    const db = getDb();
    const doc = await db.collection('systemSettings').doc('entryTypes').get();
    if (!doc.exists) return fallback;
    const t = (doc.data().types || []).find(x => x.id === entryTypeId);
    return (t && typeof t.price === 'number') ? t.price : fallback;
  } catch (e) { return fallback; }
};

// ── 付費入場金額（唯一權威來源）─────────────────────────────────
// 依 entryTypes 設定計算付費入場金額，套用（可選）舊折扣卡 8 折 + 有效隊員 9 折。
// QR 自助入場（createPendingCheckIn）與站台電話入場（/checkin/phone）共用此邏輯，
// 折扣規則只有一份，避免站台漏帶隊員折扣。
// opts.legacyDiscountCard=true → 先套 8 折（舊實體折扣卡，轉換期用），有效隊員再疊 9 折。
// 隊員 9 折的門檻一律以「原價 >= TEAM_DISCOUNT_MIN_AMOUNT」判斷（與 discount_card 疊加規則一致）。
// 找不到對應的付費入場類型時回 null，由呼叫端沿用自身 fallback。
const computePaidEntryAmount = async (entryType, member, opts = {}) => {
  const db = getDb();
  const etDoc = await db.collection('systemSettings').doc('entryTypes').get();
  const t = etDoc.exists
    ? (etDoc.data().types || []).find(x => x.id === entryType && x.active !== false)
    : null;
  if (!t || typeof t.price !== 'number') return null;
  const originalAmount = t.price;
  // 兒童：不適用折扣卡、也不會是隊員 → 一律原價，任何折扣都不套（權威擋，涵蓋電話入場與 QR 自助）
  if (entryType === 'child_free') {
    return { amount: originalAmount, originalAmount, isTeamDiscount: false, legacyDiscount: false, partnerVendor: false, partnerGymMember: false };
  }
  const isTeam = isActiveTeamMember(member);
  const teamEligible = isTeam && originalAmount >= TEAM_DISCOUNT_MIN_AMOUNT;
  let amount = originalAmount;
  if (opts.legacyDiscountCard) amount = Math.round(amount * DISCOUNT_CARD_RATE); // 舊折扣卡 8 折
  if (teamEligible) amount = Math.round(amount * PRICES.team_discount_rate);      // 有效隊員再疊 9 折
  // 友館隊員(×rate,預設9折) 與 特約廠商(定額−N) 皆自行出示證明；僅【未套舊折扣卡 且 非有效隊員】且全票/學生票；兩者互斥、友館隊員優先（9折較優）
  let partnerVendor = false;
  let partnerGymMember = false;
  if (!opts.legacyDiscountCard && !teamEligible
      && (entryType === 'single_ticket' || entryType === 'student_free')) {
    if (opts.partnerGymMember) {
      const pg = await getPartnerGymMemberConfig();
      if (pg.enabled && pg.rate > 0 && pg.rate < 1) {
        amount = Math.round(originalAmount * pg.rate);
        partnerGymMember = true;
      }
    } else if (opts.partnerVendor) {
      const pv = await getPartnerVendorConfig();
      if (pv.enabled && pv.discount > 0) {
        amount = Math.max(0, originalAmount - pv.discount);
        partnerVendor = true;
      }
    }
  }
  return {
    amount, originalAmount,
    isTeamDiscount: teamEligible,
    legacyDiscount: !!opts.legacyDiscountCard,
    partnerVendor,
    partnerGymMember,
  };
};

// ── 取得有效定期票 ───────────────────────────────────────────────
// endDate 改用「補償後到期日」（臨時休館延長票期，公休不補）→ 不在 Firestore 端以 endDate 預篩，
// 改抓全部 active 後在程式碼用 effectiveEndDate 判斷（會員 active 票很少，成本可忽略）。
module.exports = { PRICES, DISCOUNT_CARD_RATE, PARTNER_VENDOR_DISCOUNT, PARTNER_GYM_MEMBER_RATE, getPartnerVendorConfig, getPartnerGymMemberConfig, getOriginalEntryPrice, getMemberType, isFreeEntry, getEntryTypePrice, computePaidEntryAmount };
