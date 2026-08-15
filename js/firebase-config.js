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

async function initFirebase() {
  if (!isFirebaseConfigured()) {
    console.info("🔶 Firebase not configured — running in DEMO mode with mock data.");
    return null;
  }
  try {
    const { initializeApp }  = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const { getFirestore }   = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { getAuth }        = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
    const { getStorage }     = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
    const { getFunctions }   = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js");

    const app   = initializeApp(FIREBASE_CONFIG);
    _db         = getFirestore(app);
    _auth       = getAuth(app);
    _storage    = getStorage(app);
    _functions  = getFunctions(app);

    console.info("✅ Firebase initialized.");
    return app;
  } catch (err) {
    console.error("Firebase init failed:", err);
    return null;
  }
}

export {
  FIREBASE_CONFIG, GEMINI_API_KEY, GEMINI_MODEL, APP_CONFIG,
  isFirebaseConfigured, initFirebase,
  _db as db, _auth as auth, _storage as storage, _functions as functions
};
