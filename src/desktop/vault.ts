import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}
/** Only the trusted desktop process instantiates this class. Never returned over IPC. */
export class Vault {
  private values: Record<string, string> = {};
  private locked = false;
  readonly path: string;
  constructor(
    directory: string,
    private encryption: Encryption,
  ) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'secrets.bin');
    if (existsSync(this.path)) {
      try {
        if (!encryption.isEncryptionAvailable()) throw new Error('unavailable');
        const parsed = JSON.parse(encryption.decryptString(readFileSync(this.path)));
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Object.values(parsed).some((x) => typeof x !== 'string')
        )
          throw new Error('invalid');
        this.values = parsed;
      } catch {
        this.locked = true;
      }
    }
  }
  get available(): boolean {
    return !this.locked && this.encryption.isEncryptionAvailable();
  }
  get(key: string): string | undefined {
    return this.locked ? undefined : this.values[key];
  }
  set(key: string, value: string | undefined): void {
    this.setMany({ [key]: value });
  }
  setMany(changes: Record<string, string | undefined>): void {
    if (!this.available)
      throw new Error(
        '凭据库无法解密或加密不可用。请保留 secrets.bin 备份，按故障说明重建凭据库。',
      );
    const next = { ...this.values };
    for (const [key, value] of Object.entries(changes)) {
      if (value) next[key] = value;
      else delete next[key];
    }
    const temp = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, this.encryption.encryptString(JSON.stringify(next)), { mode: 0o600 });
    renameSync(temp, this.path);
    this.values = next;
  }
}
