const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'RedRockPrintAgent',
  description: 'Redrock WinPOS WP-560 Print Agent (localhost:3399)',
  script: path.join(__dirname, 'server.js'),
});

svc.on('install', () => {
  console.log('Service installed, starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Service already installed.');
});

svc.on('start', () => {
  console.log('Service started. Will auto-run on boot.');
});

svc.on('error', (err) => {
  console.error('Error:', err);
  console.error('Make sure you are running as Administrator.');
});

svc.install();
