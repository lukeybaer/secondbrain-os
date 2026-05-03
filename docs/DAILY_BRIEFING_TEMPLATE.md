# Daily briefing: a complete local-first template

The morning briefing is the EA's daily output that lands in your inbox before you wake up. This guide gives you a complete template that runs locally on your desktop, with an optional AWS hosting path if you want it to keep running while your laptop is closed.

## What a good briefing actually does

A daily briefing is not a summary of yesterday. A summary is a status board. A briefing is a forcing function: it surfaces decisions you need to make today, in priority order, with enough context that you can make them in 60 seconds.

Three rules:

1. **Top item is always a decision, never a status.** "FYI: server uptime is 19 hours" belongs at the bottom. "Approve / reject the contract amendment from X" belongs at the top.
2. **Every section is verifiable.** No hallucinated numbers, no fabricated counts. Every claim traces to a file or a query that produced it. If a section can't fetch its data, it says so explicitly instead of inventing a value.
3. **Length scales with signal, not effort.** A boring day produces a short briefing. A noisy day produces a longer one. Padding to a fixed length is dishonest.

## Architecture: local first, AWS optional

The briefing generator runs as a scheduled task on your desktop. By default this is the only place it runs. Your laptop fires the task at the chosen time, generates the briefing, and delivers it via Telegram and Gmail.

```
[Your desktop, scheduled task at 5:30 AM]
        |
        v
  scripts/manual-briefing-v3.js
        |
        +--> reads memory/, data/{module}/, contacts/
        +--> writes data/briefings/briefing-YYYY-MM-DD.md
        +--> POSTs Telegram messages
        +--> drafts Gmail
```

This works fine for most users. The downside: if your laptop is closed at 5:30 AM, no briefing.

If you want always-on delivery, add an AWS EC2 companion:

```
[Your desktop]                    [AWS EC2, always-on]
        |                                  |
        |                                  +--> cron at 5:30 AM
        |                                  +--> same briefing script
        |                                  +--> POSTs Telegram + Gmail
        |                                          |
        +-------- syncs memory/ + data/ --------> S3
                                                  ^
                                                  | EC2 reads from S3 if local copy is stale
```

The EC2 path is optional. The same briefing script (`scripts/manual-briefing-v3.js`) runs in both places. Set `BRIEFING_DELIVERY=local` or `BRIEFING_DELIVERY=ec2` to control which one is canonical (the other should be disabled to avoid double delivery).

The hybrid model: run locally as the default, and turn on EC2 only when you start travelling or want briefings while your laptop is asleep. AWS hosting is a "phase 2" decision, not a prerequisite.

## The 13-section template

This is the section ordering SecondBrain uses. Yours will differ; treat it as a starting point. Every section has a header, a rule for what it includes, and an empty-state message.

### 1. Header
```
GOOD MORNING. <DAY> <DATE> <CT>
```
Just the day and date in the owner's local timezone. Sets context.

### 2. Top decisions today
```
DECISIONS WAITING ON YOU:
  1. <thing 1, with the clarifying question and 1-line context>
  2. <thing 2>
  3. ...
```
Pulled from `data/agent/decisions-pending.json`. Each entry has: title, why-now, the link or file path with full context, and a default action if you ignore it (auto-decline, auto-accept, etc.). Top 3 max. The rest go in section 4.

### 3. Calendar today
```
TODAY'S SCHEDULE:
  09:00  call with X about Y
  11:30  meeting Z
  ...
```
Pulled from your calendar API. If empty, the section is omitted entirely (no "no events" filler).

### 4. Pending approvals + actions
```
APPROVALS QUEUED:
  - <thing the EA has drafted but not sent>
  - <call the EA wants to make>
```
Long list, but each item is a one-liner with a link to expand. Click to approve or reject. Click-to-focus narrows the briefing to that one item.

### 5. People
```
PEOPLE:
  - <person>: warmth dropping, last touch 47 days
  - <birthday today>
  - <LinkedIn move>
```
Generated from `memory/contacts/`. Surfaces relationships needing attention: birthdays, anniversaries, going-cold contacts, recent LinkedIn moves, mentions in last night's Otter transcripts. Driven by the warmth audit and the LinkedIn scan.

### 6. Communications summary
```
INBOX (last 24h):
  - 5 new threads, 2 need a reply
  - <subject>: <one-line context>
  - <subject>: <one-line context>
```
Aggregated from Gmail + WhatsApp + SMS. Replies needed go to the top.

### 7. Projects done together
```
PROJECTS DONE TOGETHER (last 24h):
  - [project_x] commit message + outcome
  - [project_y] commit message + outcome
```
What you and the EA shipped yesterday. Pulled from git log on the relevant repos. Builds confidence that the EA is actually doing work.

### 8. Content pipeline
```
CONTENT:
  Approved, awaiting upload: 2
  Pending review: 5 (oldest 3d)
  Rejected, awaiting regen: 1
```
Surfaces queues that need attention. If everything is empty, omit the section.

### 9. News
```
NEWS:
  1. <headline>
     <3-paragraph summary with a real citation>
     <url>
  ...
```
Curated news with AI summarization. Three paragraphs each. Real citations from actual article bodies, never fabricated. If the news API fails, the section reports that explicitly.

### 10. System health
```
SYSTEM HEALTH:
  Backups:    OK, last 6h ago
  EC2:        OK, uptime 19h
  LLM source: claude-max-plan (FREE)
  Tests:      114/115 pass
```
Operational signals. Each subsystem is one line. RED items get expanded with a "what's wrong / what I need from you / plan + ETA" block at the bottom. See `docs/patterns.md` section 4 for the foundation invariants pattern.

