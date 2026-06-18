// ── data-archive.js — Pillar 1: Raw Data Store (S3 substitute) ──
// Archives raw API responses to the local filesystem, organized by date.
// Structure: ./data-archive/{category}/{YYYY-MM-DD}/{timestamp}.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ARCHIVE_ROOT = path.join(__dirname, 'data-archive');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getDateDir(category) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const dir = path.join(ARCHIVE_ROOT, category, dateStr);
  ensureDir(dir);
  return dir;
}

function writeArchive(category, data, filenamePrefix = '') {
  try {
    const dir = getDateDir(category);
    const timestamp = Date.now();
    const filename = filenamePrefix
      ? `${filenamePrefix}_${timestamp}.json`
      : `${timestamp}.json`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  } catch (err) {
    console.error(`Archive write error (${category}):`, err.message);
    return null;
  }
}

// ── Public API ──

/**
 * Archive raw price data snapshot
 * @param {Object} livePrices - The full livePrices object { WHEAT: { current, change, ... }, ... }
 */
export function archivePrices(livePrices) {
  return writeArchive('prices', {
    timestamp: new Date().toISOString(),
    prices: livePrices,
  });
}

/**
 * Archive raw weather API response for a region
 * @param {string} regionName
 * @param {Object} rawResponse - The raw API response from WeatherAPI
 */
export function archiveWeather(regionName, rawResponse) {
  const safeName = regionName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  return writeArchive('weather', {
    timestamp: new Date().toISOString(),
    region: regionName,
    data: rawResponse,
  }, safeName);
}

/**
 * Archive raw news articles batch
 * @param {Array} articles - Array of article objects
 * @param {string} source - Source identifier (e.g., 'google_news', 'newsdata')
 */
export function archiveNews(articles, source = 'mixed') {
  return writeArchive('news', {
    timestamp: new Date().toISOString(),
    source,
    count: articles.length,
    articles,
  }, source);
}

/**
 * Get archive stats — count of files per category
 */
export function getArchiveStats() {
  const stats = {};
  const categories = ['prices', 'weather', 'news'];
  for (const cat of categories) {
    const catDir = path.join(ARCHIVE_ROOT, cat);
    if (!fs.existsSync(catDir)) {
      stats[cat] = { days: 0, files: 0 };
      continue;
    }
    const days = fs.readdirSync(catDir).filter(d => !d.startsWith('.'));
    let totalFiles = 0;
    for (const day of days) {
      const dayDir = path.join(catDir, day);
      try {
        totalFiles += fs.readdirSync(dayDir).filter(f => f.endsWith('.json')).length;
      } catch (e) {}
    }
    stats[cat] = { days: days.length, files: totalFiles };
  }
  return stats;
}
