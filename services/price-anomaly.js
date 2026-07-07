// ── Statistical price anomaly detection ─────────────────────────────
// Pure functions over daily close series — no I/O, no thresholds to
// configure per user. A move is alert-worthy when it is abnormal for
// THAT commodity's own volatility, not when it crosses a guessed number.
//
// Roll-awareness: Yahoo continuous futures (ZC=F, ZO=F, ...) switch front
// contracts, which injects large fake "moves" into the series (e.g. oats
// +17.8% overnight on the July→Dec roll). Three defenses:
//   1. Robust sigma (MAD-based) — one roll gap in history doesn't inflate
//      volatility estimates for the next 30 days.
//   2. Returns are clipped at ±4σ before reconstructing the series used
//      for range detection, so ranges compare at the current contract's
//      price scale.
//   3. Roll guard — a large overnight gap with a quiet intraday session is
//      suppressed as a suspected roll. (A real crisis keeps moving
//      intraday, and is independently covered by the news-alert path.)
//
// Detectors:
//   sigma-move-up/down   today's return vs trailing 30d robust volatility
//                        |z| >= 2.5 -> HIGH, |z| >= 3.5 -> CRITICAL
//   range-break-high/low live price outside the adjusted 90-day range
//   vol-regime           7d realized vol >= 2x the 90d baseline

export const MIN_OBS_ZSCORE = 20;
export const MIN_OBS_RANGE = 30;
const SIGMA_FLOOR = 0.001; // 0.1%/day — guards absurd z on stale/smooth series
const CLIP_SIGMAS = 4;

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Robust volatility: 1.4826 × MAD ≈ stddev for normal data, but a single
// contract-roll outlier barely moves it (unlike plain stddev).
export function robustSigma(returns) {
    if (!returns || returns.length < 2) return SIGMA_FLOOR;
    const med = median(returns);
    const mad = median(returns.map(r => Math.abs(r - med)));
    return Math.max(1.4826 * mad, SIGMA_FLOOR);
}

/**
 * @param {number[]} dailyCloses ascending completed daily closes (normalized USD)
 * @param {number} livePrice current normalized price
 * @param {number|null} todayOpen today's session open, if available
 * @param {number|null} prevClose the quote's OWN regularMarketPreviousClose
 *        (normalized). This is same-contract by construction — the
 *        authoritative, roll-proof reference for today's move. The
 *        continuous chart series is only used for volatility/range stats.
 * @returns {Array<object>} anomaly findings (empty when nothing abnormal or roll suspected)
 */
