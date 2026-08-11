// 把發票列印代理裝成 Windows 背景服務（開機自動啟動、不需登入帳號、視窗被關掉/當機會自動重開）。
// 比起「傳送到啟動資料夾」那個不需要 admin 的簡易做法（見 README 第四步），這個方式更穩，
// 但**必須用系統管理員權限執行**（右鍵「以系統管理員身分執行」開命令提示字元/PowerShell 再跑這支）。
//
// 用法：
//   1. 以系統管理員身分開命令提示字元，cd 到這個資料夾
//   2. npm install（若還沒裝過依賴）
//   3. node install-service.js
//   服務會自動啟動；之後每次開機（不需登入）就會在背景默默執行，沒有黑色視窗。
//
// 要移除服務改回原本的手動啟動方式，跑 node uninstall-service.js（同樣需要 admin 權限）。
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'RedRockPrintAgent', // Windows 服務內部名稱，維持英數字（服務清單/sc.exe 對中文名支援不穩定）
  description: '紅石攀岩館 WinPOS WP-560 發票機本地列印代理（http://localhost:3399）',
  script: path.join(__dirname, 'server.js'),
});

svc.on('install', () => {
  console.log('✅ 服務安裝完成，正在啟動...');
  svc.start();
});
svc.on('alreadyinstalled', () => {
  console.log('此服務已經裝過了。若要重新設定，請先跑 node uninstall-service.js 移除後再重裝。');
});
svc.on('start', () => {
  console.log('✅ 服務已啟動，之後開機會自動在背景執行（不需登入帳號、無黑色視窗）。');
  console.log('   可到「服務」(services.msc) 或 http://localhost:3399/status 確認運作狀態。');
});
svc.on('error', (err) => {
  console.error('❌ 安裝或啟動失敗：', err);
  console.error('   常見原因：沒有用「系統管理員身分」執行這個指令，請重新以 admin 開命令提示字元再試一次。');
});

svc.install();
