const axios = require('axios');
const cheerio = require('cheerio');

async function testScrape() {
    try {
        // Try to scrape a Baltic Dry Index or Freight cost page
        const bdiRes = await axios.get('https://tradingeconomics.com/commodity/baltic', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $bdi = cheerio.load(bdiRes.data);
        const bdiPrice = $bdi('#market_price').text().trim();
        console.log('Baltic Dry Index:', bdiPrice);

        // Try to scrape Jebel Ali Port delay from some generic site
        // If it fails, I'll fallback to a news-based LLM extraction or another source
        const portRes = await axios.get('https://www.searates.com/port/jebel_ali_ae', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $port = cheerio.load(portRes.data);
        console.log('Port page title:', $port('title').text());
        
    } catch (err) {
        console.error('Scrape error:', err.message);
    }
}

testScrape();
