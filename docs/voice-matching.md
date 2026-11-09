# Voice matching

SecondBrain can recognize who is speaking in recorded calls by comparing each speaker's voice against people you have confirmed. Everything runs on your own machine.

Status: the matching engine ships, but there is no guided enrollment tool yet. Adding known voices means editing a registry file by hand, as described below. These steps come from reading the code and have not been tested on a clean machine.

## Pipeline

1. **Speaker separation** splits a recording into speaker turns: `scripts/voice-local-diarize.js`, using pyannote. Turn it on with `VOICE_LOCAL_DIARIZE=1`.
2. **Voice embeddings** turn speech into vectors: `scripts/voice-embedding-ecapa.js` (default) or `scripts/voice-embedding-wavlm.js`. Pick one with `VOICE_SPEAKER_BACKEND=ecapa` or `wavlm`.
3. **The speaker resolver** scores every speaker track in your enriched transcripts against confirmed reference voices and applies confident matches: `scripts/otter-wavlm-speaker-resolver.js`.
4. **The people-file sync** writes voice evidence into your people files: `scripts/sync-voiceprints-to-people-files.js`.

## Requirements

- Python 3 with `torch`, `torchaudio`, `soundfile`, `speechbrain`, `pyannote.audio`, and `numpy`.
- A Hugging Face token in `HF_TOKEN` for the pyannote speaker-diarization model. The model may also require accepting its license on Hugging Face.

## Where data lives

| Path | Contents |
|---|---|
| `data/otter/enriched/` | Enriched transcripts the resolver reads |
| `data/otter/audio/` | Call audio, including reference clips |
| `data/life-archive/voice-identity-registry.json` | People, enrollments, and confirmed voice clusters |
| `data/life-archive/voiceprints/` | Embedding caches, review queues, and resolver status |
| `memory/contacts/` | People files the sync updates |

Set `SECONDBRAIN_DATA_DIR` to keep data somewhere other than `data/`.

## Adding a known voice

The resolver only matches against enrollments in `voice-identity-registry.json` that pass `referenceEligibility` in `scripts/lib/voice-reference-provenance.js`. An enrollment must:

- have an `enrollment_id` and a `model`, and not be marked quarantined;
- belong to a person in `people` whose `identity_confirmation_status` is the confirmed label the code checks and whose `voiceprint_status` is `enrolled`, or to a voice cluster whose resolution is confirmed;
- point `reference_audio_rel` or `reference_audio_path` at a non-empty audio file under your data folder;
- carry provenance: `source_revision_hash`, `reference_audio_sha256`, `segment_evidence_sha256`, `probe_sha256`, `evidence_hash`, `model`, and `model_version`.

In this public copy the confirmed label is `confirmed_by_ExampleCo`. Read `confirmedKnownReferenceScope` and `hasFullySourceVersionedProvenance` in `scripts/lib/voice-reference-provenance.js` for the exact rules.

## Run it

Preview matches without writing anything:

    node scripts/otter-wavlm-speaker-resolver.js --limit 5

Add `--write` to apply matches. Known-voice matching is on by default with the ECAPA backend. Set `SPEAKER_ENABLE_KNOWN_MATCHES=1` to use it with WavLM, or `0` to turn it off.

Sync voice evidence into people files:

    node scripts/sync-voiceprints-to-people-files.js            # dry run
    node scripts/sync-voiceprints-to-people-files.js --write

## Voiceprint lock (separate feature)

`scripts/voiceprint-enroll.mjs` and `scripts/lib/voiceprint.js` store encrypted voice templates for a voice check before sensitive actions. They use `SB_VOICEPRINT_KEY` and are separate from the call speaker resolver above.

## Consent

Only add people who have agreed to have their voice recognized, and follow the recording laws where you live.
