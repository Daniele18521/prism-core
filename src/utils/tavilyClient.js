/**
 * Client Tavily condiviso — usato da F0 (Extract) e F2 (Search).
 *
 * Centralizza la creazione del client e il controllo della API key,
 * così entrambe le fasi usano lo stesso comportamento in caso di errore.
 */

import { tavily } from '@tavily/core';
import dotenv from 'dotenv';
import { AppError } from './errors.js';

dotenv.config();

/**
 * Restituisce il client Tavily pronto all'uso.
 * Se manca TAVILY_API_KEY lancia AppError non retryable (configurazione assente).
 * @param {{ step?: string }} [options] - fase pipeline per etichettare l'errore (F0/F2)
 */
export const getTavilyClient = (options = {}) => {
  // Fase che ha richiesto il client (content_ingest o tavily_search)
  const step = options.step || 'tavily_config';
  // Legge la chiave dall'ambiente (file .env in sviluppo)
  const apiKey = process.env.TAVILY_API_KEY;
  // Senza chiave non possiamo né estrarre URL né fare ricerche web
  if (!apiKey) {
    throw new AppError('TAVILY_API_KEY non configurata.', {
      code: 'TAVILY_CONFIG',
      retryable: false,
      step,
    });
  }
  // Crea il client ufficiale @tavily/core con la chiave trimmata
  return tavily({ apiKey: apiKey.trim() });
};
