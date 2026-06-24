import { tavily } from '@tavily/core';
import dotenv from 'dotenv';

dotenv.config();

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

/**
 * Ricerca etichettata da plan Shaper.
 * @param {Array<{pillar: string, query: string}>} plan
 * @returns {{ rawResults: Array<{content, title, url, retrievedAt}> }}
 */
export const performWebSearch = async (plan) => {
  console.log('🌐 F2: Ricerca etichettata Tavily...');

  const entries = Array.isArray(plan) ? plan : [];
  const queries = entries.map((p) => (typeof p === 'string' ? p : p.query)).filter(Boolean);

  if (queries.length === 0) {
    return { rawResults: [] };
  }

  try {
    const searchPromises = queries.map((query) =>
      tvly.search(query, {
        searchDepth: 'advanced',
        maxResults: 3,
        includeAnswer: false,
        includeImages: false,
        includeRawContent: false,
      })
    );

    const results = await Promise.all(searchPromises);
    const retrievedAt = new Date().toISOString();

    const rawResults = results.flatMap((res, idx) =>
      res.results.map((source) => ({
        title: source.title || '',
        url: source.url || '',
        content: source.content ? source.content.substring(0, 4000) : '',
        retrievedAt,
        pillar: entries[idx]?.pillar || '',
      }))
    );

    console.log(`✅ F2 completata: ${rawResults.length} fonti.`);
    return { rawResults };
  } catch (error) {
    console.error('❌ Errore performWebSearch:', error);
    throw error;
  }
};
