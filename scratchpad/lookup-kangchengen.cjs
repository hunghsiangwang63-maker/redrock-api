const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const credDir = '/Users/wanghongxiang/Documents/RedRock/憑證';
const credFile = fs.readdirSync(credDir).find(f => f.endsWith('.json'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(credDir, credFile))) });
const db = admin.firestore();

const NAMES = ['康晟恩', '張毓恩'];

(async () => {
  for (const name of NAMES) {
    console.log('\n\n########', name, '########');
    const membersSnap = await db.collection('members').where('name', '==', name).get();
    console.log('會員數:', membersSnap.size);
    for (const md of membersSnap.docs) {
      const memberId = md.id;
      console.log('=== memberId:', memberId, md.data().phone, 'parentMemberId:', md.data().parentMemberId, '===');

      // 試上/體驗預約
      const bookSnap = await db.collection('experienceBookings').where('memberId', '==', memberId).get();
      console.log('experienceBookings 筆數:', bookSnap.size);
      bookSnap.forEach(bd => {
        const b = bd.data();
        console.log('--- booking', bd.id, '---');
        console.log('courseType/isTrial:', b.courseType, b.isTrial, '| gymId:', b.gymId, '| bookingDate:', b.bookingDate,
          '| paymentMethod:', b.paymentMethod, '| paymentStatus:', b.paymentStatus, '| bankName:', b.bankName, '| bankLastFive:', b.bankLastFive,
          '| status:', b.status);
      });

      // 課程報名
      const regSnap = await db.collection('courseRegistrations').where('memberId', '==', memberId).get();
      console.log('courseRegistrations 筆數:', regSnap.size);
      regSnap.forEach(rd => {
        const r = rd.data();
        console.log('--- reg', rd.id, '---');
        console.log('courseName:', r.courseName, '| gymId:', r.gymId, '| paymentMethod:', r.paymentMethod, '| bankLastFive:', r.bankLastFive);
      });

      // transferRecords（實際填的匯款銀行名稱）
      const trSnap = await db.collection('transferRecords').where('memberId', '==', memberId).get();
      console.log('transferRecords 筆數:', trSnap.size);
      trSnap.forEach(td => {
        const t = td.data();
        console.log('--- transferRecord', td.id, '---');
        console.log('orderType:', t.orderType, '| orderName:', t.orderName, '| gymId:', t.gymId, '| bankName:', t.bankName, '| bankLastFive:', t.bankLastFive, '| amount:', t.amount, '| status:', t.status);
      });
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
