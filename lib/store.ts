/**
 * Credential persistence.
 *
 * {@link FileTokenStore} keeps one JSON file holding every signed-in mailbox, keyed by
 * address, plus a default. The file is created 0600 and rewritten atomically. It is
 * deliberately NOT shared with any other tool's credential file: a routine "logout"
 * elsewhere must never delete a Google refresh token without revoking it.
 * @module
 */

import { dirname } from "@std/path";
import type { OAuthCredential, TokenStore } from "./types.ts";

interface FileShape {
  version: 1;
  default?: string;
  accounts: Record<string, OAuthCredential>;
}

export interface FileTokenStoreOptions {
  /** Absolute path of the JSON file. Required — the library reads no env. */
  path: string;
}

export class FileTokenStore implements TokenStore {
  readonly path: string;

  constructor(opts: FileTokenStoreOptions) {
    this.path = opts.path;
  }

  private async read(): Promise<FileShape> {
    try {
      const raw = await Deno.readTextFile(this.path);
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      return {
        version: 1,
        default: parsed.default,
        accounts: parsed.accounts ?? {},
      };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return { version: 1, accounts: {} };
      }
      throw new Error(`Could not read credential store at ${this.path}.`);
    }
  }

  private async write(file: FileShape): Promise<void> {
    await Deno.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + "\n", {
      mode: 0o600,
    });
    await Deno.rename(tmp, this.path);
  }

  async load(account?: string): Promise<OAuthCredential | null> {
    const file = await this.read();
    const key = account?.toLowerCase() ?? file.default;
    if (!key) return null;
    return file.accounts[key] ?? null;
  }

  async save(cred: OAuthCredential): Promise<void> {
    const file = await this.read();
    const key = cred.email.toLowerCase();
    file.accounts[key] = cred;
    file.default ??= key;
    await this.write(file);
  }

  async delete(account: string): Promise<void> {
    const file = await this.read();
    const key = account.toLowerCase();
    delete file.accounts[key];
    if (file.default === key) file.default = Object.keys(file.accounts)[0];
    await this.write(file);
  }

  async list(): Promise<string[]> {
    return Object.keys((await this.read()).accounts);
  }

  async defaultAccount(): Promise<string | undefined> {
    return (await this.read()).default;
  }

  async setDefault(account: string): Promise<void> {
    const file = await this.read();
    const key = account.toLowerCase();
    if (!file.accounts[key]) {
      throw new Error(`No credential stored for ${account}.`);
    }
    file.default = key;
    await this.write(file);
  }
}

/** In-memory store for tests and one-shot scripts. */
export class MemoryTokenStore implements TokenStore {
  private accounts = new Map<string, OAuthCredential>();
  private defaultKey?: string;

  load(account?: string): Promise<OAuthCredential | null> {
    const key = account?.toLowerCase() ?? this.defaultKey;
    return Promise.resolve(key ? this.accounts.get(key) ?? null : null);
  }
  save(cred: OAuthCredential): Promise<void> {
    const key = cred.email.toLowerCase();
    this.accounts.set(key, cred);
    this.defaultKey ??= key;
    return Promise.resolve();
  }
  delete(account: string): Promise<void> {
    this.accounts.delete(account.toLowerCase());
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve([...this.accounts.keys()]);
  }
}
