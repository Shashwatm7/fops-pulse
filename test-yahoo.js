import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function run() {
  const symbols = ['ZW=F', 'ZC=F', 'ZS=F', 'ZR=F', 'SB=F', 'KC=F', 'CC=F', 'GF=F', 'BZ=F', 'NG=F', 'FCPO.KL', 'DC=F'];
  try {
    const quotes = await yahooFinance.quote(symbols);
    for (const q of quotes) {
      console.log(q.symbol, q.regularMarketPrice);
    }
  } catch(e) {
    console.log("Err:", e);
  }
}
run();
