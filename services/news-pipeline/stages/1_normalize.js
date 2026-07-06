import * as entities from 'entities';

/**
 * Stage 1: Normalize Article
 * Removes HTML, decodes entities, normalizes whitespace, and lowercases text for searching.
 */
export function normalizeArticle(article) {
    const stripHtml = (html) => {
        if (!html) return '';
        // Remove CDATA
        let text = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
        // Remove HTML tags
        text = text.replace(/<[^>]*>?/gm, ' ');
        // Decode HTML entities
        text = entities.decodeHTML(text);
        // Normalize whitespace
        text = text.replace(/\s+/g, ' ').trim();
        return text;
    };

    return {
        ...article,
        titleNorm: stripHtml(article.title).toLowerCase(),
        descNorm: stripHtml(article.description).toLowerCase(),
        contentNorm: stripHtml(article.content).toLowerCase(),
        // Full normalized text for easy searching
        fullTextNorm: stripHtml(`${article.title} ${article.description} ${article.content}`).toLowerCase()
    };
}
