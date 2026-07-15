/**
 * FIREBASE ADMIN — connessione al database permanente (Firestore).
 *
 * Firestore è dove finiscono i job completati (dopo Redis).
 * Il frontend legge da qui quando il job non è più in elaborazione.
 *
 * Questo file si avvia UNA volta all'import: se le credenziali mancano, il processo termina.
 */

import admin from 'firebase-admin';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import path from 'path';

let db;
let auth;

try {
  // NODE_ENV=production → file credenziali produzione, altrimenti dev
  const isProduction = process.env.NODE_ENV === 'production';

  const defaultPath = isProduction
    ? './firebase-credentials-prod.json'
    : './firebase-credentials_dev.json';

  // Percorso file JSON con chiavi servizio Google (può essere sovrascritto nel .env)
  const credentialsPath = process.env.FIREBASE_CREDENTIALS_PATH || defaultPath;
  const resolvedPath = path.resolve(credentialsPath);

  console.log(`ℹ️ [FIREBASE] Modalità rilevata: [${isProduction ? 'PRODUZIONE' : 'DEVELOPMENT'}]`);
  console.log(`ℹ️ [FIREBASE] Caricamento file chiavi da: ${resolvedPath}`);

  const serviceAccount = JSON.parse(readFileSync(resolvedPath, 'utf8'));

  // Inizializza l'SDK Firebase con le credenziali del service account
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = getFirestore();
  auth = admin.auth();

  console.log(`🔥 [FIREBASE] SDK agganciato correttamente in modalità ${isProduction ? 'PRODUZIONE' : 'DEVELOPMENT'}.`);
} catch (error) {
  console.error('❌ [FIREBASE] Errore critico di inizializzazione:', error.message);
  process.exit(1); // senza Firestore l'app non può salvare risultati → esci subito
}

// db = accesso Firestore | auth = autenticazione utenti | FieldValue/Timestamp = tipi Firestore
export { db, auth, FieldValue, Timestamp };
