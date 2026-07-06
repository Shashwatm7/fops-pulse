import axios from 'axios';
import * as cheerio from 'cheerio';
import nlp from 'compromise';
import natural from 'natural';

export async function fetchAndExtractArticle(url) {
    try {
        // 1. Fetch HTML
        const { data: html } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 5000
        });

        // 2. Parse HTML and extract paragraphs
        const $ = cheerio.load(html);
        let text = '';
        $('p').each((i, el) => {
            const pText = $(el).text().trim();
            if (pText.length > 50) { // Filter out short junk
                text += pText + ' ';
            }
        });

        if (text.length < 100) return null;

        // 3. Extract Entities with Compromise
        const doc = nlp(text);
        const organizations = doc.organizations().out('array');
        const places = doc.places().out('array');
        const values = doc.values().out('array');

        // Deduplicate entities
        const uniqueOrgs = [...new Set(organizations)].slice(0, 5);
        const uniquePlaces = [...new Set(places)].slice(0, 5);
        const uniqueValues = [...new Set(values)].slice(0, 5);

        // 4. Summarize with Natural (TF-IDF approximation)
        const TfIdf = natural.TfIdf;
        const tfidf = new TfIdf();
        
        // Split text into sentences
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
        
        if (sentences.length <= 3) {
            return {
                summary: text,
                entities: { organizations: uniqueOrgs, places: uniquePlaces, values: uniqueValues }
            };
        }

        tfidf.addDocument(text);
        
        // Score each sentence by its terms' TF-IDF weight in the document
        const scoredSentences = sentences.map((sentence, idx) => {
            let score = 0;
            const tokenizer = new natural.WordTokenizer();
            const words = tokenizer.tokenize(sentence);
            
            words.forEach(word => {
                // Approximate term importance
                score += tfidf.tfidf(word, 0); 
            });
            
            // Normalize score by sentence length to prevent bias toward long run-on sentences
            return { sentence: sentence.trim(), score: score / (words.length || 1), originalIndex: idx };
        });

        // Sort by score and pick top 3
        scoredSentences.sort((a, b) => b.score - a.score);
        const topSentences = scoredSentences.slice(0, 3)
                                .sort((a, b) => a.originalIndex - b.originalIndex)
                                .map(s => s.sentence);

        return {
            summary: topSentences.join(' '),
            entities: {
                organizations: uniqueOrgs,
                places: uniquePlaces,
                values: uniqueValues
            }
        };

    } catch (err) {
        console.error('NLP Extraction failed for URL:', url, err.message);
        return null;
    }
}
