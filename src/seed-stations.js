/**
 * 建立館別電腦帳號
 * 執行：node src/seed-stations.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { initFirebase, getDb } = require('./config/firebase');

async function seedStations() {
  initFirebase();
  const db = getDb();

  const stations = [
    {
      id: 'station-hsinchu',
      name: '新竹館電腦',
      email: 'hsinchu@redrock.app',
      password: 'hsinchu2026',
      gymId: 'gym-hsinchu',
      gymName: '紅石攀岩館 新竹館',
      isActive: true,
    },
    {
      id: 'station-zhubei',
      name: '竹北館電腦',
      email: 'zhubei@redrock.app',
      password: 'zhubei2026',
      gymId: 'gym-zhubei',
      gymName: '紅石攀岩館 竹北館',
      isActive: true,
    },
  ];

  for (const s of stations) {
    const { id, password, ...data } = s;
    const passwordHash = await bcrypt.hash(password, 10);
    await db.collection('stations').doc(id).set({
      ...data,
      passwordHash,
      createdAt: new Date(),
      lastLoginAt: null,
    });
    console.log(`✅ 建立 ${s.name}（${s.email} / ${s.password}）`);
  }

  console.log('\n完成！電腦帳號已建立。');
  process.exit(0);
}

seedStations().catch(e => { console.error(e); process.exit(1); });
