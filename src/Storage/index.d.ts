/**
 * Namespaced persistent storage (cookies / localStorage via `localcookies`).
 *
 * @remarks
 * Keys are prefixed with the `platform.id` setting when one is configured.
 * Values round-trip through `JSON.stringify` / `JSON.parse`.
 */
declare const Storage: {
  /**
   * Reads a value. Returns `null` when the key is absent or the stored value
   * cannot be parsed.
   */
  get<T = any>(key: string): T | null;

  /**
   * Writes a value. Returns `false` when the value could not be serialised or
   * stored (for example when the quota is exceeded).
   */
  set(key: string, value: unknown): boolean;

  remove(key: string): void;

  /**
   * Removes every key in the namespace, or the whole store when no
   * `platform.id` is configured.
   */
  clear(): void;
};

export default Storage;