// Pulls Premier Builders data from the GoHighLevel API v2 and writes:
//   data/kpis.json         public: aggregate numbers only (no names/phones/emails)
//   data/details.enc.json  encrypted contact-level records for the drill-downs
// Run hourly by .github/workflows/sync-kpis.yml.
//
// Env: GHL_TOKEN (read-only Private Integration Token), GHL_LOCATION_ID,
//      DASHBOARD_PASSPHRASE (team passphrase that unlocks the drill-downs)
//      DISPATCH_TOKEN (optional; fine-grained PAT, Actions: write on this repo only, for the Refresh button)

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { computeAll, encryptJSON } from './kpi-core.mjs';

const API = 'https://services.leadconnectorhq.com';
const TOKEN = process.env.GHL_TOKEN;
const LOC = process.env.GHL_LOCATION_ID;
const PASS = process.env.DASHBOARD_PASSPHRASE || '';
if (!TOKEN || !LOC) { console.error('Missing GHL_TOKEN or GHL_LOCATION_ID'); process.exit(1); }

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const DAY = 864e5;
const now = Date.now();
const since = now - cfg.lookbackDays * DAY;
const norm = s => String(s ?? '').trim().toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = v => (v ? new Date(typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : v).toISOString() : null);

async function ghl(path, { version = '2021-07-28' } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, { headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}`, Version: version } });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`GHL ${res.status} on ${path.split('?')[0]}: token invalid or missing a scope`);
    if (!res.ok) throw new Error(`GHL ${res.status} on ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`GHL rate limit on ${path}`);
}
async function optional(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`${label} skipped: ${e.message}`); return null; }
}

// ---------- Users (assigned-to names) ----------
const users = (await optional('users', async () => {
  const { users = [] } = await ghl(`/users/?locationId=${LOC}`);
  return Object.fromEntries(users.map(u => [u.id, u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email]));
})) || {};

// ---------- Pipelines + opportunities ----------
const { pipelines = [] } = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
const stageName = {}, pipelineName = {};
for (const p of pipelines) { pipelineName[p.id] = p.name; for (const s of p.stages || []) stageName[s.id] = s.name; }

const opps = [];
{
  let page = 1, startAfter, startAfterId;
  for (let guard = 0; guard < 200; guard++) {
    const q = new URLSearchParams({ location_id: LOC, limit: '100' });
    if (startAfter) { q.set('startAfter', startAfter); q.set('startAfterId', startAfterId); } else q.set('page', String(page));
    const r = await ghl(`/opportunities/search?${q}`);
    const batch = r.opportunities || [];
    opps.push(...batch);
    const oldest = Math.min(...batch.map(o => Date.parse(o.createdAt) || now));
    if (batch.length < 100 || oldest < since) break;
    if (r.meta?.startAfter && r.meta?.startAfterId) { startAfter = r.meta.startAfter; startAfterId = r.meta.startAfterId; } else page++;
  }
}
const recentOpps = opps.filter(o => (Date.parse(o.createdAt) || 0) >= since);

// ---------- Contact custom fields ----------
const fieldIds = (await optional('customFields', async () => {
  const { customFields = [] } = await ghl(`/locations/${LOC}/customFields?model=contact`);
  const find = name => customFields.find(f => norm(f.name) === norm(name))?.id || null;
  return { stl: find(cfg.fields.speedToLead), firstContacted: find(cfg.fields.firstContacted), method: find(cfg.fields.contactMethod) };
})) || {};

const contacts = {};
async function loadContacts(ids) {
  const todo = [...new Set(ids)].filter(id => id && !contacts[id]);
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async id => {
      const c = (await optional(`contact ${id}`, () => ghl(`/contacts/${id}`)))?.contact;
      if (!c) { contacts[id] = { id }; return; }
      const cf = fid => (fid ? c.customFields?.find(f => f.id === fid)?.value ?? null : null);
      contacts[id] = {
        id,
        name: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || c.phone || 'Unnamed',
        email: c.email || null, phone: c.phone || null, tags: c.tags || [], source: c.source || null,
        stl: cf(fieldIds.stl), firstContacted: cf(fieldIds.firstContacted), method: cf(fieldIds.method),
      };
    }));
    await sleep(250);
  }
}
await loadContacts(recentOpps.map(o => o.contactId || o.contact?.id));

const leads = recentOpps.map(o => {
  const cid = o.contactId || o.contact?.id;
  const c = contacts[cid] || {};
  const stl = c.stl === null || c.stl === undefined || c.stl === '' ? null : Number(c.stl);
  return {
    oppId: o.id, contactId: cid,
    name: c.name || o.contact?.name || o.name, email: c.email || o.contact?.email || null, phone: c.phone || o.contact?.phone || null,
    source: o.source || c.source || 'Unknown', createdAt: iso(o.createdAt),
    assignedTo: o.assignedTo || null, pipeline: pipelineName[o.pipelineId] || '—', stage: stageName[o.pipelineStageId] || '—',
    status: o.status, value: Number(o.monetaryValue) || 0,
    stageChangedAt: iso(o.lastStageChangeAt || o.updatedAt), statusChangedAt: iso(o.lastStatusChangeAt || o.updatedAt),
    tags: c.tags || o.contact?.tags || [],
    stlMin: Number.isNaN(stl) ? null : stl, firstContactedAt: c.firstContacted ? iso(c.firstContacted) : null, contactMethod: c.method || null,
  };
});

