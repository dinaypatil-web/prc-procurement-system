// =========================================================
// PRC PROCUREMENT SYSTEM — FIREBASE CONFIGURATION
// Replace the placeholder values with your Firebase project config
// =========================================================

// ⚠️  IMPORTANT: Replace these values with your actual Firebase config or enter them via Settings UI.
// Go to Firebase Console → Project Settings → Your Apps → Web App → SDK Setup
const DEFAULT_FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
  measurementId:     "YOUR_MEASUREMENT_ID"
};

function loadFirebaseConfig() {
  try {
    const saved = localStorage.getItem('CUSTOM_FIREBASE_CONFIG');
    if (saved) return JSON.parse(saved);
  } catch(e) {
    console.error('Error reading saved Firebase config:', e);
  }
  return DEFAULT_FIREBASE_CONFIG;
}

const FIREBASE_CONFIG = loadFirebaseConfig();

export function saveFirebaseConfig(config) {
  try {
    localStorage.setItem('CUSTOM_FIREBASE_CONFIG', JSON.stringify(config));
    Object.assign(FIREBASE_CONFIG, config);
    return true;
  } catch(e) {
    console.error('Failed to save Firebase config:', e);
    return false;
  }
}

export function resetFirebaseConfig() {
  localStorage.removeItem('CUSTOM_FIREBASE_CONFIG');
  Object.assign(FIREBASE_CONFIG, DEFAULT_FIREBASE_CONFIG);
}

// Gemini AI API Key — used for the AI Procurement Assistant
// Get one at https://aistudio.google.com/app/apikey
const GEMINI_API_KEY = localStorage.getItem('CUSTOM_GEMINI_API_KEY') || "YOUR_GEMINI_API_KEY";
const GEMINI_MODEL   = "gemini-2.0-flash";

export function saveGeminiKey(key) {
  if (key) localStorage.setItem('CUSTOM_GEMINI_API_KEY', key);
  else localStorage.removeItem('CUSTOM_GEMINI_API_KEY');
}

// App constants
const APP_CONFIG = {
  name:    "ProcureTrack",
  version: "1.0.0",
  company: "Enterprise Procurement",
  // Database Created By App Owner
  databaseOwner: "App Owner (Super Admin)",
  databaseId: "DB-PRC-APP-OWNER-MASTER-01",
  creatorDatabaseKey: "PRC_PROCUREMENT_APP_OWNER_DATABASE_V1",
  // Ageing thresholds (days) — turns indicator yellow/orange/red
  ageThresholds: {
    allocation:  2,
    rfq:         3,
    offer:       7,
    tcd:         3,
    po:          2
  },
  // Pagination
  defaultPageSize: 25,
  pageSizeOptions: [10, 25, 50, 100],
  // Demo mode – uses mock data when Firebase is not configured
  demoMode: true
};

// Detect if Firebase is configured
function isFirebaseConfigured() {
  return FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

// Initialize Firebase (only if configured)
let _db, _auth, _storage, _functions;
let _firebaseApp = null;
let _authModule = null;

async function initFirebase() {
  if (!isFirebaseConfigured()) {
    console.info("🔶 Firebase not configured — running in DEMO mode with mock data.");
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

    console.info("✅ Firebase initialized.");
    return _firebaseApp;
  } catch (err) {
    console.error("Firebase init failed:", err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// AUTH FUNCTIONS — Email/Password Authentication
// ═══════════════════════════════════════════════════════════

/**
 * Sign up a new user with email, password, and display name.
 * @returns {{ success: boolean, user?: object, error?: string }}
 */
export async function signUp(email, password, displayName) {
  if (!_auth || !_authModule) return { success: false, error: 'Firebase not initialized. Please configure Firebase in Settings.' };
  try {
    const cred = await _authModule.createUserWithEmailAndPassword(_auth, email, password);
    if (displayName) {
      await _authModule.updateProfile(cred.user, { displayName });
    }
    return { success: true, user: _serializeUser(cred.user) };
  } catch (err) {
    return { success: false, error: _friendlyAuthError(err.code) };
  }
}

/**
 * Sign in an existing user with email and password.
 * @returns {{ success: boolean, user?: object, error?: string }}
 */
export async function signIn(email, password) {
  if (!_auth || !_authModule) return { success: false, error: 'Firebase not initialized. Please configure Firebase in Settings.' };
  try {
    const cred = await _authModule.signInWithEmailAndPassword(_auth, email, password);
    return { success: true, user: _serializeUser(cred.user) };
  } catch (err) {
    return { success: false, error: _friendlyAuthError(err.code) };
  }
}

/**
 * Sign out the current user.
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
 * Listen for auth state changes. Calls callback(user | null).
 * Returns an unsubscribe function.
 */
export function onAuthChange(callback) {
  if (!_auth || !_authModule) {
    // Firebase not initialized — call back with null immediately
    setTimeout(() => callback(null), 0);
    return () => {};
  }
  return _authModule.onAuthStateChanged(_auth, (firebaseUser) => {
    callback(firebaseUser ? _serializeUser(firebaseUser) : null);
  });
}

/**
 * Get the currently signed-in user, or null.
 */
export function getCurrentUser() {
  if (!_auth) return null;
  const u = _auth.currentUser;
  return u ? _serializeUser(u) : null;
}

// ── Helpers ────────────────────────────────────────────────

function _serializeUser(firebaseUser) {
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email || '',
    name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
    displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
    avatar: (firebaseUser.displayName || firebaseUser.email || 'U').slice(0, 2).toUpperCase(),
    role: 'User', // Default role — can be upgraded from Firestore user profile
    photoURL: firebaseUser.photoURL || null
  };
}

function _friendlyAuthError(code) {
  const map = {
    'auth/email-already-in-use':    'An account with this email already exists.',
    'auth/invalid-email':           'Invalid email address.',
    'auth/weak-password':           'Password should be at least 6 characters.',
    'auth/user-not-found':          'No account found with this email.',
    'auth/wrong-password':          'Incorrect password.',
    'auth/invalid-credential':      'Invalid email or password.',
    'auth/too-many-requests':       'Too many attempts. Please try again later.',
    'auth/network-request-failed':  'Network error. Check your internet connection.',
    'auth/user-disabled':           'This account has been disabled.'
  };
  return map[code] || `Authentication error: ${code}`;
}

export {
  FIREBASE_CONFIG, GEMINI_API_KEY, GEMINI_MODEL, APP_CONFIG,
  isFirebaseConfigured, initFirebase,
  _db as db, _auth as auth, _storage as storage, _functions as functions
};
