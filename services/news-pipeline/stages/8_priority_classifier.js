/**
 * Stage 8: Priority Classification
 * Maps the 0-100 score (and optional LLM impact) to a final priority bucket.
 */
export function classifyPriority(score, llmResult = null) {
    let priority = 'Ignored';

    if (llmResult && llmResult.impact) {
        // If LLM evaluated it, trust its impact assessment
        return llmResult.impact;
    }

    if (score >= 85) {
        priority = 'Critical';
    } else if (score >= 70) {
        priority = 'High';
    } else if (score >= 60) {
        priority = 'Medium';
    } else if (score >= 40) {
        priority = 'Low';
    }

    return priority;
}
