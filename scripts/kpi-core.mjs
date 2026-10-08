// Shared KPI logic. Imported by scripts/sync.mjs (Node) AND by index.html
// (browser), so a tile's number and its drill-down list always come from the
// same function: count = list.length, $ = sum of the list. No DOM, no Node APIs.

export const DAY = 864e5;
const norm = s => String(s ?? '').trim().toLowerCase();
const inRange = (iso, from, to) => { const t = Date.parse(iso); return t >= from && t < to; };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const sum = rows => rows.reduce((t, r) => t + (Number(r.value) || 0), 0);

export const PERIOD_KEYS = ['today', 'yesterday', 'last7', 'last30', 'last90', 'thisMonth', 'lastMonth'];

// Calendar boundaries are computed in the business time zone offset given
// (minutes east of UTC, e.g. -240 for EDT) so "Today" means Indiana's today.
export function periodRange(key, now, tzOffsetMin = 0) {
  const off = tzOffsetMin * 60000;
  const local = new Date(now + off);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off;
  const month = (y, m) => Date.UTC(y, m, 1) - off;
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  switch (key) {
    case 'today': return { key, label: 'Today', from: dayStart, to: now, prevFrom: dayStart - DAY, prevTo: dayStart };
    case 'yesterday': return { key, label: 'Yesterday', from: dayStart - DAY, to: dayStart, prevFrom: dayStart - 2 * DAY, prevTo: dayStart - DAY };
    case 'last7': return { key, label: 'Last 7 days', from: now - 7 * DAY, to: now, prevFrom: now - 14 * DAY, prevTo: now - 7 * DAY };
    case 'last30': return { key, label: 'Last 30 days', from: now - 30 * DAY, to: now, prevFrom: now - 60 * DAY, prevTo: now - 30 * DAY };
    case 'last90': return { key, label: 'Last 90 days', from: now - 90 * DAY, to: now, prevFrom: now - 180 * DAY, prevTo: now - 90 * DAY };
    case 'thisMonth': { const s = month(y, m), p = month(y, m - 1); return { key, label: 'This month', from: s, to: now, prevFrom: p, prevTo: p + (now - s) }; }
    case 'lastMonth': { const s = month(y, m - 1), e = month(y, m), p = month(y, m - 2); return { key, label: 'Last month', from: s, to: e, prevFrom: p, prevTo: s }; }
    default: throw new Error('Unknown period ' + key);
  }
}

// ---- lead classification (one place, used by every KPI) ----
export function classify(lead, cfg) {
  const stage = norm(lead.stage);
  const st = k => cfg.stages[k].map(norm).includes(stage);
  const won = lead.status === 'won' || (st('closed') && lead.status !== 'lost');
  const contacted = (lead.tags || []).map(norm).includes(norm(cfg.contactedTag)) || !!lead.firstContactedAt || st('contacted') || won;
  // Lisa's call (Status overlay, synced into GHL by Jered's hook) wins; a quote or later stage also implies qualified.
  const Q = cfg.qualification || {};
  const tags = (lead.tags || []).map(norm);
  const vals = (lead.qualValues || []).map(norm);
  const markedNo = (Q.notTags || []).map(norm).some(t => tags.includes(t)) || vals.some(v => (Q.noValues || []).map(norm).includes(v));
  const markedYes = !markedNo && ((Q.tags || []).map(norm).some(t => tags.includes(t)) || vals.some(v => (Q.yesValues || []).map(norm).includes(v)));
  const qualifiedBy = markedYes ? 'Marked by Lisa' : (!markedNo && (st('qualified') || won)) ? (won ? 'Won' : 'Quote stage or later') : null;
  return {
    contacted,
    qualified: !!qualifiedBy,
    qualifiedBy,
    notQualified: markedNo,
    quote: st('quote') || won,
    contract: st('contract'),
    won,
  };
}

// Contact outcome for a lead, using calls when available.
export function contactStatus(lead, c, callsByContact) {
  const method = norm(lead.contactMethod);
  if (c.contacted) return method.includes('reply') ? 'Lead replied' : 'Successfully contacted';
  const calls = callsByContact[lead.contactId] || [];
  if (calls.some(k => k.direction === 'inbound' && !k.answered)) return 'Missed call';
  if (calls.some(k => k.direction === 'outbound')) return 'Attempted, no response';
  return 'Not attempted yet';
}

