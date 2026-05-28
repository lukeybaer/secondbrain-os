# Outbound Call Skill (Amy)

This file is the consolidated playbook for any outbound Vapi call Amy places on Luke's behalf. Every outbound script in `scripts/*-call.js` reads from this file. Every learning Luke captures about outbound calling lands here first, then propagates into the per-rule memory files. If this file and a feedback memory file ever disagree, the feedback memory file wins; this file then gets updated to match.

## The five laws (in order of importance)

### 1. Never redial a number after a failed human interaction. Route to Luke for damage control.

If Amy's prior outbound call to a number reached a human and ended in anything other than a clean success, Amy must NEVER call that number again. The recovery channel is Luke doing damage control himself (email, in-person, second human), not Amy retrying with a refined prompt. There is no cooldown that lifts the ban. There is no env-var override. The only way past the guard is Luke marking the prior call's JSON with `luke_handled_damage_control: true` after he has personally repaired the relationship.

Mechanical enforcement: `scripts/lib/redial-guard.js` (`assertNoRecentCall(phone)`) blocks every outbound script. Tests: `src/main/__tests__/redial-guard.test.ts`. Full rule: `secondbrain/memory/feedback_no_redial_after_failed_call.md`.

When a human interaction fails, Amy writes a damage-control note to `data/agent/damage-control-needed.jsonl` with: callId, phone, callee name if known, business, what went wrong, what Luke should say to repair it, recommended channel, objective status. The post-call hook surfaces it to Luke on Telegram.

### 2. Prep every data point the objective needs BEFORE placing the call. No half-prepared dials.

Before any outbound call fires, Amy walks the objective, anticipates every field a competent callee will ask for, and pulls all of it from disk into the system prompt. If a needed data point cannot be found, Amy surfaces the gap to Luke as a one-line ask BEFORE dialing. The call does not fire until the prep is complete.

The prep manifest is stamped onto the call record so post-call review can audit what was gathered vs what was missed.

Full rule: `secondbrain/memory/feedback_proactive_data_prep_before_outbound_call.md`.

### 3. Permission to share is objective-gated, not field-gated.

When Luke gives Amy an objective, Amy is authorized to share whatever the callee legitimately needs to accomplish that objective, including DOB, SSN, payment info, VIN, plate, full address. The only test is: "is this required for Luke's explicit objective?" There are no sensitivity tiers. There are no per-field approval Telegrams. The compartmentalization gate only fires for information the callee asks for that is NOT required for the objective (off-scope personal probing, fishing questions, unrelated sales pitches).

Full rule: `secondbrain/memory/feedback_outbound_callee_compartmentalization.md` (updated 2026-05-15 to replace the old "callee untrusted by default" framing).

### 4. For short critical strings, speak the whole string with natural grouping. Do not accept mid-string interruption.

The general "let the human interrupt you" rule does NOT apply to phone numbers, addresses, account numbers, VINs, dates, dollar amounts, confirmation codes. For those, Amy says the whole string in one continuous phrase with natural grouping, and if asked to repeat, repeats the WHOLE string the SAME way. Re-reading individual digits when the callee mishears is the doom-loop pattern that cost the first dealership service call.

Phone: 3-3-4 grouping. Address: street, city-state-zip as one phrase. Account: 3 or 4 digit groups. Date: full natural phrase. VIN last 8: 4-4 grouping.

Full rule: `secondbrain/memory/feedback_short_text_speak_whole_no_interrupt_chunking.md`.

### 5. Hot mic, no narration, ever.

Amy's microphone is always live. Whatever she "thinks" is heard. She never says "pressing 2," "one moment," "let me check," "give me a sec," "hold on," or any narration of internal state. Tool calls fire on completed turns, never mid-sentence. DTMF presses are silent.

Full rule: `secondbrain/memory/feedback_amy_hot_mic_no_narration.md` (plus `feedback_amy_no_give_me_a_second.md`).

## Pre-flight checklist (Amy runs this before every outbound call)

1. **Objective is explicit.** Single sentence: "Book a service appointment at the Toyota dealership for Saturday morning." Not: "deal with the dealership thing."
2. **Redial guard cleared.** `assertNoRecentCall(phone)` returns allowed.
3. **Prep manifest complete.** Every predictable callee question has an answer in the prompt's `## Information you may share if asked` section.
4. **Pronunciation hints encoded.** Any non-obvious name has a phonetic guide. "Baer" specifically must NOT come out as "Bear." See `feedback_baer_pronunciation_in_vapi_tts.md`.
5. **Digit groupings encoded.** Every phone, address, account number, VIN in the prompt is written with its natural grouping for TTS to read.
6. **IVR path planned.** Which digit to press for the right department, when to wait for menu to finish, what to do if voicemail picks up.
7. **End conditions explicit.** The call ends when [appointment booked / quote obtained / message delivered]. Specify the exit, do not let the model improvise.
8. **Compartmentalization scope set.** What is on-objective and shareable, what is off-objective and gets deflected.

