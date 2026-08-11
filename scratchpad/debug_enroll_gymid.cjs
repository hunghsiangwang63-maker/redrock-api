const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('/Users/wanghongxiang/Documents/RedRock/憑證/redrock-dev-a35c1-firebase-adminsdk-fbsvc-51b6aca85d.json')) });
const db = admin.firestore();
async function main() {
  const staffSnap = await db.collection('staff').where('email','==','admin@redrock.app').get();
  staffSnap.docs.forEach(d => console.log('staff', d.id, 'gymId:', d.data().gymId, 'role:', d.data().role));
  process.exit(0);
}
main();
