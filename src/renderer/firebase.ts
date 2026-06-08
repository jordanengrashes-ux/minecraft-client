import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, GoogleAuthProvider, signInWithPopup, signOut,
  browserLocalPersistence, setPersistence,
} from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyDiiPTWvpdDBkeazQRz79MSp_RfcDlarOs",
  authDomain: "tank-d367c.firebaseapp.com",
  databaseURL: "https://tank-d367c-default-rtdb.firebaseio.com",
  projectId: "tank-d367c",
  storageBucket: "tank-d367c.firebasestorage.app",
  messagingSenderId: "479668253104",
  appId: "1:479668253104:web:c8e2a735e2b8da111be675",
};

const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);

// Explicitly set local persistence so auth state survives Electron restarts via IndexedDB
setPersistence(auth, browserLocalPersistence).catch(() => {});

export async function loginEmail(email: string, password: string) {
  const { user } = await signInWithEmailAndPassword(auth, email, password);
  return { uid: user.uid, name: user.displayName || user.email?.split('@')[0] || 'Player', email: user.email || '' };
}

export async function registerEmail(email: string, password: string, username: string) {
  const { user } = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(user, { displayName: username });
  return { uid: user.uid, name: username, email: user.email || email };
}

export async function loginGoogle() {
  const provider = new GoogleAuthProvider();
  const { user } = await signInWithPopup(auth, provider);
  return { uid: user.uid, name: user.displayName || 'Player', email: user.email || '' };
}

export { signOut };
