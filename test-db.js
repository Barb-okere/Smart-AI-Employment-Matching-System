const pool = require('./db');

pool.query('SELECT NOW()')
  .then(r => { console.log('Connected!', r.rows[0]); process.exit(); })
  .catch(e => { console.error('Connection failed:', e.message); process.exit(1); });