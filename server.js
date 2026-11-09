
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const pool = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

// Test PostgreSQL connection
app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT current_database() AS database_name, NOW() AS server_time'
    );

    res.json({
      success: true,
      message: 'PostgreSQL connected successfully!',
      database: result.rows[0].database_name,
      serverTime: result.rows[0].server_time
    });
  } catch (err) {
    console.error('Database connection failed:', err.message);
    res.status(500).json({
      success: false,
      message: 'Database connection failed'
    });
  }
});

// Authentication middleware
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in' });
  }
}

// Helpers
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^(?:\+254|254|0)[17]\d{8}$/;

const normalizePhone = (p) =>
  '+254' + String(p).replace(/[\s-]/g, '').replace(/^(?:\+254|254|0)/, '');

// Register
app.post('/api/register', async (req, res) => {
  const {
    full_name,
    email,
    phone,
    password,
    role,
    county,
    profile = {}
  } = req.body || {};

  const name = String(full_name || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  const phoneRaw = String(phone || '').replace(/[\s-]/g, '');

  if (name.length < 2) {
    return res.status(400).json({ error: 'Enter your full name.' });
  }

  if (!EMAIL_RE.test(mail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (!PHONE_RE.test(phoneRaw)) {
    return res.status(400).json({
      error: 'Enter a Kenyan mobile number, like 0712 345 678.'
    });
  }

  if (
    !password ||
    password.length < 8 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    return res.status(400).json({
      error: 'Password needs at least 8 characters, with letters and numbers.'
    });
  }

  if (!['job_seeker', 'employer'].includes(role)) {
    return res.status(400).json({
      error: 'Choose whether you want to find work or hire talent.'
    });
  }

  if (!county) {
    return res.status(400).json({ error: 'Select your county.' });
  }

  let skills = [];

  if (role === 'job_seeker') {
    skills = (Array.isArray(profile.skills) ? profile.skills : [])
      .map(s => String(s).trim().replace(/\s+/g, ' ').slice(0, 30))
      .filter(Boolean)
      .slice(0, 10);

    if (!profile.education) {
      return res.status(400).json({
        error: 'Select your highest education level.'
      });
    }

    if (skills.length === 0) {
      return res.status(400).json({
        error: 'Add at least one skill so we can match you.'
      });
    }
  } else {
    if (String(profile.company || '').trim().length < 2) {
      return res.status(400).json({
        error: 'Enter your company name.'
      });
    }

    if (!profile.sector || !profile.size) {
      return res.status(400).json({
        error: 'Select your sector and company size.'
      });
    }
  }

  const phoneStored = normalizePhone(phoneRaw);
  const client = await pool.connect();

  try {
    const dup = await client.query(
      'SELECT 1 FROM users WHERE phone_number = $1',
      [phoneStored]
    );

    if (dup.rowCount) {
      return res.status(409).json({
        error: 'Email or phone already registered'
      });
    }

    await client.query('BEGIN');

    const hash = await bcrypt.hash(password, 10);

    const u = await client.query(
      `INSERT INTO users
        (full_name, email, phone_number, password_hash, role, account_type)
       VALUES ($1, $2, $3, $4, $5, $6::account_type_enum)
       RETURNING user_id, role, full_name`,
      [name, mail, phoneStored, hash, role, role]
    );

    const user = u.rows[0];

    if (role === 'job_seeker') {
      const sp = await client.query(
        `INSERT INTO job_seeker_profiles
          (user_id, location, education_level, looking_for)
         VALUES ($1, $2, $3, $4)
         RETURNING seeker_id`,
        [user.user_id, county, profile.education, profile.looking || 'both']
      );

      const seekerId = sp.rows[0].seeker_id;

      for (const skillName of skills) {
        let found = await client.query(
          'SELECT skill_id FROM skills WHERE LOWER(skill_name) = LOWER($1)',
          [skillName]
        );

        if (!found.rowCount) {
          found = await client.query(
            'INSERT INTO skills (skill_name) VALUES ($1) RETURNING skill_id',
            [skillName]
          );
        }

        await client.query(
          `INSERT INTO job_seeker_skills (seeker_id, skill_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [seekerId, found.rows[0].skill_id]
        );
      }
    } else {
      await client.query(
        `INSERT INTO employer_profiles
          (user_id, company_name, industry, location, company_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          user.user_id,
          String(profile.company).trim(),
          profile.sector,
          county,
          profile.size
        ]
      );
    }

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.status(201).json({
      token,
      role: user.role,
      name: user.full_name
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Email or phone already registered'
      });
    }

    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Login using email or phone
app.post('/api/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    const id = String(identifier || '').trim().toLowerCase();
    const stripped = id.replace(/[\s-]/g, '');
    const phoneStored = PHONE_RE.test(stripped)
      ? normalizePhone(stripped)
      : null;

    const { rows } = await pool.query(
      `SELECT user_id, full_name, role, password_hash
       FROM users
       WHERE email = $1 OR phone_number = $2
       LIMIT 1`,
      [id, phoneStored]
    );

    const user = rows[0];

    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({
        error: 'Wrong email/phone or password'
      });
    }

    await pool.query(
      'UPDATE users SET last_signed_in = NOW() WHERE user_id = $1',
      [user.user_id]
    );

    const token = jwt.sign(
      { id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      token,
      role: user.role,
      name: user.full_name
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List open jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.*, e.company_name
       FROM jobs j
       JOIN employer_profiles e ON e.employer_id = j.employer_id
       WHERE j.status = 'open'
       ORDER BY j.created_at DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Employers post jobs
app.post('/api/jobs', auth, async (req, res) => {
  if (req.user.role !== 'employer') {
    return res.status(403).json({ error: 'Employers only' });
  }

  const { title, location, description } = req.body || {};

  if (!title || !description) {
    return res.status(400).json({
      error: 'Title and description required'
    });
  }

  try {
    const emp = await pool.query(
      'SELECT employer_id FROM employer_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (!emp.rowCount) {
      return res.status(400).json({
        error: 'Employer profile not found'
      });
    }

    await pool.query(
      `INSERT INTO jobs
        (employer_id, title, description, location, status, published_at)
       VALUES ($1, $2, $3, $4, 'open', NOW())`,
      [emp.rows[0].employer_id, title, description, location || null]
    );

    res.status(201).json({ message: 'Job posted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// CV upload
const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) =>
      cb(
        null,
        Date.now() + '-' +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname)
      )
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.doc', '.docx'].includes(
      path.extname(file.originalname).toLowerCase()
    );

    cb(ok ? null : new Error('Only PDF, DOC or DOCX allowed'), ok);
  }
});

app.post('/api/cv', auth, (req, res) => {
  upload.single('cv')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file received' });
    }

    try {
      await pool.query(
        `INSERT INTO cvs (user_id, original_name, file_path)
         VALUES ($1, $2, $3)`,
        [req.user.id, req.file.originalname, req.file.path]
      );

      res.status(201).json({ message: 'CV uploaded' });
    } catch (dbErr) {
      console.error('CV database error:', dbErr);
      res.status(500).json({ error: 'Could not save CV details' });
    }
  });
});

// Get logged-in user's details
app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id AS id, full_name, email, role, created_at
       FROM users
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* EMPLOYER DASHBOARD API */
app.get('/api/employer/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({
        error: 'This dashboard is for employers only'
      });
    }

    const profileResult = await pool.query(
      `SELECT
         u.user_id,
         u.full_name,
         u.email,
         u.phone_number,
         u.role,
         e.employer_id,
         e.company_name,
         e.industry,
         e.location,
         e.company_size
       FROM users u
       LEFT JOIN employer_profiles e ON e.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.user.id]
    );

    if (!profileResult.rowCount) {
      return res.status(404).json({
        error: 'Employer account not found'
      });
    }

    const row = profileResult.rows[0];

    if (!row.employer_id) {
      return res.status(404).json({
        error: 'Company profile not found for this employer'
      });
    }

    const jobsResult = await pool.query(
      `SELECT
         j.job_id,
         j.title,
         j.location,
         j.status,
         COUNT(a.application_id)::int AS applications_count
       FROM jobs j
       LEFT JOIN applications a ON a.job_id = j.job_id
       WHERE j.employer_id = $1
       GROUP BY j.job_id, j.title, j.location, j.status, j.created_at
       ORDER BY j.created_at DESC`,
      [row.employer_id]
    );

    const jobs = jobsResult.rows;

    const stats = {
      total_jobs: jobs.length,
      active_jobs: jobs.filter(job => job.status === 'open').length,
      draft_jobs: jobs.filter(job => job.status === 'draft').length,
      applications_received: jobs.reduce(
        (total, job) => total + Number(job.applications_count || 0),
        0
      )
    };

    const shortlistedResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM applications a
       JOIN jobs j ON j.job_id = a.job_id
       WHERE j.employer_id = $1
         AND a.status = 'shortlisted'`,
      [row.employer_id]
    );

    stats.shortlisted_candidates = shortlistedResult.rows[0].total;

    res.json({
      user: {
        id: row.user_id,
        fullName: row.full_name,
        full_name: row.full_name,
        email: row.email,
        phone: row.phone_number,
        role: row.role
      },
      profile: {
        employer_id: row.employer_id,
        company_name: row.company_name,
        industry: row.industry,
        location: row.location,
        company_size: row.company_size
      },
      stats,
      jobs
    });
  } catch (err) {
    console.error('Employer dashboard error:', err);
    res.status(500).json({
      error: 'Could not load employer dashboard',
      details: process.env.NODE_ENV === 'development'
        ? err.message
        : undefined
    });
  }
});

