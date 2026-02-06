export class TtlCache<T> {
  private value: T | null = null;
  private expiresAt = 0;

  get(now = Date.now()): T | null {
    if (now < this.expiresAt) return this.value;
    return null;
  }

  set(value: T, ttlMs: number) {
    this.value = value;
    this.expiresAt = Date.now() + ttlMs;
  }

  clear() {
    this.value = null;
    this.expiresAt = 0;
  }
}
