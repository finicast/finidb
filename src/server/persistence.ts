/**
 * File persistence for the server (doc 07 §4): each database lives in `<dataDir>/<name>/` as an
 * oplog plus snapshots, opened through `openDatabase`. The opened FiniDB records every facade
 * call itself, so the server's `append` hook is not needed.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PersistenceHook } from './server.js';
import { openDatabase, OpenedDatabase } from '../persist/store.js';

export function filePersistence(opts: { engine?: 'incremental' | 'reference'; fsync?: 'always' | 'interval' | 'never' } = {}): PersistenceHook & { opened: Map<string, OpenedDatabase>; closeAll(): Promise<void> } {
  const opened = new Map<string, OpenedDatabase>();
  return {
    opened,
    async open(name, dir) {
      const o = await openDatabase(dir, { engine: opts.engine, fsync: opts.fsync } as any);
      opened.set(name, o);
      return o.f;
    },
    list(dataDir) {
      if (!existsSync(dataDir)) return [];
      return readdirSync(dataDir).filter(n => {
        const d = join(dataDir, n);
        return statSync(d).isDirectory() && (existsSync(join(d, 'oplog.jsonl')) || existsSync(join(d, 'meta.json')));
      });
    },
    async drop(name, dir) {
      const o = opened.get(name);
      if (o) { await o.close(); opened.delete(name); }
      rmSync(dir, { recursive: true, force: true });
    },
    async closeAll() {
      for (const o of opened.values()) await o.close();
      opened.clear();
    },
  };
}
