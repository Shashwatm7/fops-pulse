import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertsFeed, parseFeed, unwrapAlertUrl } from '../services/ingestion/curated_feeds.js';
import { NewsPipeline } from '../services/news-pipeline/pipeline.js';

// A realistic Google Alerts Atom feed fragment.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
 <title>Google Alert - supply chain middle east</title>
 <entry>
  <id>tag:google.com,2013:12345</id>
  <title type="html">Red Sea &lt;b&gt;shipping&lt;/b&gt; disruption deepens - Reuters</title>
  <link href="https://www.google.com/url?rct=j&amp;sa=t&amp;url=https://reuters.com/red-sea-crisis&amp;ct=ga&amp;cd=abc"/>
  <published>2026-07-13T08:00:00Z</published>
  <updated>2026-07-13T08:00:00Z</updated>
  <content type="html">Vessels reroute around the Cape as attacks continue.</content>
  <author><name>Reuters</name></author>
 </entry>
 <entry>
  <id>tag:google.com,2013:67890</id>
  <title type="html">Strait of Hormuz tensions escalate - Bloomberg</title>
  <link href="https://www.google.com/url?url=https://bloomberg.com/hormuz&amp;ct=ga"/>
  <published>2026-07-13T07:00:00Z</published>
  <content type="html">Tankers face higher insurance premiums.</content>
 </entry>
</feed>`;

test('unwrapAlertUrl extracts the real publisher URL from the redirect', () => {
    assert.equal(
        unwrapAlertUrl('https://www.google.com/url?rct=j&amp;sa=t&amp;url=https://reuters.com/x&amp;ct=ga'),
        'https://reuters.com/x');
    assert.equal(unwrapAlertUrl(''), '');
    // Non-wrapped URL passes through unchanged
    assert.equal(unwrapAlertUrl('https://example.com/a'), 'https://example.com/a');
});

test('parseAlertsFeed extracts entries, strips HTML, splits source, marks prevetted', () => {
    const items = parseAlertsFeed(SAMPLE);
    assert.equal(items.length, 2);
    const a = items[0];
    assert.equal(a.title, 'Red Sea shipping disruption deepens');
    assert.equal(a.source, 'Reuters');
    assert.equal(a.url, 'https://reuters.com/red-sea-crisis');
    assert.equal(a.prevetted, true);
    assert.ok(a.publishedAt);
    // Second entry has source only in the title suffix
    assert.equal(items[1].source, 'Bloomberg');
    assert.equal(items[1].url, 'https://bloomberg.com/hormuz');
});

test('parseAlertsFeed skips entries missing title or date', () => {
    const items = parseAlertsFeed('<feed><entry><content>no title</content></entry></feed>');
    assert.equal(items.length, 0);
});

// RSS 2.0 feed for the PIPELINE_RSS_FEEDS lane (runs through full filtering).
const RSS20 = `<rss version="2.0"><channel>
 <item>
  <title>Wheat futures climb on export demand</title>
  <link>https://example.com/wheat-futures</link>
  <pubDate>Sun, 13 Jul 2026 08:00:00 GMT</pubDate>
  <description>Prices rose 3% amid strong buying.</description>
  <source url="https://agnews.com">AgNews</source>
 </item>
</channel></rss>`;

test('parseFeed auto-detects RSS 2.0 and extracts item fields', () => {
    const items = parseFeed(RSS20);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Wheat futures climb on export demand');
    assert.equal(items[0].url, 'https://example.com/wheat-futures');
    assert.equal(items[0].source, 'AgNews');
    assert.equal(items[0].prevetted, undefined, 'parseFeed itself does not tag prevetted');
});

test('parseFeed auto-detects Atom (entry) vs RSS (item)', () => {
    assert.equal(parseFeed('<feed><entry><title>t</title><link href="https://x.com/a"/><published>2026-07-13T00:00:00Z</published></entry></feed>').length, 1);
    assert.equal(parseFeed(RSS20).length, 1);
});

// A profile whose keyword rule engine would REJECT a region-less, commodity-
// less risk story — exactly what the prevetted lane is meant to let through.
const PROFILE = {
    user_id: 7,
    commodities: ['WHEAT', 'CORN'],
    regions: ['UAE Sweihan'],
    focus_product: 'Frozen Goods',
    focus_region: 'Middle East',
    news_keywords: [],
    custom_blocklist: ['recipe'],
    ml_seeds: ['unrelated seed about dairy prices'],
};
const run = (article) => new NewsPipeline({ semantic: 'off' }).processArticle(
    { content: '', url: 'https://t/' + Math.random(), publishedAt: new Date().toUTCString(), source: 'test', ...article },
    PROFILE, new Set());

test('prevetted risk article bypasses keyword gate and lands >= Medium', async () => {
    const r = await run({ title: 'Global shipping snarls worsen as canal traffic slows', prevetted: true });
    assert.equal(r.accepted, true, 'prevetted article should be accepted despite no tracked commodity/region');
    assert.ok(r.score >= 60, `floored to Medium, got ${r.score}`);
    assert.ok(['Medium', 'High', 'Critical'].includes(r.article.priority));
});

test('same article WITHOUT prevetted is rejected by the keyword gate', async () => {
    const r = await run({ title: 'Global shipping snarls worsen as canal traffic slows', prevetted: false });
    assert.equal(r.accepted, false, 'non-prevetted commodity-less/region-less article should be rejected');
});

test('prevetted does NOT bypass the user blocklist', async () => {
    // Standalone culinary "recipe" (not the idiom "recipe for") → genuine blocklist hit.
    const r = await run({ title: 'Ports clog; meanwhile a quick chicken recipe roundup', prevetted: true });
    assert.equal(r.accepted, false, 'blocklisted term (recipe) must still reject a prevetted article');
    assert.match(r.reason, /excluded context/i);
});

test('prevetted severe disruptor IN a tracked region climbs to High', async () => {
    // Region is taken into account: severe + region match → High floor.
    const r = await run({ title: 'Missile attack shuts UAE Sweihan port, blockade halts all cargo', prevetted: true });
    assert.equal(r.accepted, true);
    assert.ok(['High', 'Critical'].includes(r.article.priority), `severe + region should reach High, got ${r.article.priority}`);
});

test('prevetted severe disruptor OUTSIDE tracked regions stays Medium (region counts)', async () => {
    // Same severity, but no tracked region named → not pinned High.
    const r = await run({ title: 'Missile attack shuts major port, blockade halts all cargo', prevetted: true });
    assert.equal(r.accepted, true);
    assert.equal(r.article.priority, 'Medium', `severe without region should stay Medium, got ${r.article.priority}`);
});
