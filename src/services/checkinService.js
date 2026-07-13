/**
 * 入場驗票 Service — 門面（2026-07-13 拆分 refactor）
 * 實作拆至 ./checkin/{pricing,eligibility,gates,verify,flow,cancel}.js；對外 API 與拆分前完全相同。
 * 驗票順序：VIP → 定期券 → 課程入館 → 優惠卡 → 黑卡 → 單次入場券 → 無票
 */
const pricing = require('./checkin/pricing');
const eligibility = require('./checkin/eligibility');
const gates = require('./checkin/gates');
const verify = require('./checkin/verify');
const cancel = require('./checkin/cancel');
const flow = require('./checkin/flow');

module.exports = {
  verifyEntry: verify.verifyEntry,
  createPendingCheckIn: flow.createPendingCheckIn,
  scanQrCode: flow.scanQrCode,
  confirmCheckIn: flow.confirmCheckIn,
  cancelCheckIn: cancel.cancelCheckIn,
  getTodayStats: flow.getTodayStats,
  getValidPasses: eligibility.getValidPasses,
  getCourseAccess: eligibility.getCourseAccess,
  checkFallTest: gates.checkFallTest,
  tryExtendFallTest: gates.tryExtendFallTest,
  checkVip: eligibility.checkVip,
  getValidSingleEntryTickets: eligibility.getValidSingleEntryTickets,
  hasFallTestSignature: gates.hasFallTestSignature,
  checkWaiver: gates.checkWaiver,
  runEntryGates: gates.runEntryGates,
  getMemberType: pricing.getMemberType,
  computePaidEntryAmount: pricing.computePaidEntryAmount,
  revertRenewal: cancel.revertRenewal,
  PRICES: pricing.PRICES,
};
