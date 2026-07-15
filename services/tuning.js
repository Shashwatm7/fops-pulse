// Runtime-tunable pipeline / LLM parameters, adjustable by an admin at runtime
// via /api/admin/tuning. NOT persisted — values reset to the env defaults on
// restart/redeploy (per the "admin-only, runtime only" decision). The pipeline
// and LLM call sites read `tuning.*` LIVE, so a change takes effect on the very
// next scan/analyze without a restart.
const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
};

// Live values (mutable). Seeded from env so ops can still set a boot default.
export const tuning = {
    rocchioGamma: num(process.env.ROCCHIO_GAMMA, 0.5),          // Rocchio noise penalty weight
    semanticThreshold: num(process.env.SEMANTIC_THRESHOLD, 0.30), // stage-6 gate cutoff
    rescueThreshold: num(process.env.SEMANTIC_RESCUE_THRESHOLD, 0.40), // keyword-rejected rescue cutoff
    llmTemperature: num(process.env.LLM_TEMPERATURE, 0.1),      // planner/deep-dive/drivers temperature
};

// Allowed range + step + label per field — drives validation AND the admin UI.
export const TUNING_META = {
    rocchioGamma:      { min: 0, max: 2, step: 0.05, label: 'Rocchio γ (noise weight)', default: tuning.rocchioGamma },
    semanticThreshold: { min: 0, max: 1, step: 0.01, label: 'Semantic gate threshold', default: tuning.semanticThreshold },
    rescueThreshold:   { min: 0, max: 1, step: 0.01, label: 'Rescue threshold',         default: tuning.rescueThreshold },
    llmTemperature:    { min: 0, max: 1, step: 0.05, label: 'LLM temperature',          default: tuning.llmTemperature },
};

// Apply a partial update, clamped to bounds. Returns the values actually applied.
export function updateTuning(patch = {}) {
    const applied = {};
    for (const key of Object.keys(TUNING_META)) {
        if (patch[key] == null) continue;
        const n = Number(patch[key]);
        if (!Number.isFinite(n)) continue;
        const { min, max } = TUNING_META[key];
        tuning[key] = Math.min(max, Math.max(min, n));
        applied[key] = tuning[key];
    }
    return applied;
}
