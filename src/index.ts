/**
 * finidb on Node: the engine (see `core.ts`, which runs anywhere) plus everything that needs a machine —
 * persistence, the HTTP server, the MCP server, model documents and the Excel writer.
 */
export * from './core.js';
import { registerXlsxWriter } from './core.js';
import { exportWorkbook as writeWorkbook } from './export/workbook.js';
registerXlsxWriter(writeWorkbook as never);

// Persistence (doc 07 §4): oplog, binary snapshots and the durable database directory.
export { OpLog, withOplog, createPersistentFiniDB, replay, applyOp, readOplog, oplogOf } from './persist/oplog.js';
export type { FsyncPolicy, OplogOptions, OpRecord, PersistentDB } from './persist/oplog.js';
export { saveSnapshot, loadSnapshot, readSnapshotHeader } from './persist/snapshot.js';
export type { SnapshotHeader } from './persist/snapshot.js';
export { openDatabase, readMeta } from './persist/store.js';
export type { OpenOptions, OpenedDatabase, StoreMeta } from './persist/store.js';

// MCP server (doc 08 §2): the nine tools and the finicast_help prompt over any FiniDB instance.
export { createMcpServer, toToolError, ruleText, HELP } from './mcp/server.js';
export type { ToolError } from './mcp/server.js';

// Server (doc 07 §1–§3): `finidb serve`, the multi-database HTTP API, users and grants.
export { startServer, runQuery, HttpError, ROUTES } from './server/server.js';
export { describeTable, describeRules } from './view/describe.js';
export type { ServerOptions, ServerHandle, PersistenceHook, Op, DbEntry, ColumnarWindow, ServerQuery } from './server/server.js';
export { AuthStore, AuthError } from './server/auth.js';
export type { Role, Grant, Principal } from './server/auth.js';

export { filePersistence } from './server/persistence.js';

// Model documents (doc 08): apply an agent-written model in-process; `finidb build model.json`.
export { applyDocument, renderDocumentResult } from './build/document.js';
import { exportWorkbook, type ExportOptions, type ExportResult } from './export/workbook.js';
export { exportWorkbook } from './export/workbook.js';
export type { ExportOptions, ExportResult, DashboardExport, DashboardCardExport } from './export/workbook.js';
export { writeXlsx } from './export/xlsx.js';
export { modelLink, modelLinkPlain, parseModelLink, encodeModelFragment, decodeModelFragment } from './build/link.js';
export type { IterateSettings } from './schema/schema.js';
export { ITERATE_DEFAULTS, normalizeIterate } from './schema/schema.js';
export type { ModelDocument, PivotDoc, TableDoc, OutputDoc, DashboardDoc, DashboardCardDoc, DocumentResult } from './build/document.js';
export { normalizeDocument, DocumentError } from './build/normalize.js';
