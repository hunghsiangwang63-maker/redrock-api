// Firestore 時間欄位轉 JS Date（Timestamp / 序列化後的 {_seconds} / 字串數字 / 空值→null）。
// 由 loginLock、cardTransferService、ghostAccountService 三份相同實作抽出（2026-10-14）。
// ⚠️ deviceAuthService 的 toDate 語意不同（非 Timestamp 時原樣回傳、不轉 Date、無 null），刻意不用這份。
const toDate = (v) => (v?.toDate ? v.toDate() : (v?._seconds ? new Date(v._seconds * 1000) : (v ? new Date(v) : null)));
module.exports = { toDate };
