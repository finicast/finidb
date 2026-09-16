/**
 * Users, grants and credentials for `finidb serve` (doc 07 §2, §6).
 *
 * State lives in `<dataDir>/auth.json`. Passwords are hashed with node:crypto scrypt and a
 * random salt (argon2id per §6 is not available as a built-in; the on-disk record carries an
 * `algo` tag so it can be migrated). Bearer tokens (§2 "short-lived bearer") are in-memory only.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type Role = 'read' | 'write' | 'admin';
const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };
export const ROLES: Role[] = ['read', 'write', 'admin'];

/** `db === '*'` is a server-wide grant; `admin` on `*` is the superuser. */
export interface Grant { user: string; db: string; role: Role }
interface UserRecord { name: string; algo: 'scrypt'; salt: string; hash: string; created: string }
interface AuthFile { users: UserRecord[]; grants: Grant[] }

/** The identity a request runs as. `trusted` is a loopback caller with requireAuth off (§2). */
export interface Principal { user: string; trusted: boolean }

const TOKEN_TTL_MS = 60 * 60 * 1000;

export class AuthStore {
  private file: AuthFile = { users: [], grants: [] };
  private tokens = new Map<string, { user: string; expires: number }>();
  private readonly path?: string;

  constructor(dataDir?: string) {
    if (dataDir) {
      this.path = join(dataDir, 'auth.json');
      if (existsSync(this.path)) this.file = JSON.parse(readFileSync(this.path, 'utf8')) as AuthFile;
    }
  }

  private save() {
    if (!this.path) return;
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // ---- users -------------------------------------------------------------------------------

  listUsers(): { name: string; created: string; grants: Grant[] }[] {
    return this.file.users.map(u => ({ name: u.name, created: u.created, grants: this.file.grants.filter(g => g.user === u.name) }));
  }
  hasUser(name: string): boolean { return this.file.users.some(u => u.name === name); }

  createUser(name: string, password: string): void {
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) throw new AuthError('AUTH_BAD_USERNAME', `invalid user name '${name}'`, 400);
    if (typeof password !== 'string' || password.length < 1) throw new AuthError('AUTH_BAD_PASSWORD', 'password required', 400);
    if (this.hasUser(name)) throw new AuthError('AUTH_DUPLICATE_USER', `user '${name}' exists`, 409);
    const salt = randomBytes(16).toString('hex');
    this.file.users.push({ name, algo: 'scrypt', salt, hash: hashPassword(password, salt), created: new Date().toISOString() });
    this.save();
  }
  deleteUser(name: string): void {
    this.file.users = this.file.users.filter(u => u.name !== name);
    this.file.grants = this.file.grants.filter(g => g.user !== name);
    for (const [t, v] of this.tokens) if (v.user === name) this.tokens.delete(t);
    this.save();
  }

  /** Returns the user name when the password matches, else undefined. Constant-time compare. */
  verify(name: string, password: string): string | undefined {
    const u = this.file.users.find(x => x.name === name);
    if (!u) { hashPassword(password, '00'); return undefined; }   // burn the same time for unknown users
    const a = Buffer.from(hashPassword(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? u.name : undefined;
  }

  // ---- grants ------------------------------------------------------------------------------

  grant(user: string, db: string, role: Role): void {
    if (!this.hasUser(user)) throw new AuthError('AUTH_NO_USER', `no user '${user}'`, 404);
    if (!ROLES.includes(role)) throw new AuthError('AUTH_BAD_ROLE', `role must be one of ${ROLES.join('|')}`, 400);
    this.file.grants = this.file.grants.filter(g => !(g.user === user && g.db === db));
    this.file.grants.push({ user, db, role });
    this.save();
  }
  revoke(user: string, db: string): void {
    this.file.grants = this.file.grants.filter(g => !(g.user === user && g.db === db));
    this.save();
  }
  grantsOf(user: string): Grant[] { return this.file.grants.filter(g => g.user === user); }

  /** Effective role of `p` on `db`: the higher of the db grant and the server-wide (`*`) grant. */
  roleOn(p: Principal, db: string): Role | undefined {
    if (p.trusted) return 'admin';
    let best: Role | undefined;
    for (const g of this.file.grants) {
      if (g.user !== p.user || (g.db !== db && g.db !== '*')) continue;
      if (!best || RANK[g.role] > RANK[best]) best = g.role;
    }
    return best;
  }
  allows(p: Principal, db: string, need: Role): boolean {
    const r = this.roleOn(p, db);
    return r !== undefined && RANK[r] >= RANK[need];
  }
  isSuperuser(p: Principal): boolean { return p.trusted || this.file.grants.some(g => g.user === p.user && g.db === '*' && g.role === 'admin'); }

  // ---- tokens ------------------------------------------------------------------------------

  issueToken(user: string): { token: string; expiresIn: number } {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { user, expires: Date.now() + TOKEN_TTL_MS });
    return { token, expiresIn: TOKEN_TTL_MS / 1000 };
  }
  userForToken(token: string): string | undefined {
    const t = this.tokens.get(token);
    if (!t) return undefined;
    if (t.expires < Date.now()) { this.tokens.delete(token); return undefined; }
    return t.user;
  }

  /**
   * Resolve the `Authorization` header (Basic or Bearer) to a user name.
   * Returns undefined when absent, throws AUTH_INVALID when present but wrong.
   */
  authenticate(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const [scheme, rest] = header.split(/\s+/, 2);
    if (/^basic$/i.test(scheme) && rest) {
      const decoded = Buffer.from(rest, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const user = this.verify(decoded.slice(0, i), decoded.slice(i + 1));
      if (user) return user;
    } else if (/^bearer$/i.test(scheme) && rest) {
      const user = this.userForToken(rest);
      if (user) return user;
    }
    throw new AuthError('AUTH_INVALID', 'invalid credentials', 401);
  }
}

export class AuthError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}