### 11. Token usage yesterday
```
TOKEN USAGE YESTERDAY:
  Claude Max (FREE):  18.2M tokens
  External paid:      $0.00
```
Confirms the "free tier" claim is still true. Goes red if any paid API usage shows up.

### 12. AWS costs (last 30d)
```
AWS COSTS (last 30d, $X total):
  EC2:    $X
  S3:     $X
  ...
```
If you run the AWS companion. If not, omit.

### 13. Footer with links
```
LINKS:
  - Briefing on dashboard: http://<host>:3001/briefing
  - Repo: <github url>
```

## Timing and delivery

The standard schedule:

- **5:30 AM CT**: briefing fires
- **Delivery**: Telegram link + Gmail draft (not auto-send) + dashboard write

Three delivery channels are intentional. Telegram is for the owner's phone (read in 30 seconds). Gmail draft is for the owner's desktop (read in 5 minutes with full content). Dashboard is for click-through into details.

The Telegram message should be a link, not the full content. Pasting a 50KB briefing into Telegram makes the phone unusable. The link goes to the dashboard.

## Implementation pattern

The briefing is a deterministic script. No "Claude rewrites the briefing every morning". The script reads from data sources, formats the result, ships it.

```javascript
// scripts/manual-briefing-v3.js (sketch)

async function buildBriefing(date) {
  const sections = [];
  sections.push(await getHeader(date));
  sections.push(await getTopDecisions());
  sections.push(await getCalendarToday());
  sections.push(await getPendingApprovals());
  sections.push(await getPeopleAttention());
  sections.push(await getCommunicationsSummary());
  sections.push(await getProjectsDoneTogether());
  sections.push(await getContentPipelineState());
  sections.push(await getNews());
  sections.push(await getSystemHealth());
  sections.push(await getTokenUsageYesterday());
  sections.push(await getAwsCosts());
  sections.push(await getFooter());
  return sections.filter(Boolean).join('\n\n');
}
```

Each section function reads its own data source (`memory/`, `data/`, an API) and returns either a formatted string or `null` (which omits the section). The orchestrator just concatenates non-null sections.

### The spec-as-contract pattern

The section order is defined in a spec file: `memory/project_briefing_spec.md`. A regression test loops over the spec and asserts:

1. Every section header in the spec appears in the actual briefing output
2. Every section's data function exists in the script
3. Sections explicitly removed from the spec do not reappear in the output

This prevents the failure mode where a section silently disappears because its data source broke. See [`docs/patterns.md`](patterns.md) section 4 for the full pattern.

## Setting up the local pipeline

Step 1: Copy `scripts/manual-briefing-v3.js` from this repo. It's the canonical briefing generator.

Step 2: Create `memory/project_briefing_spec.md` listing the sections you want, in order. Start with the 13 above, prune what you don't need.

Step 3: Set up Telegram bot + chat ID via `@BotFather` and put credentials in `Settings`. Test with `node scripts/test-telegram.js`.

Step 4: Set up Gmail OAuth via Google Cloud Console (the Settings page walks you through it). Test with `node scripts/test-gmail-draft.js`.

Step 5: Add a Windows scheduled task (or cron job on macOS/Linux) that runs `node scripts/manual-briefing-v3.js` at your chosen time daily. See [`scripts/setup-windows-tasks.ps1`](../scripts/setup-windows-tasks.ps1) for a template.

Step 6: Run it manually once to verify all sections produce output. Iterate on what you want included or removed.

## Setting up the optional AWS path

Only do this if you've been using the local version for at least a week and want the always-on guarantee.

Step 1: Spin up a t3.micro EC2 instance with an Elastic IP. Install Node, git, and PM2.

Step 2: Clone this repo to `/opt/secondbrain` on the EC2.

Step 3: Set up nightly sync from your desktop's `memory/` and `data/` to an S3 bucket. The EC2 reads from S3 every few minutes.

Step 4: Add a cron entry on the EC2: `30 5 * * * cd /opt/secondbrain && node scripts/manual-briefing-v3.js`.

Step 5: Set `BRIEFING_DELIVERY=ec2` on the EC2 and `BRIEFING_DELIVERY=disabled` on the desktop. Now only one of them delivers (avoids duplicates).

Step 6: Monitor with PM2 + a healthcheck endpoint at `/health` so the EC2's own uptime appears in section 10 of the briefing.

## Common mistakes

**Generating the briefing with an LLM end to end.** The LLM generates filler when the data is thin. Make the script deterministic and let the LLM only summarize where you've explicitly asked for prose (e.g. news summaries).

**Putting status at the top.** "All systems green" is not a decision. Move it to the bottom and put what needs the owner's attention at the top.

**Hardcoded values that aren't real.** "5 contacts going cold" should be computed, not typed in. Hardcoded numbers in a briefing are how trust dies.

**Sending the same briefing twice.** If the same section's data hasn't changed in 3 days, the section becomes noise. Either mute it or surface "no change in 3 days" once and stop repeating.

**Deleting a section because the data source broke.** Don't. Make the section say "data missing, see <log>" so the owner knows the pipeline is broken instead of assuming the topic is empty.

## Where to look in this repo

- `scripts/manual-briefing-v3.js`     The canonical briefing generator
- `scripts/briefing-ranker.js`        Sorts decisions by urgency
- `scripts/briefing-dashboard-utils.js`   Renders the briefing as HTML for the web dashboard
- `src/main/__tests__/manual-briefing.test.ts`  The spec-as-contract regression test
- `docs/patterns.md`                  The architectural patterns behind this approach
