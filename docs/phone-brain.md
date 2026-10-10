# Phone brain

`claude-proxy.js` lets Vapi phone calls use your Codex or Claude subscription as the language model. It runs on your computer and exposes an OpenAI-compatible chat completions endpoint.

## How it answers

- It tries lanes in order: the Codex app server, the Codex CLI, then the Claude CLI.
- A quota or sign-in failure on one provider moves the call to the next lane automatically.
- `GET /health` reports lane health and turns green only after recent successful calls.

## Requirements

- Node.js and this repository's dependencies (`npm install`).
- The Codex CLI, the Claude CLI, or both, installed and signed in. Set `CODEX_PATH` if the Codex CLI is not on your PATH.
- A Vapi assistant configured to use a custom LLM.
- A way for Vapi to reach your computer, such as an SSH reverse tunnel through a server you control.

## Run it

    node claude-proxy.js

The proxy listens on `127.0.0.1:3456`. Set `PORT` to use another port. It accepts `POST /chat/completions` and `POST /v1/chat/completions`.

## Connect Vapi

1. Forward the port to a server you control: `ssh -R 3456:localhost:3456 user@your-server`.
2. Expose that port over HTTPS on the server.
3. In your Vapi assistant, select a custom LLM and set its URL to that HTTPS address.
4. Place a test call and watch the proxy log.

## Tools during calls

On the Claude lane, when a call includes function tools, the proxy passes an MCP configuration to the Claude CLI so the tools stay reachable. By default it reads `scripts/vapi-mcp/config.json`. Set `CLAUDE_PROXY_MCP_CONFIG` to use another file. A minimal configuration:

    {
      "mcpServers": {
        "vapi": { "command": "node", "args": ["/absolute/path/to/scripts/vapi-mcp/server.js"] }
      }
    }
