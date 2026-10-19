// Shared KPI logic. Imported by scripts/sync.mjs (Node) AND by index.html
// (browser), so a tile's number and its drill-down list always come from the
// same function: count = list.length, $ = sum of the list. No DOM, no Node APIs.

export const DAY = 864e5;
const norm = s => String(s ?? '').trim().toLowerCase();
const inRange = (iso, from, to) => { const t = Date.parse(iso); return t >= from && t < to; };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const sum = rows => rows.reduce((t, r) => t + (Number(r.value) || 0), 0);

export const PERIOD_KEYS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'last7', 'last30', 'last90', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter'];

// Calendar boundaries are computed in the business time zone offset given
// (minutes east of UTC, e.g. -240 for EDT) so "Today" means Indiana's today.
export function periodRange(key, now, tzOffsetMin = 0, timeZone = null) {
  const off = tzOffsetMin * 60000;
  const local = new Date(now + off);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), dd = local.getUTCDate();
  // Local midnight of a calendar date. With a time zone, each boundary uses its own UTC offset (daylight saving safe).
  const at = (yy, mo, d) => {
    let t = Date.UTC(yy, mo, d) - off;
    if (timeZone) t = Date.UTC(yy, mo, d) - tzOffsetMinFn(timeZone, t) * 60000;
    return t;
  };
  const dayStart = at(y, m, dd);
  const dow = (local.getUTCDay() + 6) % 7;                 // 0 = Monday; weeks run Monday–Sunday
  const weekStart = at(y, m, dd - dow);
  const qm = m - (m % 3);                                  // first month of this quarter
  const sinceMidnight = now - dayStart;
  const sameTime = (yy, mo, d, cap) => Math.min(at(yy, mo, d) + sinceMidnight, cap);   // same clock time on an earlier date
  // "This …" periods are compared with the same elapsed time of the previous period (a fair, partial-period comparison).
  switch (key) {
    case 'today': return { key, label: 'Today', from: dayStart, to: now, prevFrom: at(y, m, dd - 1), prevTo: sameTime(y, m, dd - 1, dayStart) };
    case 'yesterday': return { key, label: 'Yesterday', from: at(y, m, dd - 1), to: dayStart, prevFrom: at(y, m, dd - 2), prevTo: at(y, m, dd - 1) };
    case 'thisWeek': return { key, label: 'This week', from: weekStart, to: now, prevFrom: at(y, m, dd - dow - 7), prevTo: sameTime(y, m, dd - 7, weekStart) };
    case 'lastWeek': return { key, label: 'Last week', from: at(y, m, dd - dow - 7), to: weekStart, prevFrom: at(y, m, dd - dow - 14), prevTo: at(y, m, dd - dow - 7) };
    case 'last7': return { key, label: 'Last 7 days', from: now - 7 * DAY, to: now, prevFrom: now - 14 * DAY, prevTo: now - 7 * DAY };
    case 'last30': return { key, label: 'Last 30 days', from: now - 30 * DAY, to: now, prevFrom: now - 60 * DAY, prevTo: now - 30 * DAY };
    case 'last90': return { key, label: 'Last 90 days', from: now - 90 * DAY, to: now, prevFrom: now - 180 * DAY, prevTo: now - 90 * DAY };
    case 'thisMonth': { const s = at(y, m, 1), p = at(y, m - 1, 1); return { key, label: 'This month', from: s, to: now, prevFrom: p, prevTo: sameTime(y, m - 1, Math.min(dd, new Date(Date.UTC(y, m, 0)).getUTCDate()), s) }; }
    case 'lastMonth': { const s = at(y, m - 1, 1), e = at(y, m, 1), p = at(y, m - 2, 1); return { key, label: 'Last month', from: s, to: e, prevFrom: p, prevTo: s }; }
    case 'thisQuarter': { const s = at(y, qm, 1), p = at(y, qm - 3, 1); return { key, label: 'This quarter', from: s, to: now, prevFrom: p, prevTo: sameTime(y, m - 3, Math.min(dd, new Date(Date.UTC(y, m - 2, 0)).getUTCDate()), s) }; }
    case 'lastQuarter': { const s = at(y, qm - 3, 1), e = at(y, qm, 1), p = at(y, qm - 6, 1); return { key, label: 'Last quarter', from: s, to: e, prevFrom: p, prevTo: s }; }
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
  // Quotes / contracts: Lisa's tags or the date fields her tag workflows stamp, plus the pipeline stages as a backup.
  const T = cfg.tags || {};
  const hasTag = list => (list || []).map(norm).some(t => tags.includes(t));
  const contractSignal = st('contract') || won || hasTag(T.underContract) || !!lead.contractAt;
  const quoteSignal = st('quote') || contractSignal || hasTag(T.quoteSent) || !!lead.quoteSentAt;
  const wonAt = lead.status === 'won' ? lead.statusChangedAt : won ? lead.stageChangedAt : null;
  const qualifiedBy = markedYes ? 'Tagged qualified' : (!markedNo && (st('qualified') || quoteSignal)) ? (won ? 'Won' : 'Quote sent or later') : null;
  return {
    contacted,
    qualified: !!qualifiedBy,
    qualifiedBy,
    notQualified: markedNo,
    quote: quoteSignal,
    contract: contractSignal,
    won,
    wonAt,
    // Event dates. Without a date field the lead's created date is used (GHL doesn't record when a tag was added).
    quoteDate: lead.quoteSentAt || lead.contractAt || (won ? wonAt : null),   // a contract means the quote went out by then
    contractDate: lead.contractAt || (won ? wonAt : null),
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

  const all = records.leads.map(l => ({ ...l, ...classify(l, cfg) }));
  const leads = all
    .filter(l => inRange(l.createdAt, from, to))
    .map(l => ({ ...l, contactStatus: contactStatus(l, l, callsByContact) }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Quotes, contracts and closed deals are counted when they happened (quote date, contract date, date won),
  // whenever the lead came in. Leads with no date fall back to their created date.
  const happened = (d, l) => inRange(d || l.createdAt, from, to);
  const byDateDesc = k => (a, b) => Date.parse(b[k]) - Date.parse(a[k]);
  const quotes = all.filter(l => l.quote && happened(l.quoteDate, l))
    .map(l => ({ ...l, value: l.quoteAmount ?? l.value, quoteOn: l.quoteDate || l.createdAt, quoteDateFrom: l.quoteSentAt ? 'Quote Sent Date' : l.quoteDate ? 'Contract / won date' : 'Lead created (no quote date yet)' }))
    .sort(byDateDesc('quoteOn'));
  const contracts = all.filter(l => l.contract && happened(l.contractDate, l))
    .map(l => ({ ...l, contractOn: l.contractDate || l.createdAt, contractDateFrom: l.contractAt ? 'Contract date field' : l.won ? 'Date won' : 'Lead created (no contract date yet)' }))
    .sort(byDateDesc('contractOn'));
  const won = all.filter(l => l.won && happened(l.wonAt, l)).map(l => ({ ...l, wonOn: l.wonAt || l.createdAt })).sort(byDateDesc('wonOn'));

  const consult = (records.appointments || []).filter(a => a.consult && inRange(a.startTime, from, to));
  const booked = consult.filter(a => !['cancelled', 'invalid'].includes(norm(a.status)));
  const T = cfg.tags || {};
  // No-shows: GHL appointment status "No-show", or (because appointments are rarely marked) a past booked call
  // whose lead card now sits in the No Show stage. Only the contact's most recent past booked call is counted
  // from the stage, so one no-show is never counted twice. Future calls can't be no-shows yet.
  const nowMs = Date.parse(records.generatedAt) || Date.now();
  const noShowStages = (cfg.stages.noShow || ['No Show']).map(norm);
  const latestLead = {};
  for (const l of records.leads) if (l.contactId && (!latestLead[l.contactId] || Date.parse(l.createdAt) > Date.parse(latestLead[l.contactId].createdAt))) latestLead[l.contactId] = l;
  const lastPast = {};
  for (const a of records.appointments || []) {
    if (!a.consult || ['cancelled', 'invalid'].includes(norm(a.status)) || Date.parse(a.startTime) > nowMs) continue;
    if (!lastPast[a.contactId] || Date.parse(a.startTime) > Date.parse(lastPast[a.contactId].startTime)) lastPast[a.contactId] = a;
  }
  const markedNoShow = a => /no.?show/.test(norm(a.status).replace(/[_\s-]/g, ''));
  const markedShowed = a => norm(a.status) === 'showed';
  const tagged = (cid, list) => { const tg = (latestLead[cid]?.tags || []).map(norm); return (list || []).map(norm).some(t => tg.includes(t)); };
  // Lisa's "showed" / "no show" tags apply to the contact's most recent booked call that has already happened.
  const isLast = a => lastPast[a.contactId]?.id === a.id;
  const outcome = a => {
    if (markedShowed(a)) return ['showed', 'Appointment marked Showed'];
    if (markedNoShow(a)) return ['noshow', 'Appointment marked No-show'];
    if (!isLast(a)) return [null, null];
    if (tagged(a.contactId, T.showed)) return ['showed', 'Tagged showed'];
    if (tagged(a.contactId, T.noShow)) return ['noshow', 'Tagged no show'];
    if (noShowStages.includes(norm(latestLead[a.contactId]?.stage))) return ['noshow', 'Card in No Show stage'];
    return [null, null];
  };
  const bookedPast = booked.filter(a => Date.parse(a.startTime) <= nowMs);
  const withOutcome = bookedPast.map(a => { const [o, by] = outcome(a); return { ...a, outcome: o, outcomeBy: by, noShowBy: by, leadStage: latestLead[a.contactId]?.stage || '—' }; });
  const showed = withOutcome.filter(a => a.outcome === 'showed');
  const noShows = withOutcome.filter(a => a.outcome === 'noshow');

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
    quotes,
    contracts,
    won,
    // Funnel = the leads that came in during the dates, followed through (a cohort), so each step is a subset.
    fQuotes: leads.filter(l => l.quote),
    fContracts: leads.filter(l => l.contract),
    fWon: leads.filter(l => l.won),
    booked,
    bookedPast,
    noShows,
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
    bookedToShowPct: pct(L.showed.length, (L.bookedPast || L.booked).length),
    noShows: L.noShows ? L.noShows.length : null,
    noShowPct: L.noShows ? pct(L.noShows.length, L.bookedPast.length) : null,
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
      ['Qualified', L.qualified.length, 'qualified'], ['Quotes', L.fQuotes.length, 'fQuotes'],
      ['Under contract', L.fContracts.length, 'fContracts'], ['Closed', L.fWon.length, 'fWon'],
    ],
  };
}

// What the selected range is compared against.
//   prev   = the previous period of the same length; for "This …" periods, up to the same point in time (default)
//   full   = the whole previous period (only differs for Today / This week / This month / This quarter)
//   custom = two dates picked by the user
//   off    = no comparison
const FULL_PREV = { today: 'yesterday', thisWeek: 'lastWeek', thisMonth: 'lastMonth', thisQuarter: 'lastQuarter' };
export function compareRange(range, mode, now, tzOffsetMin = 0, custom = null, timeZone = null) {
  if (mode === 'off') return null;
  if (mode === 'custom' && custom?.from && custom?.to) { const r = customRange(custom.from, custom.to, now, tzOffsetMin, timeZone); return { mode, from: r.from, to: r.to }; }
  if (mode === 'full' && FULL_PREV[range.key]) { const k = FULL_PREV[range.key], r = periodRange(k, now, tzOffsetMin, timeZone); return { mode, from: r.from, to: r.to, periodKey: k }; }
  return { mode: 'prev', from: range.prevFrom, to: range.prevTo };
}
export const hasFullPrev = key => !!FULL_PREV[key];

// Local-midnight day boundaries covering [from, to) in an IANA zone (handles daylight saving).
export function dayStarts(from, to, timeZone) {
  const out = [];
  const startOf = t => { const l = new Date(t + tzOffsetMin(timeZone, t) * 60000); const base = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()); let g = base - tzOffsetMin(timeZone, t) * 60000; return base - tzOffsetMin(timeZone, g) * 60000; };
  for (let d = startOf(from), guard = 0; d < to && guard < 400; guard++) {
    out.push(d);
    let next = startOf(d + DAY + 3 * 3600e3);       // jump past the next midnight, then snap back to it
    if (next <= d) next = d + DAY;
    d = next;
  }
  return out;
}

// Custom range from two calendar dates 'YYYY-MM-DD' (inclusive) in the business zone.
export function customRange(fromDate, toDate, now, tzOffsetMin = 0, timeZone = null) {
  const off = tzOffsetMin * 60000;
  const d = s => { const [y, m, dd] = s.split('-').map(Number); let t = Date.UTC(y, m - 1, dd) - off; if (timeZone) t = Date.UTC(y, m - 1, dd) - tzOffsetMinFn(timeZone, t) * 60000; return t; };
  const [ty, tm, td] = toDate.split('-').map(Number);
  const next = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  const from = d(fromDate), to = Math.min(d(next), now);
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const nDays = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY) + 1;
  const prevStart = new Date(Date.UTC(fy, fm - 1, fd - nDays)).toISOString().slice(0, 10);
  const fmt = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return { key: 'custom', label: fromDate === toDate ? fmt(fromDate) : `${fmt(fromDate)} – ${fmt(toDate)}`, from, to, prevFrom: d(prevStart), prevTo: from };
}

// Minutes east of UTC for an IANA zone at a moment (handles daylight saving).
function tzOffsetMinFn(timeZone, now) { return tzOffsetMin(timeZone, now); }
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
    const r = periodRange(key, now, off, cfg.timezone || null);
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
