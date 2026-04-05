/**
 * ingest-gmail.ts — Bulk Gmail ingestion into Graphiti
 * 
 * Fetches all meaningful sent emails (excluding promotions/social/updates)
 * and ingests them into Graphiti knowledge graph as episodes.
 * 
 * Usage: Set GMAIL_TOKEN env or run via Claude Code with Gmail MCP.
 * This script reads pre-exported email data from stdin (JSON lines format).
 */
