// Curated "supply-chain risk" intake lane. These are Google Alerts RSS feeds
// (Atom format) the operator hand-creates in the Google Alerts UI for broad
// supply-chain-risk topics — e.g. "supply chain middle east", "Strait of
// Hormuz", "Red Sea shipping". Google's "best results" curation is a better
// topical filter for this class of broad-web risk news than our keyword rule
// engine, so articles from these feeds are marked `prevetted` and bypass the
// pipeline's commodity/region/semantic gates (but NOT the user's blocklist),
// entering with a Medium relevance floor. Commodity-focused news still flows
// through the normal Google News search pipeline.
//
// Feed URLs come from env SUPPLY_RISK_FEEDS (comma-separated). If unset, this
// lane is simply inactive — a safe no-op. There is no Google Alerts API, so
// the feeds are created manually and their RSS URLs pasted into the env var.
import axios from 'axios';

export function getCuratedFeedUrls() {
    return (process.env.SUPPLY_RISK_FEEDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function decodeEntities(s) {
    return String(s || '')
        // Decode &lt;/&gt; FIRST so encoded tags (title type="html" sends
        // &lt;b&gt;) become real tags, then strip them. Order matters — strip
        // before this and the encoded tags survive as literal "<b>".
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/<[^>]+>/g, ' ')                 // strip the now-real HTML tags
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

// Google Alerts links are google.com/url?...&url=<REAL>&... redirect wrappers.
// Pull the real publisher URL out of the `url` query param.
export function unwrapAlertUrl(href) {
    if (!href) return '';
    try {
        const u = new URL(href.replace(/&amp;/g, '&'));
        const real = u.searchParams.get('url') || u.searchParams.get('q');
        return real || href;
    } catch {
        return href;
    }
}

// Title from Google Alerts is often "Headline - Publisher". Split the source
// off the end for display; fall back to the <author><name> or "Google Alerts".
function splitTitleSource(title, authorName) {
    const m = title.match(/^(.*?)\s+-\s+([^-]{2,40})$/);
    if (m) return { title: m[1].trim(), source: m[2].trim() };
    return { title, source: authorName || 'Google Alerts' };
}

/**
 * Parse one Google Alerts Atom feed body into article objects.
 * @param {string} xml
 * @returns {Array<{title,description,content,url,publishedAt,source,prevetted}>}
 */
export function parseAlertsFeed(xml) {
    const items = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRegex.exec(xml)) !== null) {
        const e = m[1];
        const rawTitle = decodeEntities(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '');
        const href = (e.match(/<link[^>]*href="([^"]*)"/)?.[1] || '').trim();
        const published = (e.match(/<published>([\s\S]*?)<\/published>/)?.[1]
            || e.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || '').trim();
        const content = decodeEntities(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '');
        const authorName = (e.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/)?.[1] || '').trim();
        if (!rawTitle || !published) continue;
        const { title, source } = splitTitleSource(rawTitle, authorName);
        items.push({
            title,
            description: content,
            content: '',
            url: unwrapAlertUrl(href),
            publishedAt: published,
            source,
            prevetted: true, // Google already vetted supply-chain-risk relevance
        });
    }
    return items;
}

/**
 * Fetch and parse all configured supply-risk feeds. Failures per feed are
 * swallowed (one bad feed never sinks the scan). Returns a flat article list.
 */
export async function fetchCuratedFeeds() {
    const urls = getCuratedFeedUrls();
    if (urls.length === 0) return [];
    const results = await Promise.allSettled(urls.map(async (url) => {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FOPsRiskFeed/1.0)' },
            timeout: 8000,
        });
        return parseAlertsFeed(data);
    }));
    const out = [];
    for (const r of results) {
        if (r.status === 'fulfilled') out.push(...r.value);
        else console.error('[SUPPLY-RISK-FEED] fetch failed:', r.reason?.message);
    }
    return out;
}
