/** Immutable raw funding bytes only. Validation remains with each consumer. */
export class FundingBytesCache {
  #entries = new Map();
  #bytes = 0;
  constructor({ maxEntries = 256, maxBytes = 16 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid funding byte cache bounds');
    Object.defineProperties(this, { maxEntries: { value: maxEntries }, maxBytes: { value: maxBytes } });
  }
  get size() { return this.#entries.size; }
  get retainedBytes() { return this.#bytes; }
  has(key) { return this.#entries.has(key); }
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key); this.#entries.set(key, entry);
    return entry.raw;
  }
  set(key, raw) {
    if (typeof key !== 'string' || typeof raw !== 'string') throw new Error('Funding cache requires immutable strings');
    const bytes = 256 + (key.length + raw.length) * 2;
    this.delete(key);
    // A valid oversized parent remains usable by the caller, but not retained.
    if (bytes > this.maxBytes) return this;
    while (this.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) this.delete(this.#entries.keys().next().value);
    this.#entries.set(key, { raw, bytes }); this.#bytes += bytes;
    return this;
  }
  delete(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#bytes -= entry.bytes;
    return this.#entries.delete(key);
  }
  clear() { this.#entries.clear(); this.#bytes = 0; }
}
