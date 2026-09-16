#!/usr/bin/env node
/**
 * FiniDB MCP server, stdio transport (doc 08 §1, local mode).
 *
 *   node dist/mcp/main.js            (after npm run build)
 *   node --import tsx src/mcp/main.ts
 *
 * Nothing may be written to stdout except JSON-RPC: diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FiniDB } from '../index.js';
import { createMcpServer } from './server.js';

let f: FiniDB;
let closeDb: (() => Promise<void>) | undefined;
if (process.env.FINIDB_DIR) {
  // Persistence (doc 07 §4): oplog replay on start, append on every write, snapshot on exit.
  const { openDatabase } = await import('../persist/store.js');
  const opened = await openDatabase(process.env.FINIDB_DIR);
  f = opened.f;
  closeDb = async () => { await opened.snapshot(); await opened.close(); };
  process.stderr.write(`[finidb] persistent database at ${process.env.FINIDB_DIR}\n`);
} else {
  f = new FiniDB();
  process.stderr.write('[finidb] in-memory database; set FINIDB_DIR=<dir> to persist\n');
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { if (closeDb) await closeDb(); process.exit(0); });

const server = createMcpServer(f);
await server.connect(new StdioServerTransport());
