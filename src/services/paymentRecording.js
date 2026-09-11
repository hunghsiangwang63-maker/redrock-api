/**
 * 收款/現金記帳整併（第二階段）——薄包裝層，不改動底層原語本身：
 *   - `revenueLedger.recordTransaction()` 仍是營收帳本的唯一權威來源。
 *   - `settlementService.addCashAdjustment()` 仍是「今日結帳現金加減項」的唯一寫入點。
 * 這裡只是把「這筆錢的付款方式」講一次、由函式自己決定該不該疊加現金加減項的判斷邏輯
 * 收斂到一處，避免像 2026 年工作坊保證金／器材租借押金那樣，同一種
 * `if (paymentMethod === 'cash') { addCashAdjustment(...) }` 守則在好幾個檔案各自複製一份，
 * 其中一份漏寫就變成真實的記帳錯誤（陳錦漩案例：轉帳付款被無條件當現金記）。
 */
const { addCashAdjustment } = require('./settlementService');

/**
 * 統一「非營收現金/抵押收放」入口——押金/保證金收取退還、confirm 時效補記的現金入帳、
 * 教練費等現金支出，凡是「不透過 recordTransaction() 記營收、而是直接動今日結帳現金加減項」
 * 的情境都走這裡。
 *
 * 只有 paymentMethod==='cash' 才真的寫入（未帶值視同非現金、一律跳過——不向下相容成
 * 「預設當現金」，因為這正是造成過去 bug 的行為，新的呼叫點應該要明確告知付款方式）。
 * 例外：呼叫端明確知道這筆錢「無論如何都是真實現金支出」（例如教練費一定要從抽屜付現，
 * 與這筆收入當初怎麼收款無關）時，可自行固定傳 paymentMethod:'cash'。
 *
 * @returns {{skipped:true, reason}|{added:true, date}} 與 addCashAdjustment 回傳格式一致，
 *   多了 skipped:'NON_CASH'/'INVALID_AMOUNT' 兩種提早結束的原因供呼叫端排查用（非必要，多數呼叫
 *   端目前只是 fire-and-forget 記 log，不特別檢查回傳值）。
 */
async function recordDepositMovement({ gymId, amount, sign = '+', type = '現金補入', note, paymentMethod, targetDate }) {
  if (paymentMethod !== 'cash') return { skipped: true, reason: 'NON_CASH' };
  if (!(Number(amount) > 0)) return { skipped: true, reason: 'INVALID_AMOUNT' };
  return addCashAdjustment({ gymId, amount, sign, type, note, targetDate });
}

/**
 * 統一「收款（營收）」入口——包裝 recordTransaction()。
 *
 * ⚠️ 現況盤點（整併時查證）：目前全站沒有任何一處在同一個收款事件裡「同時」呼叫
 * recordTransaction() 與 addCashAdjustment()——各訂單類型的主要收款（入場/商品/課程費/
 * 比賽費/體驗費/租金）在報名/交易當下只走 recordTransaction()，今日結帳頁的現金統計直接讀
 * 這筆 transactions 的 paymentMethod/totalAmount 算出，不需要再疊加一筆現金加減項（疊加了
 * 反而會重複計算）。既有「確認收款」流程（如課程/比賽轉帳確認、押金收取）走的是另一條路——
 * 營收早在報名時已用 recordTransaction() 認列過，收款確認當下只需要
 * recordDepositMovement() 補記「今天抽屜實際收到現金」這件事，不重新呼叫 recordTransaction()。
 *
 * `alsoRecordCashDrawer` 保留給未來「這筆收款的營收認列日不是今天、需要額外補記今天實際
 * 入帳的現金」這種新情境用——目前沒有任何呼叫端使用這個旗標，是為了讓之後若真的出現這種
 * 需求時，不用再自己重新發明一次「該不該記現金」的判斷式。
 */
async function recordPaymentReceived(db, {
  gymId, orderType, refId, amount, paymentMethod, memberId, memberName,
  notes, staffId, staffName, entryFee, shoesPrice, recognitionDate,
  alsoRecordCashDrawer = false, cashDrawerType,
}) {
  const { recordTransaction } = require('../utils/revenueLedger');
  const txn = await recordTransaction(db, {
    gymId, type: orderType, totalAmount: amount, paymentMethod, memberId, memberName,
    relatedId: refId, notes, staffId, staffName, entryFee, shoesPrice, recognitionDate,
  });
  if (alsoRecordCashDrawer) {
    await recordDepositMovement({ gymId, amount, sign: '+', type: cashDrawerType || '現金補入', note: notes, paymentMethod });
  }
  return txn;
}

module.exports = { recordDepositMovement, recordPaymentReceived };
