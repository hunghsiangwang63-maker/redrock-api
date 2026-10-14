// express-validator 驗證結果處理中介層（2026-10-14 由各 route 檔手寫的 19 份抽出，行為各自保留）。
// 兩種回應形狀刻意並存——前端有的頁面會顯示 message，合併成一種會改變畫面上的錯誤文字：
//  - validate：{ error:'VALIDATION_ERROR', details }（原 16 個檔案）
//  - validateWithMessage：另外附 message（欄位: 訊息，以「；」串接）（原 passes / schedule / staff）
const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
  next();
};

const validateWithMessage = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: errors.array().map(e => `${e.path}: ${e.msg}`).join('；'),
      details: errors.array(),
    });
  }
  next();
};

module.exports = { validate, validateWithMessage };
