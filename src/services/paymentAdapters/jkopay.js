/**
 * 街口支付 JKOPAY Online Pay Adapter（依 https://open-doc.jkos.com 公開文件實作）
 *
 * 流程：createPayment → 呼叫「訂單創建 Entry API」(POST /platform/entry) 取得 payment_url（導轉）→
 *       使用者付款 → 街口以 result_url 通知我方（server-to-server webhook）→
 *       verifyCallback **不信任 callback body 內容**（公開文件未記載 result_url 的簽章驗證方式），
 *       改主動呼叫「訂單查詢 Inquiry API」(GET /platform/inquiry，自己重新簽章) 核對
 *       status===0（交易成功）且金額相符，才算成功——比照 LinePay adapter 呼叫 Confirm API 的
 *       「後端權威」精神：金額永遠以我方 payment 文件為準，絕不信任任何外部輸入。
 *
 * ⚠️ 金鑰來源：各「館別」不同 → 從 gymSettings 取（存於 gyms/{gymId}.paymentSettings）
 *      gymSettings.jkoPayStoreId  （商店編號 store_id，隨 body 送出）
 *      gymSettings.jkoPayApiKey   （商店串接金鑰，隨 api-key header 送出；與 store_id 是不同的兩組值）
 *      gymSettings.jkoPaySecret   （商店通路密鑰，僅用於 HMAC 簽章計算，絕不外傳/不出現在任何 request）
 *
 * ⚠️ API Host 未公開：街口官方文件（訂單創建 Entry API 頁）明確寫「[HOST] 需替換為商家環境專屬網域」，
 *    不像 LINE Pay 有公開的 sandbox-api-pay.line.me / api-pay.line.me 通用網域——街口的 API Host
 *    是簽訂特約商店合約後，隨「商家整合手冊」一併提供，須設定環境變數 JKOPAY_API_HOST。
 *    （BASE_URL 未設定時任何呼叫皆丟 JKOPAY_HOST_NOT_CONFIGURED，不會用假網域發出真實請求。）
 *
 * 簽章規則（https://open-doc.jkos.com「加簽加密說明」，非猜測、逐字對照官方文件）：
 *   digest（header）= hex( HMAC-SHA256( payload, secret ) )　── 十六進位字串，非 base64（與 LinePay 不同）
 *   POST/PUT/PATCH：payload = 完整 JSON body 字串（原樣序列化，未另做 canonicalize）
 *   GET            ：payload = query string（不含開頭 "?"），如 "platform_order_ids=a,b"
 *
 * 已對照官方文件確認的 API：
 *   POST /platform/entry    訂單創建 Entry API（建立付款連結）
 *   GET  /platform/inquiry  訂單查詢 Inquiry API（server 端主動核對交易狀態，供 verifyCallback 用）
 *   POST /platform/refund   訂單退款 API（refundPayment，2026-08-18 補上——街口 UAT 驗收腳本明確要求
 *     附上 1 筆退款訂單 log 才能過審）。⚠️ 此函式**尚未掛進 paymentService 的業務流程**（本專案線上金流
 *     退款目前一律走既有手動退費/加減項機制，沒有 API 直接退款的使用者操作入口）——僅供街口驗測腳本，
 *     以及未來若要真正接上「線上退款」使用者流程時使用。（confirm_url 為選填的「付款前驗證」webhook，未接。）
 *
 * result 代碼（頂層 result 欄位，非交易狀態）：000=成功、100=Invalid Order ID、101=Order is paid、
 *   200=Bad request、999=Internal Error……完整列表見官方文件「代碼意義 API Response Code」。
 * 交易狀態（result_object.transactions[].status，Inquiry API 專用，與上方 result 代碼是不同的兩組值）：
 *   0=交易成功、100=付款失敗、101=訂單尚未付款、102=訂單編號不存在。
 *
 * 上線待辦：
 *   1. 各館完成街口特約商店申請，取得 store_id / api-key / secret，填入 gyms/{gymId}.paymentSettings
 *   2. 設定環境變數 JKOPAY_API_HOST（街口合約會附上此 API Host，公開文件未列出通用網域）
 *      ⚠️ 2026-08-18 UAT 驗收期間曾暫時設為 https://uat-onlinepay.jkopay.app 供測試，驗收後已改回未設定
 *      （不留 sandbox host 卡在正式環境）——正式串接前記得改設**正式環境**的 Host（驗收通過後街口會另外提供）。
 *   3. sandbox 端到端測試（Entry→付款→result_url 觸發→Inquiry 核對 status===0）後，
 *      於系統設定「付款方式」開啟 jkopay（GET/PUT /settings/payment-methods）
 *
 * 參考：https://open-doc.jkos.com/?docs=線上支付onlinepay（訂單創建/查詢 API、加簽加密說明、API Response Code）
 */
