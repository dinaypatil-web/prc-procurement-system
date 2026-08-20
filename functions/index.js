// =========================================================
// FIREBASE CLOUD FUNCTIONS
// PRC Procurement System — Backend Logic
// =========================================================
const { onDocumentWritten }   = require("firebase-functions/v2/firestore");
const { onSchedule }          = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError }  = require("firebase-functions/v2/https");
const { initializeApp }       = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging }        = require("firebase-admin/messaging");

initializeApp();
const db  = getFirestore();
const msg = getMessaging();

// ── STATUS ENGINE (server-side mirror) ─────────────────────
function calculateStatus(prc, materials = []) {
  if (prc.isShortClosed)    return 'Short-Close';
  if (prc.isWrongPRC)       return 'Wrong PRC';
  if (prc.isPRNotApproved)  return 'PR Not Approved';
  if (prc.isFuturePRC)      return 'Future PRC';
  if (prc.isSystemIssue)    return 'System Issue';
  if (prc.inputFromStores || prc.inputFromEngineering ||
      prc.inputFromEndUser  || prc.inputFromVendor)
    return 'Inputs Required';
  if (prc.rfqNumber && !prc.offersReceived) return 'Awaiting Offer';
  if (prc.tcdNumber || prc.tcdApproved || prc.poNumber) return 'Process Completed';
  return 'Pending';
}

// ── TRIGGER: Recalculate status on PRC write ──────────────
exports.onPRCWrite = onDocumentWritten("prcs/{prcId}", async (event) => {
  const prcId = event.params.prcId;
  const after  = event.data?.after?.data();
  if (!after) return; // deleted

  // Fetch materials
  const matsSnap = await db.collection(`prcs/${prcId}/materials`).get();
  const materials = matsSnap.docs.map(d => d.data());

  const newStatus = calculateStatus(after, materials);
  if (newStatus === after.status) return; // no change

  await event.data.after.ref.update({ status: newStatus, statusUpdatedAt: FieldValue.serverTimestamp() });

  // Log the status change
  await db.collection('activityLogs').add({
    action:    'auto-status',
    collection:'PRCs',
    docId:     prcId,
    user:      'System',
    timestamp: FieldValue.serverTimestamp(),
    changes:   { status: { old: after.status, new: newStatus } }
  });

  // Update dashboard cache
  await updateDashboardCache();
});

// ── TRIGGER: Log all PRC changes to history ───────────────
exports.onPRCUpdate = onDocumentWritten("prcs/{prcId}", async (event) => {
  const before = event.data?.before?.data();
  const after  = event.data?.after?.data();
  if (!before || !after) return;

  const changes = {};
  const trackFields = [
    'allocationNumber','allocationDate','rfqNumber','rfqDate','tcdNumber','tcdDate',
    'poNumber','poDate','vendorName','remarks','status','priority','isShortClosed','isWrongPRC',
    'isPRNotApproved','isFuturePRC','isSystemIssue'
  ];

  trackFields.forEach(f => {
    if (before[f] !== after[f]) {
      changes[f] = { old: before[f] ?? null, new: after[f] ?? null };
    }
  });

  if (Object.keys(changes).length === 0) return;

  await db.collection(`prcs/${event.params.prcId}/history`).add({
    changes,
    user:      after.updatedBy || 'System',
    timestamp: FieldValue.serverTimestamp(),
    device:    'web'
  });
});

