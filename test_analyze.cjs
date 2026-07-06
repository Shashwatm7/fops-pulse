const http = require('http');

const postData = JSON.stringify({
  email: 'test@test.com',
  password: 'password123'
});

const req = http.request({
  hostname: 'localhost',
  port: 3001,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Login response:', data);
    const cookie = res.headers['set-cookie'];
    if (cookie) {
      const analyzeReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/api/analyze',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie
        }
      }, (analyzeRes) => {
        let aData = '';
        analyzeRes.on('data', chunk => aData += chunk);
        analyzeRes.on('end', () => {
          console.log('Analyze response status:', analyzeRes.statusCode);
          console.log('Analyze response:', aData.substring(0, 500));
        });
      });
      analyzeReq.write(JSON.stringify({}));
      analyzeReq.end();
    }
  });
});

req.write(postData);
req.end();
