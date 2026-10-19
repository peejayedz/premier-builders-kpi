# Premier Builders Sales KPI Scorecard

The sales KPI dashboard for the Premier Builders GHL sub-account. It's hosted on GitHub Pages and synced from GoHighLevel every 30 minutes by GitHub Actions.

- **Date selector:** presets (Today, Yesterday, Last 7/30/90 days, This month, Last month) or any custom From–To dates.
- **Refresh data:** starts a sync right away. New numbers land in 1–2 minutes.
- **Executive summary:** what's going well, what needs attention, the biggest funnel drop-off and a recommended focus. It's rule-based and recomputed for the selected dates, and each line opens its list.
- **Compare periods:** the Compare button next to the date filter compares two periods (Today vs Yesterday, This week vs Last week, This month vs Last month, This quarter vs Last quarter, or any two custom date ranges). Every card shows both values, the change and the % change (rates in points), coloured by whether the change is good for that KPI (lower is better for speed to lead and missed calls). A comparison summary lists the top movers with recommendations, and a daily/weekly trend chart plots any KPI for both periods. "This …" periods are compared to the same point in the previous period by default (a fair partial-period comparison); untick the option to compare with the whole previous period. Custom ranges, weeks/quarters for locked visitors before the next sync, and the trend chart need the passphrase, because they are recalculated from the individual records; nothing is estimated from totals.
- **Drill-downs:** click any tile, funnel step or lead source to see the contacts behind the number. Each list has search, sorting, filters, pagination, CSV export, mailto/tel links, and names that open the GHL contact record.

## Privacy model

A GitHub Pages site is public. So:

- `data/kpis.json` (public) holds **numbers only** for the preset ranges. It has no names, emails or phones.
- `data/details.enc.json` holds the contact-level records, **encrypted** with AES-256-GCM. The key is derived from a team passphrase (PBKDF2-SHA256, 210k iterations).
- The page asks for the passphrase once per device and decrypts in the browser. Without it, people see only the numbers.
- `<meta name="robots" content="noindex">` keeps the page out of search engines.

Choose a long passphrase (4+ random words), share it only with Lisa, Scott and Jered, and change the secret if someone leaves.

## How the numbers always match the lists

`scripts/kpi-core.mjs` is the only place KPIs are calculated. The sync job (Node) and the page (browser) both import it. Every tile is the length (or $ sum) of the exact list its drill-down shows, so a tile can't say 14 while its list shows 16.

## How it updates

```
GitHub Actions (every 30 min, or the Refresh button)
  -> node scripts/sync.mjs   (GHL API v2, read-only token)
  -> data/kpis.json + data/details.enc.json  (committed by the built-in GITHUB_TOKEN)
  -> GitHub Pages redeploys; open dashboards pick up the new data within 5 min
```

## One-time setup

1. **Repository variable:** Settings → Secrets and variables → Actions → Variables → `GHL_LOCATION_ID` = `my5ArG3gKkE3zHdJp821`
2. **Repository secrets** (same page, Secrets tab):
   - `GHL_TOKEN`: the GHL Private Integration Token (scopes below)
   - `DASHBOARD_PASSPHRASE`: the team passphrase
   - `DISPATCH_TOKEN` (optional, enables the Refresh button): a fine-grained GitHub token. Repository access: **only this repo**. Permission: **Actions: Read and write**. It's stored only inside the encrypted file.
3. **Workflow permissions:** Settings → Actions → General → "Read and write permissions"
4. **Pages:** Settings → Pages → Deploy from a branch → `main` / root
5. **First run:** Actions → "Sync KPIs from GoHighLevel" → Run workflow

## GHL Private Integration scopes (all read-only)

Create the token in the Premier Builders sub-account: Settings → Private Integrations.

| Scope | Used for |
| --- | --- |
| `opportunities.readonly` | Leads, stages, status, quote $, revenue, stage/status change dates |
| `contacts.readonly` | Name, email, phone, tags, the Speed to Lead / First Contacted Date / Contact Method fields |
| `users.readonly` | "Assigned to" names |
| `locations.readonly` | Location lookup |
| `locations/customFields.readonly` | Finding the custom field ids |
| `calendars.readonly` | Calendar names (which ones are Lisa's) |
| `calendars/events.readonly` | Booked / showed appointments |
| `conversations.readonly` | Call log |
| `conversations/message.readonly` | Call direction and status, for missed calls and callbacks |

## Notes on specific metrics

- **Quotes:** quotes are sent outside GHL (Lisa's email). A quote counts when the card moves to **Sent Quote**. Quote $ is the opportunity value.
- **Leads, contacted, qualified, quotes, contracts, closed, revenue:** one row per opportunity created in the selected dates. "Date qualified", "Quote date" and "Contract date" are the date the card entered its current stage, because GHL doesn't keep earlier stage dates.
- **Booked calls / showed:** one row per appointment, by appointment date. The modal also shows the unique-people count.
- **Tags Lisa adds (config `tags`, matching ignores case):** `qualified_lead` → qualified lead; `quotes sent` → quote sent; `under contract` → under contract; `showed` / `no show` → the outcome of the contact's most recent booked call that has already happened (a "showed" tag wins over the No Show stage).
- **Dates:** GHL workflows stamp **Quote Sent Date** and **Contract Sent Date** when those tags are added. Quotes and contracts are counted on those dates, closed deals on the date the opportunity was marked Won, whenever the lead came in. Without a date, the lead's created date is used. Qualified leads are grouped by when the lead came in. The funnel still follows the leads that came in during the dates.
- **Quote $:** a contact field named "Quote Amount" (or "Quote Value") if it exists; otherwise the opportunity's Lead value. Revenue = Lead value of won deals.
- **Booked call → no-show:** past booked calls (Lisa) that were a no-show ÷ booked calls that have already happened. GHL appointments are rarely marked, so a call also counts as a no-show when the lead's card is in the **No Show** stage (only the lead's most recent booked call). Goal ≤ 40% (the flip side of the 60% show goal). Marking appointments No-show/Showed in the calendar makes this exact.
- **Missed calls:** one row per missed inbound call (events, not people). It shows whether and when it was called back.
- **Speed to lead / contact method / first contacted date:** show "Not called yet" or "—" until the GHL workflows that fill those fields are live.

## Configuration (`config.json`)

- `targets`: the goals.
- `stages`: which stage names count as contacted / qualified / quote / contract / closed. It covers both the current and the planned stage names.
- `booking`: a booked call is any appointment on a calendar whose name contains `calendarKeywords` ("lisa") or assigned to a user matching `userNames`.
- `qualification`: Lisa marks leads Qualified in the PPC Launch **Status** overlay. Jered's hook copies that into GHL (tag, the contact "Qualified?" field or the opportunity "Qualified" field), and any of those counts. Sent Quote or a later stage also counts. "Not qualified" overrides.
- `lookbackDays`: how far back custom dates can go (400).
- `voiceAi`: section 7 (Voice AI performance). Reads GHL Voice AI call logs (needs the Voice AI read scope). "AI calls" = live calls the agent handled; GHL doesn't log calls the agent never picked up, so missed calls / answer rate aren't tracked. "Became a lead" = the caller got a new opportunity within `leadWindowHours` (24) of the call. Callback requests are counted only if the agent has a data-extraction field matching `callbackFieldPattern`.
