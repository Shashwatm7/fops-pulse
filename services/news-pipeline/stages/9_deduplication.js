/**
 * Stage 9: Deduplication
 * Detects duplicate articles globally for a user.
 */
export function isDuplicate(article, alertedArticlesSet) {
    // Basic deduplication using a cleaned title hash
    const titleKey = article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    
    if (alertedArticlesSet.has(titleKey)) {
        return true;
    }

    // Advanced: could add embedding similarity dedup here later
    
    // Mark as seen
    alertedArticlesSet.add(titleKey);
    return false;
}
