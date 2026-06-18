const yf = require('yahoo-finance2').default;
async function run() {
  try {
    const quote = await yf.quote('ZW=F');
    console.log(quote.regularMarketPrice);
  } catch(e) { console.log(e); }
}
run();
