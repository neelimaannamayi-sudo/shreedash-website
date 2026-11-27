// Usage: npm run hash-password -- "your-strong-password"
const bcrypt = require('bcryptjs');
const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error('Please pass a password of at least 10 characters, e.g. npm run hash-password -- "MyStr0ngPassw0rd!"');
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
