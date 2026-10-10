# Otter.ai meeting scanning

SecondBrain pulls your Otter.ai meeting transcripts into the desktop app, tags them, and keeps them searchable.

## What happens while the app runs

- The app checks Otter.ai for new transcripts every 5 minutes.
- Each new transcript is tagged, saved to your SecondBrain data folder, and added to the local conversation database.
- Each new transcript also creates an unapproved task in the Tasks tab so you can review follow-ups. The task worker runs only tasks you approve. Set `SECONDBRAIN_TASK_WORKER=off` to turn the worker off.
- If no Otter.ai credentials are saved, polling stays off and the app logs why.

## Set it up

1. Install dependencies with `npm install`, then start the app with `npm run dev`.
2. Open Settings, go to Otter.ai, and click "Login with Otter.ai". Email and password login and Google sign-in are both supported.
3. Keep the app running. New transcripts appear on the Conversations page.

## Pull a date range from the command line

    node scripts/otter-pull-today.js                        # today (US Central time)
    node scripts/otter-pull-today.js 2026-05-28             # one day
    node scripts/otter-pull-today.js 2026-05-27 2026-05-28  # several days

The script reads the same saved Otter.ai credentials. On Windows it writes each transcript and its metadata to `%APPDATA%\secondbrain\data\conversations\otter_<id>\`, and the app picks the files up on its next refresh.

## Knowledge graph

Transcripts can also feed a Graphiti knowledge graph. That integration ships turned off in `config/graphiti-runtime-policy.json`, so nothing is sent to a graph unless you run your own Graphiti service and enable the policy.
