import axios from 'axios';
import * as cheerio from 'cheerio';
import nlp from 'compromise';
import natural from 'natural';

// Realistic browser headers for PUBLISHER article fetches. Publisher sites
// (and CDNs like Cloudflare/PerimeterX) block bare/skeleton UAs far more
// aggressively from datacenter IPs (Render) than from residential ones — a
// full header set with a Google News referer raises the success rate there.
// Do NOT use these on Google's own endpoints: Google 403s the faked
// Sec-Fetch/Referer combination (verified), while a minimal UA works.
const GOOGLE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://news.google.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
};

// ── Google News redirect resolution ──
// RSS <link>s are news.google.com/rss/articles/CBMi... wrappers, NOT the real
// article URL. Fetching them returns a JS redirect shell with no article
// text — which is how summaries ended up hallucinated: the model got a title
// and no body. The article ID is encrypted (the old base64 trick died in
// 2024), so we use Google's own batchexecute RPC: scrape the signature +
// timestamp off the wrapper page, then ask DotsSplashUi for the target URL.
const resolvedUrlCache = new Map(); // googleUrl -> realUrl|null
const RESOLVE_CACHE_MAX = 500;

export async function resolveGoogleNewsUrl(url) {
    if (!/news\.google\.com\/rss\/articles\//.test(url || '')) return url; // not a wrapper
    if (resolvedUrlCache.has(url)) return resolvedUrlCache.get(url);
    let resolved = null;
    try {
        const { data: html } = await axios.get(url, {
            headers: GOOGLE_HEADERS,
            timeout: 6000,
        });
        const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
        const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
        const id = url.match(/articles\/([^?]+)/)?.[1];
        if (sg && ts && id) {
            const inner = JSON.stringify([
                'garturlreq',
                [['en-US', 'US', ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'], null, null, 1, 1, 'US:en', null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]], 'en-US', 'US', 1, [2, 3, 4, 8], 1, 0, '655000234', 0, 0, null, 0],
                id, Number(ts), sg,
            ]);
            const freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
            const { data: resp } = await axios.post(
                'https://news.google.com/_/DotsSplashUi/data/batchexecute',
                'f.req=' + encodeURIComponent(freq),
                { headers: { ...GOOGLE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, timeout: 6000 }
            );
            const candidates = (String(resp).match(/https?:\/\/[^"\\]+/g) || []).filter(u => !u.includes('google.com'));
            resolved = candidates[0] || null;
        }
    } catch (err) {
        console.error('Google News URL resolution failed:', err.message);
    }
    // Cache successes only: a transient Google error must not poison this
    // URL for the whole process lifetime — the next click can retry.
    if (resolved) {
        if (resolvedUrlCache.size >= RESOLVE_CACHE_MAX) {
            resolvedUrlCache.delete(resolvedUrlCache.keys().next().value); // drop oldest
        }
        resolvedUrlCache.set(url, resolved);
    }
    return resolved; // null → caller knows the real article is unreachable
}

/**
 * Fetch an article and STRIP it to clean body text (paragraph text only, no
 * nav/ads/markup), capped at maxChars. This is the token-bounded "input" for
 * on-demand summarization: we send the model real article content instead of
 * the thin RSS snippet, but never the whole raw page — the cap keeps input
 * tokens predictable. Free and local (no LLM). Returns null on failure so the
 * caller can fall back to the snippet. Google News wrapper URLs are resolved
 * to the real article first — the wrapper itself contains no article text.
 * @returns {Promise<{text: string, entities: object}|null>}
 */
// Direct fetch + cheerio strip. Returns raw paragraph text or null.
async function fetchDirectText(realUrl) {
    try {
        const { data: html } = await axios.get(realUrl, {
            headers: BROWSER_HEADERS,
            timeout: 6000,
            maxContentLength: 5 * 1024 * 1024, // don't slurp giant pages
        });
        const $ = cheerio.load(html);
        // Drop obvious non-article chrome before reading paragraphs.
        $('script, style, nav, header, footer, aside, form, figure, .ad, .advertisement').remove();
        const paras = [];
        $('p').each((i, el) => {
            const pText = $(el).text().replace(/\s+/g, ' ').trim();
            if (pText.length > 60) paras.push(pText); // skip captions/boilerplate
        });
        const text = paras.join('\n').trim();
        return text.length >= 120 ? text : null; // paywall / JS-only page
    } catch (err) {
        console.error('Direct article fetch failed:', realUrl.slice(0, 80), err.message);
        return null;
    }
}

// Reader-proxy fallback (r.jina.ai) for publishers that block datacenter IPs
// (Forbes et al. 403 Render's egress while serving residential IPs fine).
// The proxy fetches from ITS network and returns the page as markdown; we
// keep only sentence-shaped paragraphs to shed nav/promo chrome. Only public
// news URLs ever go through it, and only after the direct fetch failed.
const READER_JUNK = /paid program|subscribe|sign in|my account|newsletter|cookie|all rights reserved|©|forbes daily|breaking|follow (me|us)|read (more|next)|getty|photo by|advertisement|crossword|play now/i;
async function fetchViaReader(realUrl) {
    try {
        const { data } = await axios.get('https://r.jina.ai/' + realUrl, {
            timeout: 20000,
            maxContentLength: 5 * 1024 * 1024,
        });
        const content = String(data).split(/Markdown Content:/)[1] || String(data);
        const paras = content
            .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links → label
            .split('\n')
            .map(l => l.replace(/^[#>*\-=\s]+/, '').trim())
            // Real prose: long enough, sentence punctuation, not chrome.
            .filter(l => l.length > 80 && /\.\s|\.$/.test(l) && !READER_JUNK.test(l));
        const text = paras.join('\n').trim();
        return text.length >= 200 ? text : null; // higher bar: proxy output is noisier
    } catch (err) {
        console.error('Reader-proxy fetch failed:', realUrl.slice(0, 80), err.message);
        return null;
    }
}

export async function fetchArticleText(url, maxChars = 3000) {
    try {
        const realUrl = await resolveGoogleNewsUrl(url);
        if (!realUrl) return null; // unresolvable wrapper → no body available
        let text = await fetchDirectText(realUrl);
        if (!text) text = await fetchViaReader(realUrl); // IP-block fallback
        if (!text) return null;
        if (text.length > maxChars) {
            // Keep whole sentences: cut at the last sentence end before the cap.
            const clipped = text.slice(0, maxChars);
            const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('.\n'));
            text = (lastStop > maxChars * 0.5 ? clipped.slice(0, lastStop + 1) : clipped).trim();
        }
        const doc = nlp(text);
        return {
            text,
            entities: {
                organizations: [...new Set(doc.organizations().out('array'))].slice(0, 6),
                places: [...new Set(doc.places().out('array'))].slice(0, 6),
                values: [...new Set(doc.values().out('array'))].slice(0, 6),
            },
        };
    } catch (err) {
        console.error('Article text fetch failed for URL:', url, err.message);
        return null;
    }
}

export async function fetchAndExtractArticle(url) {
    try {
        // 0. Google News wrappers hold no article text — resolve to the real URL.
        const realUrl = await resolveGoogleNewsUrl(url);
        if (!realUrl) return null;
        // 1. Fetch HTML
        const { data: html } = await axios.get(realUrl, {
            headers: BROWSER_HEADERS,
            timeout: 5000
        });

        // 2. Parse HTML and extract paragraphs
        const $ = cheerio.load(html);
        let text = '';
        $('p').each((i, el) => {
            const pText = $(el).text().trim();
            if (pText.length > 50) { // Filter out short junk
                text += pText + ' ';
            }
        });

        if (text.length < 100) return null;

        // 3. Extract Entities with Compromise
        const doc = nlp(text);
        const organizations = doc.organizations().out('array');
        const places = doc.places().out('array');
        const values = doc.values().out('array');

        // Deduplicate entities
        const uniqueOrgs = [...new Set(organizations)].slice(0, 5);
        const uniquePlaces = [...new Set(places)].slice(0, 5);
        const uniqueValues = [...new Set(values)].slice(0, 5);

        // 4. Summarize with Natural (TF-IDF approximation)
        const TfIdf = natural.TfIdf;
        const tfidf = new TfIdf();
        
        // Split text into sentences
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
        
        if (sentences.length <= 3) {
            return {
                summary: text,
                entities: { organizations: uniqueOrgs, places: uniquePlaces, values: uniqueValues }
            };
        }

        tfidf.addDocument(text);
        
        // Score each sentence by its terms' TF-IDF weight in the document
        const scoredSentences = sentences.map((sentence, idx) => {
            let score = 0;
            const tokenizer = new natural.WordTokenizer();
            const words = tokenizer.tokenize(sentence);
            
            words.forEach(word => {
                // Approximate term importance
                score += tfidf.tfidf(word, 0); 
            });
            
            // Normalize score by sentence length to prevent bias toward long run-on sentences
            return { sentence: sentence.trim(), score: score / (words.length || 1), originalIndex: idx };
        });

        // Sort by score and pick top 3
        scoredSentences.sort((a, b) => b.score - a.score);
        const topSentences = scoredSentences.slice(0, 3)
                                .sort((a, b) => a.originalIndex - b.originalIndex)
                                .map(s => s.sentence);

        return {
            summary: topSentences.join(' '),
            entities: {
                organizations: uniqueOrgs,
                places: uniquePlaces,
                values: uniqueValues
            }
        };

    } catch (err) {
        console.error('NLP Extraction failed for URL:', url, err.message);
        return null;
    }
}
