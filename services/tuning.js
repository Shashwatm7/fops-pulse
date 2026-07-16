// Runtime-tunable pipeline / LLM parameters, adjustable by an admin at runtime
// via /api/admin/tuning. NOT persisted — values reset to the env defaults on
// restart/redeploy (per the "admin-only, runtime only" decision). The pipeline
// and LLM call sites read `tuning.*` LIVE, so a change takes effect on the very
// next scan/analyze without a restart.
const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};

// Default NEGATIVE seeds for the Rocchio classifier (stage 6): natural
// sentences (they embed better than keyword bags) covering the false-positive
// topics the pipeline has actually seen. Editable at runtime via the admin
// panel — the noise centroid is re-embedded when the list changes.
const DEFAULT_NOISE_SEEDS = [
    'A recipe with cooking tips and ingredients for a home-cooked meal.',
    'A restaurant review, cafe menu, and dining recommendations.',
    'Celebrity gossip, horoscopes, lottery numbers and box-office movie reviews.',
    'Sports match highlights, video game and esports coverage.',
    'Diet, nutrition and personal health and wellness advice.',
    'Gardening and home vegetable garden tips.',
];

// Live values (mutable). Seeded from env so ops can still set a boot default.
export const tuning = {
    rocchioGamma: num(process.env.ROCCHIO_GAMMA, 0.5),          // Rocchio noise penalty weight
    semanticThreshold: num(process.env.SEMANTIC_THRESHOLD, 0.30), // stage-6 gate cutoff
    rescueThreshold: num(process.env.SEMANTIC_RESCUE_THRESHOLD, 0.40), // keyword-rejected rescue cutoff
    llmTemperature: num(process.env.LLM_TEMPERATURE, 0.1),      // planner/deep-dive/drivers temperature
    // Expanded-query seed lists (stage-6 semantic filter):
    // extraSeeds — POSITIVE example sentences appended to every profile's
    // auto/customer-expanded query; use to widen coverage globally.
    extraSeeds: [],
    // noiseSeeds — NEGATIVE examples forming the Rocchio noise centroid.
    noiseSeeds: [...DEFAULT_NOISE_SEEDS],
};

// Keys the admin has EXPLICITLY changed this runtime. Lets a call site
// distinguish "admin overrode this" from "boot default" — e.g. the stage-6
// threshold uses the per-profile calibration until an admin takes over.
export const touched = new Set();

// Allowed range + step + label per field — drives validation AND the admin UI.
// type 'number' renders a slider; type 'list' renders a one-item-per-line
// textarea. Lists are capped (maxItems/maxLen) in updateTuning.
export const TUNING_META = {
    rocchioGamma:      { type: 'number', min: 0, max: 2, step: 0.05, label: 'Rocchio γ (noise weight)', default: tuning.rocchioGamma },
    semanticThreshold: { type: 'number', min: 0, max: 1, step: 0.01, label: 'Semantic gate threshold', default: tuning.semanticThreshold,
                         note: 'Per-profile calibration (0.30 curated / 0.25 auto seeds) applies until you change this — then your value overrides all profiles.' },
    rescueThreshold:   { type: 'number', min: 0, max: 1, step: 0.01, label: 'Rescue threshold',         default: tuning.rescueThreshold },
    llmTemperature:    { type: 'number', min: 0, max: 1, step: 0.05, label: 'LLM temperature',          default: tuning.llmTemperature },
    extraSeeds:        { type: 'list', maxItems: 24, maxLen: 300, label: 'Extra positive seeds (query expansion)', default: [],
                         note: 'One per line. Appended to every user\'s expanded query — articles similar to ANY seed pass the semantic gate.' },
    noiseSeeds:        { type: 'list', maxItems: 24, maxLen: 300, label: 'Noise seeds (Rocchio negative examples)', default: [...DEFAULT_NOISE_SEEDS],
                         note: 'One per line. Natural sentences describing OFF-topic content; articles near these get pushed below the gate.' },
};

function sanitizeList(value, { maxItems, maxLen }) {
    if (!Array.isArray(value)) return null;
    return value
        .map(s => String(s).trim())
        .filter(s => s.length > 0)
        .map(s => s.slice(0, maxLen))
        .slice(0, maxItems);
}

// Apply a partial update, clamped/sanitized per TUNING_META. Returns the
// values actually applied. Marks each applied key as admin-touched — but ONLY
// when the value actually changed: the admin UI posts the full object, and an
// unchanged semanticThreshold must not flip `touched` (which would silently
// disable the per-profile calibration the admin never meant to override).
export function updateTuning(patch = {}) {
    const applied = {};
    for (const key of Object.keys(TUNING_META)) {
        if (patch[key] == null) continue;
        const meta = TUNING_META[key];
        if (meta.type === 'list') {
            const items = sanitizeList(patch[key], meta);
            if (items === null) continue;
            if (items.join('\n') === (tuning[key] || []).join('\n')) continue; // unchanged
            tuning[key] = items;
            applied[key] = items;
            touched.add(key);
        } else {
            const n = Number(patch[key]);
            if (!Number.isFinite(n)) continue;
            const clamped = Math.min(meta.max, Math.max(meta.min, n));
            if (clamped === tuning[key]) continue; // unchanged
            tuning[key] = clamped;
            applied[key] = clamped;
            touched.add(key);
        }
    }
    return applied;
}
