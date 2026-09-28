import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getStorage, connectStorageEmulator } from "firebase/storage";

// Dynamic Configurations
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize
const emulator = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';
const app = initializeApp(emulator ? { ...firebaseConfig, projectId: 'demo-myfin-edition', apiKey: 'demo-key', authDomain: 'localhost', storageBucket: 'demo-myfin-edition.appspot.com' } : firebaseConfig);
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const auth = getAuth(app);
const storage = getStorage(app);
if (emulator) { connectFirestoreEmulator(db, '127.0.0.1', 8080); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectStorageEmulator(storage, '127.0.0.1', 9199); }

export { db, auth, storage };
