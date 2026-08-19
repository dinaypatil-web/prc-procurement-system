// =========================================================
// PRC PROCUREMENT SYSTEM — FIREBASE CONFIGURATION (.ENV BASED)
// Configuration is loaded from /api/env, .env, or environment variables
// =========================================================

import { loadEnv, getEnv } from './env.js';

let FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAadw4srX9OFbNTxSoJDf_lPZ-KHrN8L6o",
  authDomain:        "procuretrack-3cb1c.firebaseapp.com",
  projectId:         "procuretrack-3cb1c",
  storageBucket:     "procuretrack-3cb1c.firebasestorage.app",
  messagingSenderId: "313091514958",
  appId:             "1:313091514958:web:2698e5d5ebd168e86d991f",
  measurementId:     "G-YW515VXH0G"
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
  return Boolean(
    FIREBASE_CONFIG.apiKey &&
    FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY" &&
    FIREBASE_CONFIG.apiKey.trim() !== ""
  );
}

// Global Firebase instances
let _db, _auth, _storage, _functions;
let _firebaseApp = null;
let _authModule = null;

/**
 * Initialize Firebase from environment configuration
 */
async function initFirebase() {
  if (_firebaseApp && _auth && _authModule) {
    return _firebaseApp;
  }

  // Load environment variables from /api/env or .env if available
  await loadEnv();

  const projectId = getEnv('FIREBASE_PROJECT_ID', FIREBASE_CONFIG.projectId || 'procuretrack-3cb1c');

  FIREBASE_CONFIG = {
    apiKey:            getEnv('FIREBASE_API_KEY', FIREBASE_CONFIG.apiKey || 'AIzaSyAadw4srX9OFbNTxSoJDf_lPZ-KHrN8L6o'),
    authDomain:        getEnv('FIREBASE_AUTH_DOMAIN', `${projectId}.firebaseapp.com`),
    projectId:         projectId,
    storageBucket:     getEnv('FIREBASE_STORAGE_BUCKET', getEnv('FIREBASE_STORAGE_BUCKET', FIREBASE_CONFIG.storageBucket || `${projectId}.firebasestorage.app`)),
    messagingSenderId: getEnv('FIREBASE_MESSAGING_SENDER_ID', FIREBASE_CONFIG.messagingSenderId || '313091514958'),
    appId:             getEnv('FIREBASE_APP_ID', FIREBASE_CONFIG.appId || '1:313091514958:web:2698e5d5ebd168e86d991f'),
    measurementId:     getEnv('FIREBASE_MEASUREMENT_ID', FIREBASE_CONFIG.measurementId || 'G-YW515VXH0G')
  };

  GEMINI_API_KEY = getEnv('GEMINI_API_KEY', GEMINI_API_KEY);

  if (!isFirebaseConfigured()) {
    console.warn("⚠️ Firebase API Key missing in environment variables. Please check Vercel settings or .env file.");
    return null;
  }

  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const { getFirestore, initializeFirestore } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const authMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const { getStorage } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
    const { getFunctions } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");

    _firebaseApp = initializeApp(FIREBASE_CONFIG);
    try {
      _db = initializeFirestore(_firebaseApp, {
        experimentalAutoDetectLongPolling: true
      });
    } catch (dbErr) {
      _db = getFirestore(_firebaseApp);
    }
    _auth = authMod.getAuth(_firebaseApp);
    _authModule = authMod;
    _storage = getStorage(_firebaseApp);
    _functions = getFunctions(_firebaseApp);

    console.info(`✅ Firebase initialized for project: ${FIREBASE_CONFIG.projectId} (long-polling auto-detect active)`);
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
    await initFirebase();
  }
  if (!_auth || !_authModule) {
    return { success: false, error: 'Firebase is not initialized. Please verify your environment variables on Vercel.' };
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
    await initFirebase();
  }
  if (!_auth || !_authModule) {
    return { success: false, error: 'Firebase is not initialized. Please verify your environment variables on Vercel.' };
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
    'auth/email-already-in-use':      'An account with this email already exists.',
    'auth/invalid-email':             'Invalid email address format.',
    'auth/weak-password':             'Password must be at least 6 characters.',
    'auth/user-not-found':            'No account found with this email.',
    'auth/wrong-password':            'Incorrect password.',
    'auth/invalid-credential':        'Invalid email or password credentials.',
    'auth/too-many-requests':         'Too many attempts. Please try again later.',
    'auth/network-request-failed':    'Network error. Please check your internet connection.',
    'auth/user-disabled':             'This account has been disabled.',
    'auth/configuration-not-found':   'Email/Password Authentication is not enabled in Firebase Console. Please go to Firebase Console → Authentication → Sign-in method and enable Email/Password.',
    'auth/operation-not-allowed':     'Email/Password sign-in is currently disabled. Please enable it in Firebase Console → Authentication → Sign-in method.',
    'auth/unauthorized-domain':       'Domain not authorized. Please add your domain to Firebase Console → Authentication → Settings → Authorized domains.'
  };
  return map[code] || `Authentication error (${code || 'unknown'})`;
}

