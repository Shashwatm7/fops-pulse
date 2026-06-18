const axios = require('axios');
const http = require('http');

async function test() {
  const client = axios.create({
    baseURL: 'http://localhost:3001',
    withCredentials: true,
  });

  // 1. Login
  let res = await client.post('/api/auth/login', { email: 'admin@fops.com', password: 'admin' });
  const cookie = res.headers['set-cookie'];
  console.log('Login success:', res.data.user.username);

  // 2. Track new
  res = await client.post('/api/track', { symbol: 'TEST_LITHIUM', ticker: 'LITHIUM.L', name: 'Lithium' }, {
    headers: { Cookie: cookie }
  });
  console.log('Track response:', res.data);

  // 3. Get profile
  res = await client.get('/api/auth/me', { headers: { Cookie: cookie } });
  console.log('Profile commodities:', res.data.profile.commodities);
}
test().catch(console.error);