/* JOB-SEEKER DASHBOARD API */
app.get('/api/job-seeker/dashboard', auth, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT user_id, full_name, email, role
       FROM users
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (!userResult.rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    if (user.role !== 'job_seeker') {
      return res.status(403).json({
        error: 'This dashboard is for job seekers only'
      });
    }

    const profileResult = await pool.query(
      `SELECT seeker_id, location, education_level, career_level
       FROM job_seeker_profiles
       WHERE user_id = $1`,
      [user.user_id]
    );

    if (!profileResult.rowCount) {
      return res.status(404).json({
        error: 'Job seeker profile not found'
      });
    }

    const profile = profileResult.rows[0];
    const seekerId = profile.seeker_id;

    const statsResult = await pool.query(
      `SELECT
        (
          SELECT COUNT(*)::int
          FROM job_matches jm
          JOIN jobs j ON j.job_id = jm.job_id
          WHERE jm.seeker_id = $1
            AND j.status::text = 'open'
        ) AS ai_matches,
        (
          SELECT COUNT(*)::int
          FROM applications a
          WHERE a.seeker_id = $1
        ) AS applications,
        (
          SELECT COUNT(*)::int
          FROM saved_jobs sj
          WHERE sj.seeker_id = $1
        ) AS saved_jobs,
        (
          SELECT COUNT(*)::int
          FROM job_seeker_skills jss
          WHERE jss.seeker_id = $1
        ) AS skills,
        (
          SELECT COUNT(*)::int
          FROM skill_gaps sg
          WHERE sg.seeker_id = $1
        ) AS skill_gaps`,
      [seekerId]
    );

    const matchesResult = await pool.query(
      `SELECT
         jm.match_id,
         jm.job_id,
         j.title,
         j.location,
         j.workplace_type::text AS workplace_type,
         j.employment_type::text AS employment_type,
         j.published_at,
         e.company_name,
         jm.match_score,
         jm.matching_reason
       FROM job_matches jm
       JOIN jobs j ON j.job_id = jm.job_id
       JOIN employer_profiles e ON e.employer_id = j.employer_id
       WHERE jm.seeker_id = $1
         AND j.status::text = 'open'
       ORDER BY jm.match_score DESC NULLS LAST,
                j.published_at DESC NULLS LAST
       LIMIT 10`,
      [seekerId]
    );

    const gapsResult = await pool.query(
      `SELECT
         sg.gap_id,
         s.skill_name,
         sg.importance::text AS importance,
         sg.gap_type::text AS gap_type,
         sg.recommendation
       FROM skill_gaps sg
       JOIN skills s ON s.skill_id = sg.skill_id
       WHERE sg.seeker_id = $1
       ORDER BY sg.gap_id DESC
       LIMIT 10`,
      [seekerId]
    );

    res.json({
      user: {
        id: user.user_id,
        fullName: user.full_name,
        email: user.email,
        role: user.role
      },
      profile,
      stats: statsResult.rows[0],
      matches: matchesResult.rows,
      skillGaps: gapsResult.rows
    });
  } catch (err) {
    console.error('Job-seeker dashboard error:', err);
    res.status(500).json({
      error: 'Could not load dashboard data'
    });
  }
});

