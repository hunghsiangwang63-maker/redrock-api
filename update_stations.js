const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const path = require('path');

const serviceAccount = require(path.join(process.env.HOME, 'Downloads/redrock-dev-a35c1-firebase-adminsdk-fbsvc-94b5c692f3.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  // 1. 更新新竹館站台帳號
  const hcSnap = await db.collection('stations').where('gymId', '==', 'gym-hsinchu').get();
  const hcHash = await bcrypt.hash('hsinchu2026', 10);
  if (!hcSnap.empty) {
    await hcSnap.docs[0].ref.update({
      email: 'redrocktaiwan.hc@gmail.com',
      passwordHash: hcHash,
      updatedAt: new Date(),
    });
    console.log('✅ 新竹館站台帳號已更新');
  } else {
    await db.collection('stations').add({
      email: 'redrocktaiwan.hc@gmail.com',
      passwordHash: hcHash,
      gymId: 'gym-hsinchu',
      name: '新竹館站台',
      active: true,
      createdAt: new Date(),
    });
    console.log('✅ 新竹館站台帳號已建立');
  }

  // 2. 建立/更新士林館站台帳號
  const slSnap = await db.collection('stations').where('gymId', '==', 'gym-shilin').get();
  const slHash = await bcrypt.hash('shilin2026', 10);
  if (!slSnap.empty) {
    await slSnap.docs[0].ref.update({
      email: 'redrocktaiwan@gmail.com',
      passwordHash: slHash,
      updatedAt: new Date(),
    });
    console.log('✅ 士林館站台帳號已更新');
  } else {
    await db.collection('stations').add({
      email: 'redrocktaiwan@gmail.com',
      passwordHash: slHash,
      gymId: 'gym-shilin',
      name: '士林館站台',
      active: true,
      createdAt: new Date(),
    });
    console.log('✅ 士林館站台帳號已建立');
  }

  console.log('\n帳號資訊：');
  console.log('新竹館：redrocktaiwan.hc@gmail.com / hsinchu2026');
  console.log('士林館：redrocktaiwan@gmail.com / shilin2026');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