export function analyzePriceSeries(dailyCloses, livePrice, todayOpen = null, prevClose = null) {
    const findings = [];
    if (!Array.isArray(dailyCloses) || dailyCloses.length < MIN_OBS_ZSCORE || !(livePrice > 0)) return findings;

    const rawReturns = [];
    for (let i = 1; i < dailyCloses.length; i++) {
        const prev = dailyCloses[i - 1];
        if (prev > 0 && dailyCloses[i] > 0) rawReturns.push((dailyCloses[i] - prev) / prev);
    }
    const lastClose = dailyCloses[dailyCloses.length - 1];
    if (!(lastClose > 0) || rawReturns.length < MIN_OBS_ZSCORE - 1) return findings;

    const sigmaAll = robustSigma(rawReturns);
    const clippedReturns = rawReturns.map(r => Math.max(-CLIP_SIGMAS * sigmaAll, Math.min(CLIP_SIGMAS * sigmaAll, r)));
    const sigma30 = robustSigma(clippedReturns.slice(-30));

    // Reference for today's move: same-contract prevClose when available
    // (roll-proof); the continuous-series last close only as fallback.
    const sameContractRef = prevClose > 0;
    const reference = sameContractRef ? prevClose : lastClose;
    const todayReturn = (livePrice - reference) / reference;

    if (!sameContractRef) {
        // ── Roll guards (fallback path only — a same-contract reference
        // cannot produce a roll artifact, and a genuine limit-move day
        // must not be suppressed there) ──
        if (todayOpen > 0) {
            const gapReturn = (todayOpen - reference) / reference;
            const intradayReturn = (livePrice - todayOpen) / todayOpen;
            const gapSigmas = Math.abs(gapReturn) / sigma30;
            const intradaySigmas = Math.abs(intradayReturn) / sigma30;
            // Two roll signatures: huge gap with roughly-normal session, or
            // moderate gap with a DEAD session (e.g. rice +3.5% gap, -0.2% day).
            if ((gapSigmas >= 3 && intradaySigmas < 1.5) || (gapSigmas >= 2 && intradaySigmas < 0.5)) {
                return findings;
            }
        } else if (Math.abs(todayReturn) >= 4 * sigma30) {
            // No same-contract reference AND no session open to verify against
            // (e.g. overnight Globex, chart has no today-bar yet): a huge move
            // is unverifiable and most likely a contract roll. Suppress — if
            // real, it re-triggers within a tick once the session data exists.
            return findings;
        }
    }

    // 1) Sigma move: abnormal single-day change for this commodity.
    // Materiality floor of 1.5%: illiquid contracts (e.g. Class III Milk)
    // have near-zero MAD, which turns economically meaningless moves into
    // huge z-scores. Planners care about material moves, not statistics.
    const zScore = Math.max(-10, Math.min(10, todayReturn / sigma30));
    if (Math.abs(zScore) >= 2.5 && Math.abs(todayReturn) >= 0.015) {
        findings.push({
            type: todayReturn >= 0 ? 'sigma-move-up' : 'sigma-move-down',
            severity: Math.abs(zScore) >= 3.5 ? 'CRITICAL' : 'HIGH',
            zScore: +zScore.toFixed(2),
            todayReturnPct: +(todayReturn * 100).toFixed(2),
            typicalDailyMovePct: +(sigma30 * 100).toFixed(2),
        });
    }

    // 2) 90-day range break — on the return-reconstructed series so old
    // contract months compare at the current price scale. Anchored at the
    // same-contract reference when available.
    if (dailyCloses.length >= MIN_OBS_RANGE) {
        const adjusted = new Array(clippedReturns.length + 1);
        adjusted[adjusted.length - 1] = reference;
        for (let i = adjusted.length - 2; i >= 0; i--) {
            const r = clippedReturns[i];
            adjusted[i] = (1 + r) !== 0 ? adjusted[i + 1] / (1 + r) : adjusted[i + 1];
        }
        const window90 = adjusted.slice(-90);
        const high = Math.max(...window90);
        const low = Math.min(...window90);
        // Degenerate-range guard: on near-flat illiquid series (e.g. Class
        // III Milk) the whole 90-day range can be a fraction of a percent
        // wide, making any float-level drift a "breakout". Require a
        // meaningful range before break detection applies.
        const rangeWidth = (high - low) / reference;
        const breakSeverity = Math.abs(zScore) >= 2 ? 'HIGH' : 'MEDIUM';
        if (rangeWidth < 0.02) {
            // skip range detection entirely
        } else if (livePrice > high) {
            findings.push({ type: 'range-break-high', severity: breakSeverity, high: +high.toFixed(4), low: +low.toFixed(4) });
        } else if (livePrice < low) {
            findings.push({ type: 'range-break-low', severity: breakSeverity, high: +high.toFixed(4), low: +low.toFixed(4) });
        }
    }

    // 3) Volatility regime shift: recent daily swings vs baseline
    if (clippedReturns.length >= 30) {
        const sigma7 = robustSigma(clippedReturns.slice(-7));
        const sigma90 = robustSigma(clippedReturns.slice(-90));
        if (sigma90 > SIGMA_FLOOR && sigma7 / sigma90 >= 2) {
            findings.push({
                type: 'vol-regime',
                severity: 'MEDIUM',
                volRatio: +(sigma7 / sigma90).toFixed(1),
                baselineDailyMovePct: +(sigma90 * 100).toFixed(2),
            });
        }
    }

    return findings;
}

/** Human-readable title/reason for an anomaly finding, written for planners.
 *  No statistics jargon — "5× its typical daily move", never "5σ". */
export function describeAnomaly(finding, label, price, unit) {
    const priceStr = `$${price.toFixed(price < 10 ? 4 : 2)} ${unit}`;
    switch (finding.type) {
        case 'sigma-move-up':
        case 'sigma-move-down': {
            const up = finding.todayReturnPct >= 0;
            const sign = up ? '+' : '';
            // "5× its typical day" reads better than a z-score and is the same fact
            const timesTypical = finding.typicalDailyMovePct > 0
                ? Math.round(Math.abs(finding.todayReturnPct) / finding.typicalDailyMovePct)
                : null;
            return {
                title: `${up ? '📈' : '📉'} Unusual price ${up ? 'jump' : 'drop'}: ${label} ${sign}${finding.todayReturnPct}% today`,
                reason: `${label} moved ${sign}${finding.todayReturnPct}% today${timesTypical ? ` — about ${timesTypical}× its typical daily move of ${finding.typicalDailyMovePct}%` : ''}. Now trading at ${priceStr}.`,
            };
        }
        case 'range-break-high':
            return {
                title: `📈 ${label} hit a 90-day high`,
                reason: `${label} is trading at ${priceStr}, above its 90-day range ($${finding.low}–$${finding.high}). Review open purchase commitments priced off older levels.`,
            };
        case 'range-break-low':
            return {
                title: `📉 ${label} hit a 90-day low`,
                reason: `${label} is trading at ${priceStr}, below its 90-day range ($${finding.low}–$${finding.high}). Potential forward-buy window if demand plans support it.`,
            };
        case 'vol-regime':
            return {
                title: `⚡ Price swings widening: ${label}`,
                reason: `${label} daily swings this week are running ${finding.volRatio}× the past-quarter norm (typical day was ${finding.baselineDailyMovePct}%). Consider staggering orders instead of single large buys.`,
            };
        default:
            return { title: `Price signal: ${label}`, reason: `Unusual price behavior detected at ${priceStr}.` };
    }
}

/** Relevance score (0-100) so anomaly alerts sort sensibly among news alerts. */
export function anomalyRelevanceScore(finding) {
    if (finding.type.startsWith('sigma-move')) return Math.min(100, Math.round(40 + Math.abs(finding.zScore) * 12));
    if (finding.type.startsWith('range-break')) return finding.severity === 'HIGH' ? 62 : 48;
    return 42; // vol-regime
}
