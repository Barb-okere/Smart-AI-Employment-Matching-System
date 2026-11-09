const pool = require('./db');

(async () => {
  const r = await pool.query(
    'SELECT user_id, full_name, email, phone_number, role, created_at FROM users ORDER BY user_id');
  console.table(r.rows);
  const db = await pool.query('SELECT current_database() AS db');
  console.log('Connected to database:', db.rows[0].db);
  await pool.end();
})().catch(err => { console.error(err.message); process.exit(1); });