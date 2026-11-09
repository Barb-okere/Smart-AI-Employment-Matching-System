fetch('http://localhost:3000/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'PASTE_EMAIL_HERE', password: 'Test12345' })
}).then(async r => console.log(r.status, await r.text()));