const crypto = require('crypto');
const dayjs = require('dayjs');

const BASE_URL = process.env.JKOPAY_API_HOST || null; // 街口無公開通用網域，須由合約取得後設定

// digest = hex(HMAC-SHA256(payload, secret))
function sign(secret, payloadStr) {
  return crypto.createHmac('sha256', secret).update(payloadStr, 'utf8').digest('hex');
}

function creds(gymSettings) {
  const storeId = gymSettings?.jkoPayStoreId;
  const apiKey = gymSettings?.jkoPayApiKey;
  const secret = gymSettings?.jkoPaySecret;
  if (!storeId || !apiKey || !secret) {
    throw { code: 'JKOPAY_NOT_CONFIGURED', message: '此館尚未設定街口支付商戶金鑰（店號/API金鑰/密鑰三者缺一不可）' };
  }
  if (!BASE_URL) {
    throw { code: 'JKOPAY_HOST_NOT_CONFIGURED', message: '尚未設定街口支付 API Host（環境變數 JKOPAY_API_HOST，需向街口特約商店合約取得）' };
  }
  return { storeId, apiKey, secret };
}

// 街口 API 統一回應格式：{ result, message, result_object }；result==='000' 才算成功。
async function callApi(method, path, opts) {
  return (await callApiRaw(method, path, opts)).data;
}

// 與 callApi 相同，但額外回傳實際送出的 request body 字串——供街口驗測腳本需要的
// 「LOG request / LOG response」逐字記錄用（一般業務流程不需要，只有 callApi 走公開 exports）。
async function callApiRaw(method, path, { apiKey, secret, bodyObj, queryStr }) {
  const isGet = method === 'GET';
  const payloadStr = isGet ? (queryStr || '') : JSON.stringify(bodyObj || {});
  const digest = sign(secret, payloadStr);
  const url = isGet ? `${BASE_URL}${path}?${queryStr}` : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey, digest },
    body: isGet ? undefined : payloadStr,
  });
  const data = await res.json();
  return { data, requestBody: isGet ? queryStr : bodyObj, digest };
}

