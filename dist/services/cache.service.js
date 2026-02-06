export class TtlCache {
    value = null;
    expiresAt = 0;
    get(now = Date.now()) {
        if (now < this.expiresAt)
            return this.value;
        return null;
    }
    set(value, ttlMs) {
        this.value = value;
        this.expiresAt = Date.now() + ttlMs;
    }
    clear() {
        this.value = null;
        this.expiresAt = 0;
    }
}
