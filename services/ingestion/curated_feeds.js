// External RSS intake — ONE configured feed list (RSS_FEEDS, comma-separated
// URLs; empty = inactive). These are the operator's curated feeds — typically
// Google Alerts RSS (google.com/alerts, Deliver to: RSS feed) — whose own
// curation is a better topical filter than our keyword rule engine for broad
// supply-chain news. So feed articles are marked `prevetted`: they bypass the
// commodity/region/semantic keyword gates (but NOT the user blocklist) and
// enter at a Medium floor (High if they carry a severe disruptor in a tracked
// region). The risk-vs-commodity separation and region requirement are then
// enforced at OUTPUT (the categorized feed), not at ingestion — one pipeline
// in, two clean streams out.
//
// Commodity-focused news also flows through the always-on dynamic Google News
// search pipeline. The parser auto-detects RSS 2.0 (<item>) and Atom (<entry>,
// e.g. Google Alerts) so any standard feed works.
import axios from 'axios';

export function getCuratedFeedUrls() {
    // RSS_FEEDS is the current name; SUPPLY_RISK_FEEDS kept as a fallback so
    // existing deployments don't break on rename.
    const raw = process.env.RSS_FEEDS || process.env.SUPPLY_RISK_FEEDS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
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

// Atom (<entry>) — e.g. Google Alerts. Link is an href attribute wrapped in a
// google.com/url redirect.
function parseAtom(xml) {
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
        items.push({ title, description: content, content: '', url: unwrapAlertUrl(href), publishedAt: published, source });
    }
    return items;
}

// RSS 2.0 (<item>) — standard publisher/topic feeds. Link is element text.
function parseRss(xml) {
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
        const it = m[1];
        const rawTitle = decodeEntities(it.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '');
        const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] || '').trim();
        const pubDate = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]
            || it.match(/<dc:date>([\s\S]*?)<\/dc:date>/)?.[1] || '').trim();
        const desc = decodeEntities(it.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] || '');
        const source = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim();
        if (!rawTitle || !pubDate) continue;
        const { title, source: titleSource } = splitTitleSource(rawTitle, source);
        items.push({ title, description: desc, content: '', url: unwrapAlertUrl(link), publishedAt: pubDate, source: titleSource || 'RSS' });
    }
    return items;
}

/** Auto-detect Atom vs RSS 2.0 and parse to article objects (no prevetted flag). */
export function parseFeed(xml) {
    return /<entry[\s>]/.test(xml) ? parseAtom(xml) : parseRss(xml);
}

// Back-compat: the Atom/Google-Alerts parser, tagged prevetted.
export function parseAlertsFeed(xml) {
    return parseFeed(xml).map(a => ({ ...a, prevetted: true }));
}

// Shared fetcher. Per-feed failures are swallowed (one bad feed never sinks a
// scan). `prevetted` marks the supply-risk lane; false = full-pipeline lane.
async function fetchFeeds(urls, prevetted, tag) {
    if (urls.length === 0) return [];
    const results = await Promise.allSettled(urls.map(async (url) => {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FOPsFeed/1.0)' },
            timeout: 8000,
        });
        return parseFeed(data).map(a => ({ ...a, prevetted }));
    }));
    const out = [];
    for (const r of results) {
        if (r.status === 'fulfilled') out.push(...r.value);
        else console.error(`[${tag}] fetch failed:`, r.reason?.message);
    }
    return out;
}

/** The single external RSS feed lane (prevetted — bypasses keyword gates;
 * risk/commodity split + region gating happen at output). */
export function fetchCuratedFeeds() {
    return fetchFeeds(getCuratedFeedUrls(), true, 'RSS-FEED');
}
