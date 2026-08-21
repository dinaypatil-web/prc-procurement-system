// =========================================================
// AI PROCUREMENT ASSISTANT (Gemini API)
// =========================================================
import { GEMINI_API_KEY, GEMINI_MODEL } from './firebase-config.js';
import { getState } from './state.js';
import { fmtDate, fmtNum } from './utils.js';
import { STATUS, getPRCAge } from './status-engine.js';

// Pre-built query suggestions
export const AI_SUGGESTIONS = [
  "Which PRCs are overdue and need immediate attention?",
  "Which RFQs have been pending for more than 7 days?",
  "Which vendors have the fastest response time?",
  "Which procurement engineer has the highest workload?",
  "What is the average time from allocation to PO issuance?",
  "Which materials are repeatedly delayed?",
  "Show a summary of today's procurement activities.",
  "Which PRCs are in 'Partly Completed' status?",
  "Recommend procurement priorities for this week.",
  "How many PRCs are pending allocation?"
];

/** Build context string from current state for the AI */
function buildContext() {
  const state = getState();
  const prcs  = state.prcs || [];
  const today = new Date().toISOString().split('T')[0];

  const summary = state.statusSummary || {};
  const vendors = (state.vendors || []).slice(0, 10);

  const overdue = prcs.filter(p => {
    const age = getPRCAge(p);
    return age > 7 && ![STATUS.COMPLETED, STATUS.WRONG_PRC, STATUS.PR_NOT_APPROVED, STATUS.FUTURE_PRC, STATUS.SYSTEM_ISSUE].includes(p.status);
  });

  const pendingRFQ = prcs.filter(p => !p.rfqNumber && p.allocationNumber && !p.poNumber);
  const pendingPO  = prcs.filter(p => p.rfqNumber && p.offersReceived && !p.poNumber);

  // Engineer workloads
  const workload = {};
  prcs.forEach(p => {
    if (p.engineer) workload[p.engineer] = (workload[p.engineer] || 0) + 1;
  });
  const topEngineer = Object.entries(workload).sort((a,b) => b[1]-a[1]).slice(0,5);

  // Vendor distribution
  const vendorDist = {};
  prcs.forEach(p => {
    if (p.vendorName) vendorDist[p.vendorName] = (vendorDist[p.vendorName] || 0) + 1;
  });

  return `
You are an AI Procurement Assistant for an enterprise procurement tracking system.
Today's date: ${today}

PROCUREMENT SUMMARY:
- Total PRCs: ${prcs.length}
- Process Completed: ${summary[STATUS.COMPLETED] || 0}
- Pending: ${summary[STATUS.PENDING] || 0}
- Partly Completed: ${summary[STATUS.PARTLY_COMPLETED] || 0}
- Awaiting Offer: ${summary[STATUS.AWAITING_OFFER] || 0}
- Inputs Required: ${summary[STATUS.INPUTS_REQUIRED] || 0}
- Wrong PRC: ${summary[STATUS.WRONG_PRC] || 0}
- PR Not Approved: ${summary[STATUS.PR_NOT_APPROVED] || 0}
- Future PRC: ${summary[STATUS.FUTURE_PRC] || 0}
- System Issue: ${summary[STATUS.SYSTEM_ISSUE] || 0}
- Total Overdue (>7 days): ${overdue.length}
- Pending RFQ: ${pendingRFQ.length}
- Pending PO: ${pendingPO.length}
- Avg Procurement Days: ${state.avgProcurementDays}

TOP OVERDUE PRCs (first 5):
${overdue.slice(0,5).map(p => `- ${p.prNumber}: ${p.status}, Dept: ${p.department}, Allocated: ${fmtDate(p.allocationDate)}`).join('\n') || 'None'}

ENGINEER WORKLOADS:
${topEngineer.map(([e,c]) => `- ${e}: ${c} PRCs`).join('\n') || 'No data'}

VENDOR DISTRIBUTION (top 5 by PO):
${Object.entries(vendorDist).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([v,c]) => `- ${v}: ${c} POs`).join('\n') || 'No data'}

Answer the user's procurement questions clearly and concisely using this data.
Format responses with bullet points or numbered lists where helpful.
Be direct and actionable. If you need more specific data that isn't available, say so.
`;
}

/** Call Gemini API */
async function callGemini(messages) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY') {
    // Demo response
    return getDemoResponse(messages[messages.length - 1].parts[0].text);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: messages,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from AI.';
}