// ---------- Appointments ----------
const appointments = await optional('appointments', async () => {
  const { calendars = [] } = await ghl(`/calendars/?locationId=${LOC}`);
  const isSite = c => cfg.siteVisitCalendarKeywords.some(k => norm(c.name).includes(norm(k)));
  const isConsult = c => (cfg.consultCalendars.length ? cfg.consultCalendars.map(norm).includes(norm(c.name)) : !isSite(c));
  const out = [];
  for (const cal of calendars) {
    const q = new URLSearchParams({ locationId: LOC, calendarId: cal.id, startTime: String(since), endTime: String(now + 60 * DAY) });
    const { events = [] } = await ghl(`/calendars/events?${q}`);
    for (const e of events) out.push({
      id: e.id, contactId: e.contactId, calendar: cal.name, consult: isConsult(cal),
      assignedTo: e.assignedUserId || null, startTime: iso(e.startTime), bookedAt: iso(e.dateAdded), status: e.appointmentStatus || e.status || '—',
      title: e.title || null,
    });
  }
  return out;
});
if (appointments) {
  await loadContacts(appointments.map(a => a.contactId));
  for (const a of appointments) { const c = contacts[a.contactId] || {}; Object.assign(a, { name: c.name || a.title || 'Unknown', email: c.email || null, phone: c.phone || null }); }
}

// ---------- Calls ----------
const calls = await optional('calls', async () => {
  const out = [];
  let cursor;
  for (let guard = 0; guard < 50; guard++) {
    const q = new URLSearchParams({ locationId: LOC, channel: 'Call', limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const r = await ghl(`/conversations/messages/export?${q}`);
    const batch = r.messages || [];
    for (const m of batch) {
      const status = norm(m.meta?.call?.status || m.status);
      out.push({ id: m.id, contactId: m.contactId, direction: norm(m.direction), status, answered: ['completed', 'answered'].includes(status),
        at: iso(m.dateAdded), assignedTo: m.userId || null, durationSec: m.meta?.call?.duration ?? null });
    }
    const oldest = Math.min(...batch.map(m => Date.parse(m.dateAdded) || now));
    if (!r.nextCursor || batch.length === 0 || oldest < since) break;
    cursor = r.nextCursor;
  }
  return out.filter(k => Date.parse(k.at) >= since);
});
if (calls) {
  await loadContacts(calls.map(k => k.contactId));
  for (const k of calls) { const c = contacts[k.contactId] || {}; Object.assign(k, { name: c.name || 'Unknown caller', phone: c.phone || null }); }
}

// ---------- Compute + write ----------
const records = {
  generatedAt: new Date(now).toISOString(), locationId: LOC, ghlBase: cfg.ghlAppBase, users, leads, appointments, calls,
  // Lets unlocked viewers press "Refresh data": a fine-grained token that can ONLY start this repo's workflow.
  refresh: process.env.DISPATCH_TOKEN ? { repo: process.env.GITHUB_REPOSITORY, workflow: 'sync-kpis.yml', token: process.env.DISPATCH_TOKEN } : null,
};
const periods = computeAll(records, cfg, now);
// Public file: strip anything per-contact (bySource has only source names + counts).
const out = {
  generatedAt: records.generatedAt, location: cfg.locationName, targets: cfg.targets,
  dataNotes: {
    speedToLead: fieldIds.stl ? 'From the Speed to Lead (min) contact field' : 'Field not created yet in GHL',
    appointments: appointments ? 'Consult calendars, by appointment start date' : 'Calendar scope missing',
    calls: calls ? 'Inbound calls from conversation messages' : 'Conversation message scope missing',
  },
  detailsAvailable: !!PASS,
  periods,
};

const dataDir = new URL('../data/', import.meta.url);
await mkdir(dataDir, { recursive: true });
await writeFile(new URL('kpis.json', dataDir), JSON.stringify(out, null, 2) + '\n');
if (PASS) {
  await writeFile(new URL('details.enc.json', dataDir), JSON.stringify(await encryptJSON(records, PASS)) + '\n');
} else {
  await rm(new URL('details.enc.json', dataDir), { force: true });
  console.warn('DASHBOARD_PASSPHRASE not set: drill-downs disabled, no contact data written.');
}
console.log(`Wrote data/kpis.json (${leads.length} leads, ${appointments?.length ?? 'n/a'} appointments, ${calls?.length ?? 'n/a'} calls)`);
