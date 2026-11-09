fetch('http://localhost:3000/api/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    full_name: 'Test Person',
    email: 'test' + Date.now() + '@example.com',
    phone: '07' + Math.floor(10000000 + Math.random() * 89999999),
    password: 'Test12345',
    county: 'Nairobi',
    role: 'job_seeker',
    profile: { education: 'Diploma', looking: 'both', skills: ['Python', 'SQL'] }
  })
}).then(async r => console.log(r.status, await r.text()))
  .catch(e => console.error('Could not reach server:', e.message));