// Does extracted page text actually belong to this headline?
//
// fetchArticleText does not report failure: when the article body cannot be
// parsed it still returns whatever text the page yielded. Observed on a Google
// News link that resolved to Yahoo Finance and failed with "Parse Error:
// Header overflow" — it returned 2951 characters of the site's related-news
// sidebar ("1. News • 1 hour ago Brent crude oil prices..."), which is long,
// plausible prose about entirely different stories. A length floor cannot
// separate that from a real article body.
//
// So test subject overlap instead: a genuine article restates its own headline
// terms; page chrome does not. Lives in its own module so the test exercises
// the shipped function rather than a copy that drifts from it.

const STOP = new Set([
    'about', 'after', 'again', 'against', 'amid', 'among', 'because', 'been',
    'before', 'being', 'between', 'could', 'during', 'from', 'have', 'into',
    'more', 'most', 'other', 'over', 'said', 'says', 'should', 'since',
    'than', 'that', 'their', 'them', 'these', 'this', 'those', 'through',
    'under', 'until', 'where', 'which', 'while', 'with', 'would', 'alert',
    'profile', 'news', 'update', 'report',
]);

/** Distinctive terms from an alert headline, stripped of decoration. */
export function headlineTerms(title) {
    return String(title || '')
        .replace(/^[^A-Za-z0-9]+/, '')          // leading emoji / decoration
        .replace(/^[A-Za-z ]+:\s*/, '')         // "Maritime Chokepoint: " prefix
        .replace(/\s+[-|]\s+[^-|]{2,40}$/, '')  // trailing " - Yahoo Finance"
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 5 && !STOP.has(w));
}

export function bodyMatchesHeadline(title, body) {
    const terms = headlineTerms(title);

    // Nothing distinctive to test against — do not block on this check.
    if (terms.length === 0) return true;

    const haystack = String(body || '').toLowerCase();
    const hits = terms.filter(w => haystack.includes(w)).length;

    // Two hits, not one. Measured against the case that motivated this: the
    // Yahoo Finance sidebar matched "stocks" from the headline "...Strait of
    // Hormuz. These Stocks Could Be the Biggest Winners" — a generic finance
    // word on a finance site — while none of hormuz/strait/reopen/offered
    // appeared anywhere in the 2951 characters returned. Measured against the
    // three alerts whose fetch DID succeed, genuine bodies scored 3, 5 and 6
    // hits, so the threshold sits well clear of both sides.
    //
    // Titles carrying only one or two distinctive terms keep the lower bar,
    // so a terse headline is not rejected for lack of vocabulary.
    return terms.length <= 2 ? hits >= 1 : hits >= 2;
}

/** Minimum characters before extracted text is considered an article body. */
export const MIN_ARTICLE_CHARS = 400;