// Builds every drill-down list for one period. Tiles are derived from these.
export function buildLists(records, cfg, from, to) {
  const callsByContact = {};
  for (const k of records.calls || []) (callsByContact[k.contactId] ||= []).push(k);
  for (const list of Object.values(callsByContact)) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const leads = records.leads
    .filter(l => inRange(l.createdAt, from, to))
    .map(l => { const c = classify(l, cfg); return { ...l, ...c, contactStatus: contactStatus(l, c, callsByContact) }; })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const consult = (records.appointments || []).filter(a => a.consult && inRange(a.startTime, from, to));
  const booked = consult.filter(a => !['cancelled', 'invalid'].includes(norm(a.status)));
  const showed = booked.filter(a => norm(a.status) === 'showed');

  let missed = null, inboundCalls = null;
  if (records.calls) {
    const inbound = records.calls.filter(k => k.direction === 'inbound' && inRange(k.at, from, to));
    inboundCalls = inbound;
    missed = inbound.filter(k => !k.answered).map(k => {
      const back = (callsByContact[k.contactId] || []).find(o => o.direction === 'outbound' && Date.parse(o.at) > Date.parse(k.at));
      const lead = records.leads.find(l => l.contactId === k.contactId);
      return { ...k, calledBack: !!back, callbackAt: back?.at || null,
        callbackMin: back ? Math.round((Date.parse(back.at) - Date.parse(k.at)) / 60000) : null,
        leadStage: lead?.stage || '—', assignedTo: k.assignedTo || lead?.assignedTo || null };
    }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  const withStl = leads.filter(l => l.stlMin !== null && l.stlMin !== undefined);
  return {
    newLeads: leads,
    contacted: leads.filter(l => l.contacted),
    // Slowest first; leads nobody has called yet go to the very top.
    speed: [...leads].sort((a, b) => (b.stlMin ?? 1e12) - (a.stlMin ?? 1e12)),
    speedMeasured: withStl,
    within5: withStl.filter(l => l.stlMin <= 5),
    qualified: leads.filter(l => l.qualified),
    quotes: leads.filter(l => l.quote),
    contracts: leads.filter(l => l.contract),
    won: leads.filter(l => l.won),
    booked,
    showed,
    inboundCalls,
    missed,
    ...(buildVoiceLists(records.voiceCalls, from, to) || {}),
  };
}

// ---- Voice AI (GHL Voice AI call logs) ----
// One row per LIVE call the Voice AI agent handled (trial/test calls are excluded at sync time).
// GHL only writes a Voice AI call log when the agent picked up, so every row is an answered call.
export function buildVoiceLists(voiceCalls, from, to) {
  if (!voiceCalls) return null;
  const calls = voiceCalls.filter(c => inRange(c.at, from, to)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const callbackTracked = voiceCalls.some(c => c.callbackRequested !== null && c.callbackRequested !== undefined);
  return {
    aiCalls: calls,
    aiBooked: calls.filter(c => c.booked),
    aiTransferred: calls.filter(c => c.transferred),
    aiLeads: calls.filter(c => c.leadCreated),
    aiCallbacks: callbackTracked ? calls.filter(c => c.callbackRequested) : null,
  };
}
export function summarizeVoice(V) {
  if (!V) return { aiCalls: null, aiTotalDurationSec: null, aiAvgDurationSec: null, aiBooked: null, aiTransferred: null, aiLeads: null, aiCallbacks: null };
  const secs = V.aiCalls.map(c => Number(c.durationSec) || 0);
  const total = secs.reduce((t, x) => t + x, 0);
  return {
    aiCalls: V.aiCalls.length,
    aiTotalDurationSec: total,
    aiAvgDurationSec: V.aiCalls.length ? Math.round(total / V.aiCalls.length) : null,
    aiBooked: V.aiBooked.length,
    aiTransferred: V.aiTransferred.length,
    aiLeads: V.aiLeads.length,
    aiCallbacks: V.aiCallbacks ? V.aiCallbacks.length : null,
  };
}

// The only place numbers are produced. Every number = a length or sum of a list.
export function summarize(L) {
  const avg = L.speedMeasured.length ? Math.round(L.speedMeasured.reduce((t, l) => t + l.stlMin, 0) / L.speedMeasured.length) : null;
  const bySource = {};
  for (const l of L.newLeads) { const s = l.source || 'Unknown'; bySource[s] = (bySource[s] || 0) + 1; }
  return {
    totalLeads: L.newLeads.length,
    speedToLeadAvgMin: avg,
    calledWithin5Pct: L.speedMeasured.length ? pct(L.within5.length, L.speedMeasured.length) : null,
    contacted: L.contacted.length,
    contactRatePct: pct(L.contacted.length, L.newLeads.length),
    bookedCalls: L.booked.length,
    showed: L.showed.length,
    leadToBookedPct: pct(L.booked.length, L.newLeads.length),
    bookedToShowPct: pct(L.showed.length, L.booked.length),
    leadToShowPct: pct(L.showed.length, L.newLeads.length),
    qualified: L.qualified.length,
    quotesSent: L.quotes.length,
    quoteValue: sum(L.quotes),
    contactToQuotePct: pct(L.quotes.length, L.contacted.length),
    underContract: L.contracts.length,
    quoteToContractPct: pct(L.contracts.length, L.quotes.length),
    closedDeals: L.won.length,
    revenue: sum(L.won),
    quoteToClosePct: pct(L.won.length, L.quotes.length),
    missedCallPct: L.inboundCalls ? pct(L.missed.length, L.inboundCalls.length) : null,
    missedCalls: L.missed ? L.missed.length : null,
    inboundCalls: L.inboundCalls ? L.inboundCalls.length : null,
    ...summarizeVoice(L.aiCalls ? L : null),
    bySource,
    funnel: [
      ['Leads', L.newLeads.length, 'newLeads'], ['Contacted', L.contacted.length, 'contacted'],
      ['Qualified', L.qualified.length, 'qualified'], ['Quotes', L.quotes.length, 'quotes'],
      ['Under contract', L.contracts.length, 'contracts'], ['Closed', L.won.length, 'won'],
    ],
  };
}

// Custom range from two calendar dates 'YYYY-MM-DD' (inclusive) in the business zone.
export function customRange(fromDate, toDate, now, tzOffsetMin = 0) {
  const off = tzOffsetMin * 60000;
  const d = s => { const [y, m, dd] = s.split('-').map(Number); return Date.UTC(y, m - 1, dd) - off; };
  const from = d(fromDate), to = Math.min(d(toDate) + DAY, now), len = to - from;
  const fmt = s => new Date(d(s) + off).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return { key: 'custom', label: fromDate === toDate ? fmt(fromDate) : `${fmt(fromDate)} – ${fmt(toDate)}`, from, to, prevFrom: from - len, prevTo: from };
}

// Minutes east of UTC for an IANA zone at a moment (handles daylight saving).
export function tzOffsetMin(timeZone, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTC - Math.floor(now / 1000) * 1000) / 60000);
}

export function computeAll(records, cfg, now) {
  const periods = {};
  const off = tzOffsetMin(cfg.timezone || 'UTC', now);
  for (const key of PERIOD_KEYS) {
    const r = periodRange(key, now, off);
    periods[key] = {
      label: r.label, from: r.from, to: r.to,
      current: summarize(buildLists(records, cfg, r.from, r.to)),
      previous: summarize(buildLists(records, cfg, r.prevFrom, r.prevTo)),
    };
  }
  return periods;
}

// ---- encryption (AES-GCM 256, key from passphrase via PBKDF2-SHA256) ----
const b64 = {
  enc: buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); },
  dec: str => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptJSON(obj, pass, iter = 210000) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, iter);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, alg: 'AES-GCM-256/PBKDF2-SHA256', iter, salt: b64.enc(salt), iv: b64.enc(iv), ct: b64.enc(ct) };
}
export async function decryptJSON(env, pass) {
  const key = await deriveKey(pass, b64.dec(env.salt), env.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(env.iv) }, key, b64.dec(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
