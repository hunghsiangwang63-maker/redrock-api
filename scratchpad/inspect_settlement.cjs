const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('/Users/wanghongxiang/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json')) });
const db = admin.firestore();
async function main() {
  const snap = await db.collection('dailySettlements').where('gymId','==','gym-e2e-test').get();
  console.log('found', snap.docs.length, 'docs for gym-e2e-test');
  snap.docs.forEach(d => {
    const data = d.data();
    console.log('---', d.id, 'date:', data.date, 'status:', data.status);
    (data.deductions||[]).forEach(x => console.log('   ', x.sign, x.type, x.amount, '|', x.note));
  });
  process.exit(0);
}
main();