/** Demo responses for when no API key is configured */
function getDemoResponse(question) {
  const state  = getState();
  const prcs   = state.prcs || [];
  const summary= state.statusSummary || {};

  const q = question.toLowerCase();

  if (q.includes('overdue')) {
    const overdue = prcs.filter(p => {
      const age = getPRCAge(p);
      return age > 7 && p.status !== STATUS.COMPLETED;
    });
    return `📊 **Overdue PRCs (>7 days)**\n\nFound **${overdue.length}** overdue PRCs:\n${
      overdue.slice(0,5).map(p => `• ${p.prNumber} — ${p.status} (Dept: ${p.department})`).join('\n')
    }${overdue.length > 5 ? `\n…and ${overdue.length - 5} more.` : ''}\n\n💡 **Recommendation**: Prioritize allocation and RFQ issuance for these records immediately.`;
  }

  if (q.includes('rfq') && q.includes('pending')) {
    const pending = prcs.filter(p => p.allocationNumber && !p.rfqNumber && !p.poNumber);
    return `📨 **RFQ Pending PRCs**\n\nFound **${pending.length}** PRCs awaiting RFQ:\n${
      pending.slice(0,5).map(p => `• ${p.prNumber} — Allocated: ${fmtDate(p.allocationDate)} (${p.engineer || 'Unassigned'})`).join('\n')
    }\n\n💡 Float RFQs for these immediately to avoid further delays.`;
  }

  if (q.includes('workload') || q.includes('engineer')) {
    const wl = {};
    prcs.forEach(p => { if (p.engineer) wl[p.engineer] = (wl[p.engineer]||0)+1; });
    const sorted = Object.entries(wl).sort((a,b)=>b[1]-a[1]);
    return `👷 **Engineer Workload Analysis**\n\n${sorted.map(([e,c],i) => `${i+1}. ${e}: **${c} PRCs**`).join('\n')}\n\n💡 Consider redistributing workload from the top 2 engineers to maintain SLA.`;
  }

  if (q.includes('vendor') || q.includes('fastest')) {
    const vs = state.vendors || [];
    const sorted = [...vs].sort((a,b) => a.avgResponseDays - b.avgResponseDays);
    return `🏢 **Vendor Response Performance**\n\n${sorted.map((v,i) => `${i+1}. ${v.name}: avg **${v.avgResponseDays} days** (Rating: ${v.rating}⭐)`).join('\n')}\n\n💡 Prefer ${sorted[0]?.name || 'top vendors'} for urgent RFQs.`;
  }

  if (q.includes('summary') || q.includes('today')) {
    return `📋 **Procurement Summary — Today**\n\n• Total PRCs: **${prcs.length}**\n• Completed: **${summary[STATUS.COMPLETED]||0}**\n• Pending: **${summary[STATUS.PENDING]||0}**\n• Awaiting Offer: **${summary[STATUS.AWAITING_OFFER]||0}**\n• Partly Completed: **${summary[STATUS.PARTLY_COMPLETED]||0}**\n• Overdue: **${state.overdueCount||0}**\n• Avg Procurement Days: **${state.avgProcurementDays}**\n\n💡 Focus on the ${summary[STATUS.AWAITING_OFFER]||0} PRCs awaiting vendor offers.`;
  }

  if (q.includes('priority') || q.includes('recommend')) {
    const crit = prcs.filter(p => p.priority === 'Critical' && p.status !== STATUS.COMPLETED);
    return `🎯 **Procurement Priority Recommendations**\n\n**Critical Priority PRCs (${crit.length}):**\n${
      crit.slice(0,5).map(p => `• ${p.prNumber} — ${p.status} (${p.department})`).join('\n')
    }\n\n**This Week's Action Items:**\n1. Resolve ${state.statusSummary?.[STATUS.INPUTS_REQUIRED]||0} 'Inputs Required' PRCs\n2. Issue RFQ for allocated PRCs pending > 3 days\n3. Follow up on ${state.statusSummary?.[STATUS.AWAITING_OFFER]||0} pending quotations\n4. Approve pending TCDs`;
  }

  return `🤖 **AI Procurement Assistant**\n\nI can help you with:\n• Overdue PRC analysis\n• RFQ & PO tracking\n• Vendor performance\n• Engineer workload\n• Procurement recommendations\n• Status summaries\n\nTry asking: *"Which PRCs are overdue?"* or *"Show vendor performance."*\n\n*(Note: Connect a Gemini API key for full AI capabilities.)*`;
}

/** Chat history for conversation context */
let chatHistory = [];

/** Send a message and get AI response */
export async function sendMessage(userMessage) {
  const context = buildContext();

  // Add system context on first message
  if (chatHistory.length === 0) {
    chatHistory.push({ role: 'user',  parts: [{ text: context }] });
    chatHistory.push({ role: 'model', parts: [{ text: 'Understood. I am ready to assist with procurement analysis.' }] });
  }

  chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });

  const response = await callGemini(chatHistory);
  chatHistory.push({ role: 'model', parts: [{ text: response }] });

  // Keep history manageable (last 20 messages)
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

  return response;
}

/** Clear conversation history */
export function clearChat() { chatHistory = []; }

/** Format AI response markdown to HTML */
export function formatAIResponse(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^#{1,3} (.+)$/gm, '<strong style="font-size:1.05em">$1</strong>')
    .replace(/^• (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul style="margin:8px 0 8px 16px;display:flex;flex-direction:column;gap:4px">${m}</ul>`)
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
