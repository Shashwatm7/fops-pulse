import natural from 'natural';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelPath = path.join(__dirname, '..', 'classifier.json');

let classifier = null;

/**
 * Lazy loads the trained TF-IDF classifier.
 */
function loadClassifier() {
    return new Promise((resolve, reject) => {
        if (classifier) return resolve(classifier);
        if (!fs.existsSync(modelPath)) {
            console.warn(`[ML-CLASSIFIER] Warning: classifier.json not found at ${modelPath}. Skipping ML filter.`);
            return resolve(null);
        }
        natural.BayesClassifier.load(modelPath, null, function(err, loadedClassifier) {
            if (err) {
                console.error('[ML-CLASSIFIER] Failed to load ML model:', err);
                return resolve(null); // Fail open, don't crash the pipeline
            }
            classifier = loadedClassifier;
            resolve(classifier);
        });
    });
}

/**
 * Applies the TF-IDF Machine Learning Classifier to determine if an article is ham or spam.
 * @param {Object} article - The normalized article object.
 * @returns {Promise<Object>} { passed: boolean, reason: string }
 */
export async function applyMlClassifier(article) {
    const ml = await loadClassifier();
    if (!ml) {
        // If model failed to load, just let it pass through to the LLM.
        return { passed: true, reason: 'ML Model not loaded' };
    }

    const textToAnalyze = `${article.title || ''} ${article.content || ''}`;
    
    // Classify
    const classification = ml.classify(textToAnalyze);
    
    if (classification === 'spam') {
        return { passed: false, reason: 'Classified as SPAM by TF-IDF Model' };
    }

    return { passed: true, reason: 'Classified as HAM by TF-IDF Model' };
}
