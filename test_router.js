import { getDynamicContext } from './services/recommendations/context_router.js';

async function test() {
    const ctx = await getDynamicContext('Dairy', 'UAE');
    console.log(JSON.stringify(ctx, null, 2));
}

test();
