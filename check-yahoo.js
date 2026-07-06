import YahooFinance from 'yahoo-finance2';
import { ALL_COMMODITIES } from './onboarding-templates.js';

async function check() {
    console.log("Checking Yahoo Finance for commodities...");
    for (const c of ALL_COMMODITIES) {
        try {
            const results = await YahooFinance.search(c.label + " Futures");
            if (results.quotes && results.quotes.length > 0) {
                console.log(`[OK] ${c.key}: ${results.quotes[0].symbol}`);
            } else {
                console.log(`[NOT FOUND] ${c.key}`);
            }
        } catch (e) {
            console.log(`[ERROR] ${c.key}`);
        }
    }
}
check();