If any item is incomplete, the call does NOT fire.

## Post-call protocol (Amy runs this after every call)

1. **Wait for Vapi to finalize.** Do not read transcript until `status === "ended"` AND `endedAt` is non-null AND `durationSeconds` is non-null. If not, recheck in 30 seconds. Do NOT claim outcome based on a still-finalizing call. See `feedback_vapi_transcript_lag_after_call_end.md`.

2. **Classify the outcome:**
   - **Clean success:** objective met, callee not irritated, call ended cleanly.
   - **Failed human interaction:** human picked up, anything other than clean success. Trigger damage-control protocol.
   - **No human reached:** voicemail, no answer, IVR dead-end. Safe to retry once the cause is fixed, IF the same number truly never reached a human. Confirm by inspecting transcript: any `User:` utterance that is not IVR text is a human reach.

3. **Write the call record** to `%APPDATA%/secondbrain/data/calls/<id>.json` with: id, createdAt, phoneNumber, instructions, personalContext, status, endedReason, endedAt, durationSeconds, transcript, summary, prep_manifest, outcome_classification.

4. **If failed human interaction:** write the damage-control note (see Law 1 above) AND Telegram Luke a one-line summary with the call id, the rep name, and the specific repair message Luke should send. Do not dial again.

5. **Update relevant memory:**
   - If a new contact: create the contact file at `memory/contacts/<slug>.md` per `feedback_proactively_create_contact_files_for_people.md`.
   - If the call confirmed an appointment or commitment: update the relevant calendar/scheduling memory.
   - If the call surfaced a learning: append to this file AND save a topic-specific feedback memory.

6. **Report to Luke** with: outcome, what was booked/confirmed/learned, transcript link or excerpt, any damage-control note pending.

## Existing outbound call scripts in scripts/

| Script | Purpose | Status |
|---|---|---|
| `pat-lobb-service-call.js` | Routine maintenance booking at the Toyota dealership for the 2022 Corolla SE | Used on 2026-05-15 (appt booked for 2026-05-16 9 AM). Reference template. |
| `wheel-lock-call.js` | Generic dealer parts call template (used April 2026 for wheel lock keys) | Older pattern; predates redial guard. Updated 2026-05-15 to import the guard. |
| `bai-interview-confirm-call.js` | BAI AI Engineer interview confirmation outreach | Updated 2026-05-15 to import the guard. |
| `backfill-vapi-call-019de166.js` | One-off backfill, not a live dispatcher | N/A |
| `push-amy-vapi-config.js` | Manages the base Amy assistant config | Should bake the pronunciation hint per Law 4 corollary. |
| `vapi-end-of-call.js` | Post-call hook (called from `ec2-server.js`) | Should detect failed human interactions and emit the damage-control note per Law 1. |

## Build a new outbound script

Use `scripts/pat-lobb-service-call.js` as the reference template. The minimum required structure:

```js
const { assertNoRecentCall } = require('./lib/redial-guard');

// ... config loading ...

assertNoRecentCall(PHONE);  // BEFORE the Vapi POST

const systemPrompt = buildPrompt({
  // bake in: pronunciation hints, digit groupings, prep manifest, IVR path, end conditions, compartmentalization scope
});

// ... fetch /call/phone, poll, write record, classify outcome, write damage-control note if needed ...
```

The redial-guard test (`src/main/__tests__/redial-guard.test.ts`) asserts every script in `scripts/` that touches `api.vapi.ai/call/phone` imports and calls the guard. CI fails if a new script forgets it.

## Open follow-ups (not yet shipped)

- **Server-side redial guard.** The dispatcher (`ec2-server.js`) does not yet enforce the rule. A malformed local script could in theory bypass the local guard. Server-side mirror is the layer-two defense.
- **Damage-control note hook.** `vapi-end-of-call.js` should auto-detect failed human interactions (transcript contains `User:` non-IVR utterance + outcome is not clean) and emit the note + Telegram automatically. Currently Amy must write the note manually.
- **Base Amy Vapi config pronunciation hint.** The "Baer" phonetic hint should live in the base assistant config so per-call prompts do not have to repeat it. Push via `push-amy-vapi-config.js`.
- **Prep manifest stamping.** The call record should include a `prep_manifest` array of `{field, source_path}` entries. Currently not enforced.
- **Outcome classification field.** Call records do not yet have an `outcome_classification` field; add it so the damage-control filter has a clean signal to query.
