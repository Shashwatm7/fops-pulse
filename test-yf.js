import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function run() {
    try {
        console.log("Testing historical 1d...");
        const hist1d = await yahooFinance.historical('BZ=F', { period1: '2026-06-01', interval: '1d' });
        console.log("Historical 1d success! Length:", hist1d.length);
    } catch (e) {
        console.log("Historical 1d error:", e.message);
    }

    try {
        console.log("Testing historical 15m...");
        const hist15m = await yahooFinance.historical('BZ=F', { period1: '2026-06-01', interval: '15m' });
        console.log("Historical 15m success!", hist15m.length);
    } catch (e) {
        console.log("Historical 15m error:", e.message);
    }

    try {
        console.log("Testing chart 15m...");
        const chart15m = await yahooFinance.chart('BZ=F', { period1: '2026-06-01', interval: '15m' });
        console.log("Chart 15m success! Quotes:", chart15m.quotes.length);
    } catch (e) {
        console.log("Chart 15m error:", e.message);
    }
}
run();