/* GET THE LOGGED-IN JOB SEEKER'S PROFILE */
app.get('/api/job-seeker/profile', auth, async (req, res) => {
  try {
    if (req.user.role !== 'job_seeker') {
      return res.status(403).json({
        error: 'This profile is for job seekers only'
      });
    }

    const result = await pool.query(
      `SELECT
         u.user_id,
         u.full_name,
         u.email,
         u.phone_number,
         u.role,
         p.seeker_id,
         p.location,
         p.bio,
         p.website_url,
         p.portfolio_url,
         p.education_level,
         p.career_level,
         p.availability,
         p.looking_for
       FROM users u
       LEFT JOIN job_seeker_profiles p ON p.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.user.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    const profile = result.rows[0];

    const skillsResult = await pool.query(
      `SELECT
         s.skill_id,
         s.skill_name,
         jss.proficiency_level,
         jss.years_experience
       FROM job_seeker_skills jss
       JOIN skills s ON s.skill_id = jss.skill_id
       WHERE jss.seeker_id = $1
       ORDER BY s.skill_name`,
      [profile.seeker_id]
    );

    res.json({
      ...profile,
      skills: skillsResult.rows
    });
  } catch (err) {
    console.error('Profile loading error:', err);
    res.status(500).json({
      error: 'Could not load profile'
    });
  }
});


/* EMPLOYER DASHBOARD API */
app.get('/api/employer/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'employer') {
      return res.status(403).json({
        error: 'This dashboard is for employers only'
      });
    }

    const profileResult = await pool.query(
      `SELECT
         u.user_id,
         u.full_name,
         u.email,
         u.phone_number,
         u.role,
         e.employer_id,
         e.company_name,
         e.industry,
         e.location,
         e.company_size
       FROM users u
       LEFT JOIN employer_profiles e ON e.user_id = u.user_id
       WHERE u.user_id = $1`,
      [req.user.id]
    );

    if (!profileResult.rowCount) {
      return res.status(404).json({
        error: 'Employer account not found'
      });
    }

    const employer = profileResult.rows[0];

    if (!employer.employer_id) {
      return res.status(404).json({
        error: 'Company profile not found'
      });
    }

    const jobsResult = await pool.query(
      `SELECT
         j.job_id,
         j.title,
         j.location,
         j.status,
         j.created_at,
         COUNT(a.application_id)::int AS applications_count
       FROM jobs j
       LEFT JOIN applications a ON a.job_id = j.job_id
       WHERE j.employer_id = $1
       GROUP BY j.job_id, j.title, j.location, j.status, j.created_at
       ORDER BY j.created_at DESC`,
      [employer.employer_id]
    );

    const jobs = jobsResult.rows;

    const shortlistedResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM applications a
       JOIN jobs j ON j.job_id = a.job_id
       WHERE j.employer_id = $1
         AND a.status = 'shortlisted'`,
      [employer.employer_id]
    );

    const stats = {
      total_jobs: jobs.length,
      active_jobs: jobs.filter(job => job.status === 'open').length,
      draft_jobs: jobs.filter(job => job.status === 'draft').length,
      applications_received: jobs.reduce(
        (total, job) =>
          total + Number(job.applications_count || 0),
        0
      ),
      shortlisted_candidates: shortlistedResult.rows[0].total
    };

    return res.json({
      user: {
        id: employer.user_id,
        fullName: employer.full_name,
        full_name: employer.full_name,
        email: employer.email,
        phone: employer.phone_number,
        role: employer.role
      },
      profile: {
        employer_id: employer.employer_id,
        company_name: employer.company_name,
        industry: employer.industry,
        location: employer.location,
        company_size: employer.company_size
      },
      stats,
      jobs
    });
  } catch (err) {
    console.error('Employer dashboard error:', err);

    return res.status(500).json({
      error: 'Could not load employer dashboard',
      details: process.env.NODE_ENV === 'development'
        ? err.message
        : undefined
    });
  }
});


app.listen(PORT, () => {
  console.log('SkillMatch AI Running on http://localhost:' + PORT);
});
