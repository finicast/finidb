/**
 * File persistence for the server (doc 07 §4): each database lives in `<dataDir>/<name>/` as an
 * oplog plus snapshots, opened through `openDatabase`. The opened FiniDB records every facade
 * call itself, so the server's `append` hook is not needed.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
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
    /** A copy is a new database with the same contents and a clean history: snapshot the source, take that
     *  snapshot (and nothing else), and open the copy on it, so the copy carries no trace of the original's log. */
    async copy(from, fromDir, to, toDir) {
      const src = opened.get(from);
      mkdirSync(toDir, { recursive: true });
      if (src) {
        const file = await src.snapshot();
        copyFileSync(file, join(toDir, basename(file)));
        copyFileSync(join(fromDir, 'meta.json'), join(toDir, 'meta.json'));
      } else {
        cpSync(fromDir, toDir, { recursive: true });
      }
      const o = await openDatabase(toDir, { engine: opts.engine, fsync: opts.fsync } as never);
      opened.set(to, o);
      return o.f;
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