// ── SCHEDULED: Daily ageing & notification check ──────────
exports.dailyAgeingCheck = onSchedule("every day 08:00", async () => {
  const thresholds = { allocation: 2, rfq: 3, offer: 7, tcd: 3, po: 2 };
  const now = new Date();
  const prcsSnap = await db.collection('prcs')
    .where('status', 'not-in', ['Process Completed', 'Short Closed', 'Wrong PRC', 'PR Not Approved'])
    .get();

  const notifications = [];

  prcsSnap.docs.forEach(doc => {
    const prc = doc.data();
    const prcId = doc.id;

    const daysSince = field => {
      if (!prc[field]) return null;
      return Math.floor((now - prc[field].toDate()) / 86400000);
    };

    // Allocation pending
    const allocAge = daysSince('createdAt');
    if (!prc.allocationNumber && allocAge >= thresholds.allocation) {
      notifications.push({ type: 'warning', title: 'Allocation Pending',
        message: `${prcId} has not been allocated for ${allocAge} days.`, prcId });
    }

    // RFQ pending
    const allocatedAge = daysSince('allocationDate');
    if (prc.allocationNumber && !prc.rfqNumber && allocatedAge >= thresholds.rfq) {
      notifications.push({ type: 'warning', title: 'RFQ Pending',
        message: `RFQ not issued for ${prcId} — ${allocatedAge} days since allocation.`, prcId });
    }

    // Offer pending
    const rfqAge = daysSince('rfqDate');
    if (prc.rfqNumber && !prc.offersReceived && rfqAge >= thresholds.offer) {
      notifications.push({ type: 'danger', title: 'Offer Overdue',
        message: `No offers received for ${prcId} — ${rfqAge} days since RFQ.`, prcId });
    }

    // TCD pending
    const offerAge = prc.offersReceivedDate ? Math.floor((now - prc.offersReceivedDate.toDate()) / 86400000) : null;
    if (prc.offersReceived && !prc.tcdNumber && offerAge >= thresholds.tcd) {
      notifications.push({ type: 'warning', title: 'TCD Pending',
        message: `TCD not created for ${prcId} — ${offerAge} days since offers received.`, prcId });
    }

    // PO pending
    const tcdAge = daysSince('tcdApprovedDate');
    if (prc.tcdApproved && !prc.poNumber && tcdAge >= thresholds.po) {
      notifications.push({ type: 'danger', title: 'PO Overdue',
        message: `PO not issued for ${prcId} — ${tcdAge} days since TCD approval.`, prcId });
    }
  });

  // Write notifications
  const batch = db.batch();
  notifications.forEach(n => {
    const ref = db.collection('notifications').doc();
    batch.set(ref, { ...n, createdAt: FieldValue.serverTimestamp(), unread: true });
  });
  await batch.commit();

  console.log(`Daily check: ${notifications.length} notifications created`);
});

// ── CALLABLE: Generate report ─────────────────────────────
exports.generateReport = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in');

  const { reportType, filters } = request.data;
  let query = db.collection('prcs');

  if (filters?.status)     query = query.where('status',     '==', filters.status);
  if (filters?.department) query = query.where('department', '==', filters.department);

  const snap = await query.limit(10000).get();
  const prcs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { prcs, generatedAt: new Date().toISOString(), count: prcs.length };
});

// ── CALLABLE: Bulk status recalc ──────────────────────────
exports.recalculateAllStatuses = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in');

  const snap = await db.collection('prcs').get();
  const batch = db.batch();
  let updated = 0;

  for (const doc of snap.docs) {
    const prc = doc.data();
    const matsSnap = await doc.ref.collection('materials').get();
    const materials = matsSnap.docs.map(d => d.data());
    const newStatus = calculateStatus(prc, materials);

    if (newStatus !== prc.status) {
      batch.update(doc.ref, { status: newStatus, statusUpdatedAt: FieldValue.serverTimestamp() });
      updated++;
    }
  }

  await batch.commit();
  return { updated, total: snap.size };
});

// ── HELPER: Update dashboard cache ───────────────────────
async function updateDashboardCache() {
  const snap = await db.collection('prcs').get();
  const statusCounts = {};
  snap.docs.forEach(d => {
    const s = d.data().status || 'Pending';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  await db.collection('dashboardCache').doc('summary').set({
    total: snap.size,
    statusCounts,
    updatedAt: FieldValue.serverTimestamp()
  });
}
