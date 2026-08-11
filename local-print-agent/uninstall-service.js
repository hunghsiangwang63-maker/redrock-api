// 移除 install-service.js 裝的 Windows 背景服務（同樣需要「系統管理員身分」執行）。
// 移除後代理不會再自動於背景執行，需改回手動雙擊 start.bat 或重新設定「啟動」資料夾捷徑。
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'RedRockPrintAgent',
  script: path.join(__dirname, 'server.js'),
});

svc.on('uninstall', () => {
  console.log('✅ 服務已移除。exists =', svc.exists);
});
svc.on('error', (err) => {
  console.error('❌ 移除失敗：', err);
  console.error('   常見原因：沒有用「系統管理員身分」執行這個指令，請重新以 admin 開命令提示字元再試一次。');
});

svc.uninstall();
