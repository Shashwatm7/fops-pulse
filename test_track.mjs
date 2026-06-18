import axios from 'axios';

async function test() {
  const client = axios.create({
    baseURL: 'http://localhost:3001',
    withCredentials: true,
  });

  // 1. Login
  let res = await client.post('/api/auth/login', { email: 'admin@fops.com', password: 'admin' }).catch(e => e.response);
  if (!res || !res.headers) {
    console.log("Login failed");
    return;
  }
  const cookie = res.headers['set-cookie'];
  console.log('Login success:', res.data.user.username);

  // 2. Track new
  res = await client.post('/api/track', { symbol: 'TEST_LITHIUM', ticker: 'LITHIUM.L', name: 'Lithium' }, {
    headers: { Cookie: cookie }
  }).catch(e => e.response);
  console.log('Track response:', res.data);

  // 3. Get profile
  res = await client.get('/api/auth/me', { headers: { Cookie: cookie } }).catch(e => e.response);
  console.log('Profile commodities:', res.data.profile.commodities);
}
test().catch(console.error);
