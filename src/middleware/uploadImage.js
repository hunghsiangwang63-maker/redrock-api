// 圖片上傳（multer 記憶體儲存；圖檔一律內嵌 base64 存 Firestore，不走 Firebase Storage，見 memory）。
// 由 gyms / courses / courseCategories / memberReminders 各自手寫的 multer 設定抽出（2026-10-14）。
// 上限刻意分兩檔：uploadImage＝10MB（原 gyms/courses/courseCategories）；uploadImage5MB＝5MB（原 memberReminders）。
const multer = require('multer');
const makeMemoryUpload = (mb) => multer({ storage: multer.memoryStorage(), limits: { fileSize: mb * 1024 * 1024 } });
module.exports = { makeMemoryUpload, uploadImage: makeMemoryUpload(10), uploadImage5MB: makeMemoryUpload(5) };
