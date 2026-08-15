// =========================================================
// PRC PROCUREMENT SYSTEM — FIREBASE CONFIGURATION (.ENV BASED)
// Configuration is loaded from .env / environment variables
// =========================================================

import { loadEnv, getEnv } from './env.js';

let FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
  measurementId:     "YOUR_MEASUREMENT_ID"
};

let GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
const GEMINI_MODEL = "gemini-2.0-flash";

// App constants
const APP_CONFIG = {
  name:    "ProcureTrack",
  version: "1.0.0",
  company: "Enterprise Procurement",
  ageThresholds: {
    allocation: 2,
    rfq:        3,
    offer:      7,
    tcd:        3,
    po:         2
  },
  defaultPageSize: 25,
  pageSizeOptions: [10, 25, 50, 100]
};

// Detect if Firebase is configured
function isFirebaseConfigured() {
  return FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" && FIREBASE_CONFIG.projectId !== "YOUR_PROJECT_ID";
}

// Global Firebase instances
let _db, _auth, _storage, _functions;
let _firebaseApp = null;
let _authModule = null;

/**
 * Initialize Firebase from .env configuration
 */
async function initFirebase() {
  // Load environment variables from .env
  await loadEnv();

  FIREBASE_CONFIG = {
    apiKey:            getEnv('FIREBASE_API_KEY', 'YOUR_API_KEY'),
    authDomain:        getEnv('FIREBASE_AUTH_DOMAIN', `${getEnv('FIREBASE_PROJECT_ID', 'YOUR_PROJECT_ID')}.firebaseapp.com`),
    projectId:         getEnv('FIREBASE_PROJECT_ID', 'YOUR_PROJECT_ID'),
    storageBucket:     getEnv('FIREBASE_STORAGE_BUCKET', `${getEnv('FIREBASE_PROJECT_ID', 'YOUR_PROJECT_ID')}.appspot.com`),
    messagingSenderId: getEnv('FIREBASE_MESSAGING_SENDER_ID', 'YOUR_SENDER_ID'),
    appId:             getEnv('FIREBASE_APP_ID', 'YOUR_APP_ID'),
    measurementId:     getEnv('FIREBASE_MEASUREMENT_ID', '')
  };

  GEMINI_API_KEY = getEnv('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY');

  if (!isFirebaseConfigured()) {
    console.warn("⚠️ Firebase configuration missing in .env file. Please check .env.example.");
    return null;
  }

  try {
    const { initializeApp }  = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const { getFirestore }   = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const authMod            = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const { getStorage }     = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
    const { getFunctions }   = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");

    _firebaseApp = initializeApp(FIREBASE_CONFIG);
    _db          = getFirestore(_firebaseApp);
    _auth        = authMod.getAuth(_firebaseApp);
    _authModule  = authMod;
    _storage     = getStorage(_firebaseApp);
    _functions   = getFunctions(_firebaseApp);

    console.info(`✅ Firebase initialized for project: ${FIREBASE_CONFIG.projectId}`);
    return _firebaseApp;
  } catch (err) {
    console.error("Firebase initialization failed:", err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// AUTH FUNCTIONS — Email/Password Authentication
// ═══════════════════════════════════════════════════════════

/**
 * Sign up / create a new user account
 */
export async function signUp(email, password, displayName, role = 'Procurement Engineer') {
  if (!_auth || !_authModule) {
    return { success: false, error: 'Firebase is not initialized. Please verify .env configuration.' };
  }
  try {
    const cred = await _authModule.createUserWithEmailAndPassword(_auth, email, password);
    if (displayName) {
      await _authModule.updateProfile(cred.user, { displayName });
    }
    const userObj = _serializeUser(cred.user, role);

    // Save profile to Firestore immediately
    try {
      const { doc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      if (_db) {
        await setDoc(doc(_db, `users/${userObj.uid}`), {
          name: userObj.name,
          email: userObj.email,
          role: role,
          avatar: userObj.avatar,
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString()
        }, { merge: true });
      }
    } catch (dbErr) {
      console.warn("Could not save initial user profile doc:", dbErr);
    }

    return { success: true, user: userObj };
  } catch (err) {
    return { success: false, error: _friendlyAuthError(err.code) };
  }
}

/**
 * Sign in an existing user
 */
export async function signIn(email, password) {
  if (!_auth || !_authModule) {
    return { success: false, error: 'Firebase is not initialized. Please verify .env configuration.' };
  }
  try {
    const cred = await _authModule.signInWithEmailAndPassword(_auth, email, password);
    
    // Fetch custom role from Firestore profile if exists
    let role = 'User';
    try {
      const { doc, getDoc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      if (_db) {
        const snap = await getDoc(doc(_db, `users/${cred.user.uid}`));
        if (snap.exists()) {
          role = snap.data().role || 'User';
          await updateDoc(doc(_db, `users/${cred.user.uid}`), {
            lastLoginAt: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      // ignore
    }

    return { success: true, user: _serializeUser(cred.user, role) };
  } catch (err) {
    return { success: false, error: _friendlyAuthError(err.code) };
  }
}

/**
 * Sign out the current user
 */
export async function signOutUser() {
  if (!_auth || !_authModule) return;
  try {
    await _authModule.signOut(_auth);
  } catch (err) {
    console.error('Sign out failed:', err);
  }
}

/**
 * Listen for auth state changes
 */
export function onAuthChange(callback) {
  if (!_auth || !_authModule) {
    setTimeout(() => callback(null), 0);
    return () => {};
  }
  return _authModule.onAuthStateChanged(_auth, async (firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }

    // Try to load role from Firestore
    let role = 'User';
    try {
      const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      if (_db) {
        const snap = await getDoc(doc(_db, `users/${firebaseUser.uid}`));
        if (snap.exists()) {
          role = snap.data().role || 'User';
        }
      }
    } catch (e) {
      // fallback
    }

    callback(_serializeUser(firebaseUser, role));
  });
}

/**
 * Get current user
 */
export function getCurrentUser() {
  if (!_auth) return null;
  const u = _auth.currentUser;
  return u ? _serializeUser(u) : null;
}

function _serializeUser(firebaseUser, role = 'User') {
  const name = firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User';
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email || '',
    name: name,
    displayName: name,
    avatar: name.slice(0, 2).toUpperCase(),
    role: role,
    photoURL: firebaseUser.photoURL || null
  };
}

function _friendlyAuthError(code) {
  const map = {
    'auth/email-already-in-use':    'An account with this email already exists.',
    'auth/invalid-email':           'Invalid email address format.',
    'auth/weak-password':           'Password must be at least 6 characters.',
    'auth/user-not-found':          'No account found with this email.',
    'auth/wrong-password':          'Incorrect password.',
    'auth/invalid-credential':      'Invalid email or password credentials.',
    'auth/too-many-requests':       'Too many attempts. Please try again later.',
    'auth/network-request-failed':  'Network error. Please check your internet connection.',
    'auth/user-disabled':           'This account has been disabled.'
  };
  return map[code] || `Authentication error (${code || 'unknown'})`;
}

export {
  FIREBASE_CONFIG, GEMINI_API_KEY, GEMINI_MODEL, APP_CONFIG,
  isFirebaseConfigured, initFirebase,
  _db as db, _auth as auth, _storage as storage, _functions as functions
};
