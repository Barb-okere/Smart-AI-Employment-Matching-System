const pool = require('./db');

(async () => {
  for (const t of ['users', 'job_seeker_profiles', 'employer_profiles', 'skills', 'job_seeker_skills']) {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
    console.log(t + ':', r.rows.map(x => x.column_name).join(', ') || 'TABLE MISSING');
  }
  await pool.end();
})().catch(err => { console.error('Check failed:', err.message); process.exit(1); });