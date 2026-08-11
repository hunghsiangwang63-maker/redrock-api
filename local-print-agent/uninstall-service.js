const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'RedRockPrintAgent',
  script: path.join(__dirname, 'server.js'),
});

svc.on('uninstall', () => {
  console.log('Service removed.');
});

svc.on('error', (err) => {
  console.error('Error:', err);
  console.error('Make sure you are running as Administrator.');
});

svc.uninstall();