/**
 * Ensure an authenticated session exists (signs in anonymously or uses existing session)
 */
export async function ensureFirebaseAuth() {
  if (!_auth || !_authModule) {
    await initFirebase();
  }
  if (!_auth || !_authModule) return null;

  if (_auth.currentUser) {
    return _serializeUser(_auth.currentUser);
  }

  // Auto sign in anonymously so the user is never blocked
  try {
    const cred = await _authModule.signInAnonymously(_auth);
    console.info("🔑 Auto-authenticated session created for guest user:", cred.user.uid);
    return _serializeUser(cred.user, 'Procurement Engineer');
  } catch (anonErr) {
    console.warn("Anonymous authentication fallback:", anonErr);
    // If anonymous sign-in is disabled in Firebase console, return a stable guest user UID
    let guestUid = localStorage.getItem('PRC_GUEST_UID');
    if (!guestUid) {
      guestUid = 'guest_' + Math.random().toString(36).substring(2, 11);
      localStorage.setItem('PRC_GUEST_UID', guestUid);
    }
    return {
      uid: guestUid,
      email: 'guest@procuretrack.local',
      name: 'Procurement Guest',
      displayName: 'Procurement Guest',
      avatar: 'PG',
      role: 'Procurement Engineer',
      isAnonymous: true
    };
  }
}

export function getDB() { return _db; }
export function getAuthInstance() { return _auth; }
export function getStorageInstance() { return _storage; }

export function getFirebaseDiagnostics() {
  return {
    projectId: FIREBASE_CONFIG.projectId || 'Not Configured',
    authDomain: FIREBASE_CONFIG.authDomain || 'Not Configured',
    apiKeyMasked: FIREBASE_CONFIG.apiKey ? (FIREBASE_CONFIG.apiKey.slice(0, 6) + '...' + FIREBASE_CONFIG.apiKey.slice(-4)) : 'Missing',
    storageBucket: FIREBASE_CONFIG.storageBucket || 'Not Configured',
    isConfigured: isFirebaseConfigured(),
    isInitialized: Boolean(_firebaseApp && _db)
  };
}

export async function testFirestoreConnection() {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Connection timed out (7s). Could not reach Cloud Firestore servers. Please check network/firewall or Firebase Console config.')), 7000)
  );

  try {
    await initFirebase();
    if (!_db) return { success: false, error: 'Firestore database instance not initialized. Verify API key and Project ID.' };

    try {
      await ensureFirebaseAuth();
    } catch (e) {
      console.warn("Auth initialization notice during test:", e);
    }

    const { doc, getDoc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const pingRef = doc(_db, 'workspaces/default/diagnostics/ping');
    const start = Date.now();

    const pingOp = (async () => {
      await setDoc(pingRef, { lastPing: new Date().toISOString(), client: 'web' }, { merge: true });
      const snap = await getDoc(pingRef);
      return snap;
    })();

    const snap = await Promise.race([pingOp, timeoutPromise]);
    const latency = Date.now() - start;
    return { success: snap.exists(), latencyMs: latency, projectId: FIREBASE_CONFIG.projectId };
  } catch (err) {
    return { success: false, error: err.message || 'Firestore connection test failed', code: err.code || 'UNKNOWN' };
  }
}

export {
  FIREBASE_CONFIG, GEMINI_API_KEY, GEMINI_MODEL, APP_CONFIG,
  isFirebaseConfigured, initFirebase,
  _db as db, _auth as auth, _storage as storage, _functions as functions
};
