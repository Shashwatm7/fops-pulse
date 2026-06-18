import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance();
async function check() {
    const symbols = ['BZ=F', 'CL=F'];
    const quotes = await yahooFinance.quote(symbols);
    for (const q of quotes) {
        console.log(`${q.symbol}: ${q.regularMarketPrice}`);
    }
}
check();
