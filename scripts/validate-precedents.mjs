// Validates every HISTORICAL_EVENTS entry against real Yahoo history.
// Run: node scripts/validate-precedents.mjs
// An entry PASSES when its primary commodity has real daily bars around
// the event date (data exists) — and the printed aftermath lets a human
// sanity-check that the date is right. Use before committing new events.
import YahooFinance from 'yahoo-finance2';
import { HISTORICAL_EVENTS, computeAftermath } from '../services/precedent-engine.js';
import { ALL_COMMODITIES } from '../onboarding-templates.js';

const YS = Object.fromEntries(ALL_COMMODITIES.map(c => [c.key, c.yahooSymbol]));
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false } });

let pass = 0, fail = 0;
for (const e of HISTORICAL_EVENTS) {
    const symbol = e.commodities[0];
    try {
        const p1 = new Date(e.date); p1.setDate(p1.getDate() - 10);
        const p2 = new Date(e.date); p2.setDate(p2.getDate() + 100);
        const chart = await yf.chart(YS[symbol], { period1: p1, period2: p2, interval: '1d' });
        const cents = chart.meta?.currency === 'USX';
        const bars = (chart.quotes || []).filter(q => q.close != null)
            .map(q => ({ date: q.date, close: cents ? q.close / 100 : q.close }));
        const a = computeAftermath(bars, e.date);
        if (!a || bars.length < 40) {
            fail++;
            console.log(`FAIL  ${e.id.padEnd(28)} ${symbol.padEnd(12)} bars=${bars.length} (no usable window)`);
            continue;
        }
        // Dead-series check: a thinly traded contract can "have bars" that
        // barely move (e.g. CME aluminum in 2018 while LME spiked 30%).
        // Reporting that flat line as the aftermath would be false history.
        let zeroDays = 0;
        for (let i = 1; i < bars.length; i++) {
            if (bars[i].close === bars[i - 1].close) zeroDays++;
        }
        if (zeroDays / (bars.length - 1) > 0.4) {
            fail++;
            console.log(`FAIL  ${e.id.padEnd(28)} ${symbol.padEnd(12)} stale series (${Math.round(zeroDays / (bars.length - 1) * 100)}% flat days)`);
            continue;
        }
        pass++;
        const fmt = v => (v == null ? '  n/a' : `${v >= 0 ? '+' : ''}${v}%`.padStart(6));
        console.log(`ok    ${e.id.padEnd(28)} ${symbol.padEnd(12)} 30d=${fmt(a.pct30)} 90d=${fmt(a.pct90)} extreme=${fmt(a.extremePct)}@d${a.daysToExtreme}`);
    } catch (err) {
        fail++;
        console.log(`FAIL  ${e.id.padEnd(28)} ${symbol.padEnd(12)} ${err.message.slice(0, 40)}`);
    }
}
console.log(`\n${pass} passed, ${fail} failed of ${HISTORICAL_EVENTS.length}`);
process.exit(fail > 0 ? 1 : 0);
