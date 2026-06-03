import admin from 'firebase-admin';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'; // 🟢 Estrazione nativa per ES Modules
import { readFileSync } from 'fs';
import path from 'path';

let db;
let auth;

try {
  const isProduction = process.env.NODE_ENV === 'production';
  
  // 🟢 REGOLA DI FALLBACK SE LA CHIAVE NEL .ENV NON VIENE TROVATA:
  const defaultPath = isProduction 
    ? './firebase-credentials-prod.json' 
    : './firebase-credentials_dev.json'; 
    
  // Prende il percorso dal tuo .env
  const credentialsPath = process.env.FIREBASE_CREDENTIALS_PATH || defaultPath;
  const resolvedPath = path.resolve(credentialsPath);
  
  console.log(`ℹ️ [FIREBASE] Modalità rilevata: [${isProduction ? 'PRODUZIONE' : 'DEVELOPMENT'}]`);
  console.log(`ℹ️ [FIREBASE] Caricamento file chiavi da: ${resolvedPath}`);

  const serviceAccount = JSON.parse(readFileSync(resolvedPath, 'utf8'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  // 🟢 Inizializzazione pulita tramite l'SDK Firestore dedicato
  db = getFirestore();
  auth = admin.auth();
  
  console.log(`🔥 [FIREBASE] SDK agganciato correttamente in modalità ${isProduction ? 'PRODUZIONE' : 'DEVELOPMENT'}.`);
} catch (error) {
  console.error('❌ [FIREBASE] Errore critico di inizializzazione:', error.message);
  process.exit(1); 
}

// 🟢 Esportiamo db, auth, FieldValue e Timestamp per il worker e i servizi
export { db, auth, FieldValue, Timestamp };