module.exports = {
  // 建立付款：呼叫訂單創建 Entry API，回傳導轉用 payment_url；providerTxnId 暫用我方 orderId
  // （街口側單號 tradeNo 要等交易成功、由 Inquiry API 查得才有值，於 verifyCallback 補上）。
  async createPayment({ orderId, amount, productName, returnUrls, gymSettings }) {
    const { storeId, apiKey, secret } = creds(gymSettings);
    const roundedAmount = Math.round(amount); // total_price/final_price 為整數(no decimals)，TWD 本無小數
    const body = {
      platform_order_id: orderId,
      store_id: storeId,
      currency: 'TWD',
      total_price: roundedAmount,
      final_price: roundedAmount,
      // ⚠️ 依街口 UAT 驗測腳本「注意事項」第13項明確要求：unredeem 務必帶 0（非省略不帶）——
      // 該欄位設計是給法規不可行銷商品（如香菸）排除街口幣/街口券折抵用，帶錯/漏帶會影響用戶的
      // 街口幣回饋資格。本專案商品皆可折抵，故固定帶 0（不設不可折抵金額）。
      unredeem: 0,
      // 對齊 payments 文件本身的 15 分鐘效期（paymentService.createPayment 的 expiresAt）
      valid_time: dayjs().add(15, 'minute').format('YYYY-MM-DD HH:mm:ss'),
      // 街口以此 server-to-server 通知付款結果；orderId 帶在 query 供 extractOrderId 取用（不需金鑰即可解析）
      result_url: `${returnUrls?.confirmUrl || (process.env.API_URL || 'https://api.redrocktaiwan.com') + '/payments/jkopay/callback'}?platform_order_id=${orderId}`,
      // 使用者付款後瀏覽器導回此頁（成功/失敗共用同一頁；實際結果一律由 result_url→Inquiry API 權威核對後才生效，
      // 此頁僅供使用者返回 App，比照 LinePay adapter 用 cancelUrl 當「返回頁」的既有慣例）
      result_display_url: returnUrls?.cancelUrl || `${process.env.CLIENT_URL || 'https://app.redrocktaiwan.com'}/payment/cancel`,
      products: [{ name: productName || '紅石攀岩館', price: roundedAmount, quantity: 1 }],
    };
    const data = await callApi('POST', '/platform/entry', { apiKey, secret, bodyObj: body });
    if (data.result !== '000') {
      throw { code: 'JKOPAY_REQUEST_FAILED', message: data.message || `街口支付建立付款失敗（代碼 ${data.result}）` };
    }
    return {
      paymentUrl: data.result_object?.payment_url,
      providerTxnId: orderId,
    };
  },

  // 街口呼叫 result_url 時把我方 platform_order_id 帶在 query（見 createPayment 組的 URL），取出即可、不需金鑰
  extractOrderId(req) {
    return req.query?.platform_order_id || req.body?.platform_order_id || null;
  },

  // ⚠️ 街口公開文件未記載 result_url callback 的簽章驗證方式——不信任 callback body，
  //    改主動呼叫 Inquiry API（自己重新簽章）核對 status===0 且金額相符，才算成功。
  async verifyCallback(req, gymSettings, payment) {
    const { apiKey, secret } = creds(gymSettings);
    const orderId = this.extractOrderId(req) || payment?.id;
    if (!orderId) return { success: false, raw: { reason: 'NO_ORDER_ID' } };

    const queryStr = `platform_order_ids=${orderId}`;
    const data = await callApi('GET', '/platform/inquiry', { apiKey, secret, queryStr });
    if (data.result !== '000') {
      return { success: false, raw: { result: data.result, message: data.message } };
    }
    const tx = (data.result_object?.transactions || []).find(t => t.platform_order_id === orderId);
    if (!tx) return { success: false, raw: { reason: 'TRANSACTION_NOT_FOUND' } };

    // final_price 為字串型別，轉數字後與我方權威金額（payment.amount）核對，避免任何外部竄改
    const amountMatches = Number(tx.final_price) === Number(payment.amount);
    return {
      success: tx.status === 0 && amountMatches,
      providerTxnId: tx.tradeNo || orderId,
      raw: { status: tx.status, tradeNo: tx.tradeNo, final_price: tx.final_price, amountMatches },
    };
  },

  // 訂單退款：呼叫「訂單退款 Refund API」。支援全額/部分退款、可分多次退款，但單筆訂單累積退款金額
  // 不可超過訂單實際消費金額（街口端會擋，本函式不重複驗證）。⚠️ 尚未掛進 paymentService 業務流程，
  // 見檔頭說明——本專案線上金流退款目前一律走既有手動退費/加減項機制。
  async refundPayment({ platformOrderId, refundOrderId, refundAmount, gymSettings }) {
    const { apiKey, secret } = creds(gymSettings);
    const { v4: uuidv4 } = require('uuid');
    const body = {
      platform_order_id: platformOrderId,
      refund_order_id: refundOrderId || uuidv4(),
      refund_amount: Math.round(refundAmount),
    };
    const data = await callApi('POST', '/platform/refund', { apiKey, secret, bodyObj: body });
    if (data.result !== '000') {
      throw { code: 'JKOPAY_REFUND_FAILED', message: data.message || `街口支付退款失敗（代碼 ${data.result}）` };
    }
    return {
      refundTradeNo: data.result_object?.refund_tradeNo,
      debitAmount: data.result_object?.debit_amount,
      redeemAmount: data.result_object?.redeem_amount,
      refundTime: data.result_object?.refund_time,
      raw: data,
    };
  },

  // ── 診斷/驗測專用（非業務流程使用）：暴露 creds() 與帶 requestBody 回傳的 callApiRaw()，
  //    供街口 UAT 驗測腳本需要的「逐字 LOG request / LOG response」擷取用。──────────────
  _creds: creds,
  _callApiRaw: callApiRaw,
};
