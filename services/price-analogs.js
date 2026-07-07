// ── Statistical price analogs ────────────────────────────────────────
// "What happened the last N times this commodity moved like today?"
// No curated library, no LLM — pure statistics over the commodity's own
// full daily history (typically 10-15 years of real bars). Works for
// every price alert on every commodity.
//
// Method: find past days whose single-day return matches today's move in
// direction and magnitude band, then measure the REAL forward returns
// from each of those days and report the distribution.

import { robustSigma } from './price-anomaly.js';

const TRADING_DAYS = { w1: 5, m1: 21, m3: 63 };

function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {Array<{date: Date|string, close: number}>} bars ascending full daily history
 * @param {number} todayReturnPct today's move in percent (e.g. +4.2)
 * @returns {object|null} analog stats, or null when history/matches are insufficient
 */
export function findAnalogs(bars, todayReturnPct) {
    const clean = (bars || [])
        .filter(b => b && b.close > 0 && b.date)
        .map(b => ({ date: new Date(b.date), close: b.close }))
        .sort((a, b) => a.date - b.date);
    if (clean.length < 300 || !Number.isFinite(todayReturnPct) || todayReturnPct === 0) return null;

    const returns = []; // { idx (of day i close), r }
    for (let i = 1; i < clean.length; i++) {
        const prev = clean[i - 1].close;
        if (prev > 0) returns.push({ idx: i, r: (clean[i].close - prev) / prev });
    }

    // Contract-roll guard: discard candidate days whose return is an extreme
    // outlier vs the series' robust volatility — those are roll gaps in the
    // continuous series, not market moves.
    const sigma = robustSigma(returns.map(x => x.r));
    const rollCutoff = 8 * sigma;

    const target = todayReturnPct / 100;
    const sameSign = (r) => (target > 0 ? r > 0 : r < 0);
    const magnitude = Math.abs(target);

    // Band: 0.7x–1.6x of today's magnitude, same direction. If that yields
    // too few analogs, widen to >= 0.7x (rarer, bigger moves still inform).
    const inBand = (r, loose) => {
        const m = Math.abs(r);
        if (!sameSign(r) || m > rollCutoff) return false;
        return loose ? m >= magnitude * 0.7 : (m >= magnitude * 0.7 && m <= magnitude * 1.6);
    };

    let candidates = returns.filter(x => inBand(x.r, false));
    let bandNote = 'similar-size';
    if (candidates.length < 5) {
        candidates = returns.filter(x => inBand(x.r, true));
        bandNote = 'comparable-or-larger';
    }
    // Exclude analogs too recent to have a full 3-month aftermath
    candidates = candidates.filter(x => x.idx + TRADING_DAYS.m3 < clean.length);
    if (candidates.length < 3) return null;

    // De-cluster: within the same crisis, consecutive big days are one
    // episode, not independent precedents. Keep the first of any run
    // within 10 trading days.
    const episodes = [];
    for (const c of candidates) {
        if (episodes.length === 0 || c.idx - episodes[episodes.length - 1].idx > 10) episodes.push(c);
    }
    if (episodes.length < 3) return null;

    const fwd = { w1: [], m1: [], m3: [] };
    let faded = 0;
    const persistentYears = [];
    for (const e of episodes) {
        const base = clean[e.idx].close;
        for (const [key, days] of Object.entries(TRADING_DAYS)) {
            const later = clean[e.idx + days];
            if (later) fwd[key].push(((later.close - base) / base) * 100);
        }
        const m1 = fwd.m1[fwd.m1.length - 1];
        // "Faded": one month on, the follow-through is gone — either reversed
        // sign or shrunk below a quarter of the original move.
        const followedThrough = m1 != null && sameSign(m1 / 100) && Math.abs(m1) >= Math.abs(todayReturnPct) * 0.25;
        if (followedThrough) persistentYears.push(clean[e.idx].date.getUTCFullYear());
        else faded++;
    }

    return {
        count: episodes.length,
        bandNote,
        firstYear: clean[episodes[0].idx].date.getUTCFullYear(),
        medianFwd: {
            w1: +median(fwd.w1)?.toFixed(1),
            m1: +median(fwd.m1)?.toFixed(1),
            m3: +median(fwd.m3)?.toFixed(1),
        },
        fadedCount: faded,
        persistentYears: [...new Set(persistentYears)],
    };
}

/** Planner-readable summary of the analog distribution. */
export function summarizeAnalogs(label, todayReturnPct, a) {
    if (!a) return null;
    const dir = (v) => (v == null || Number.isNaN(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v}%`);
    const moveWord = todayReturnPct >= 0 ? 'jumps' : 'drops';
    const persisted = a.count - a.fadedCount;
    let ending;
    if (a.fadedCount >= a.count * 0.7) {
        ending = `${a.fadedCount} of ${a.count} faded within a month — moves like this usually didn't stick.`;
    } else if (persisted >= a.count * 0.7) {
        ending = `${persisted} of ${a.count} kept going a month later${a.persistentYears.length ? ` (${a.persistentYears.slice(0, 4).join(', ')})` : ''} — moves like this usually had follow-through.`;
    } else {
        ending = `${persisted} of ${a.count} still had momentum a month later${a.persistentYears.length ? ` (${a.persistentYears.slice(0, 4).join(', ')})` : ''}.`;
    }
    return `${a.count} ${a.bandNote === 'similar-size' ? 'similar' : 'comparable'} single-day ${moveWord} in ${label} since ${a.firstYear}. Median outcome: ${dir(a.medianFwd.w1)} after 1 week, ${dir(a.medianFwd.m1)} after 1 month, ${dir(a.medianFwd.m3)} after 3 months. ${ending}`;
}
