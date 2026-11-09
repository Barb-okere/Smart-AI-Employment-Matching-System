require('dotenv').config();
['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'].forEach(k =>
  console.log(k.padEnd(12), process.env[k] ? 'set' : 'MISSING'));