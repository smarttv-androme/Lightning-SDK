/**
 * The three setting scopes. `app` and `platform` are populated at launch;
 * `user` is whatever {@link Settings.set} has written this session.
 */
export type SettingsType = 'app' | 'platform' | 'user';

/**
 * Callback invoked when a `user` setting changes.
 */
export type SettingsSubscriber<T = any> = (value: T) => void;

declare const Settings: {
  /**
   * Reads a setting. `key` may be dot-separated to reach nested values.
   * Returns `fallback` (default `undefined`) when the key is not set.
   */
  get<T = any>(type: SettingsType, key: string, fallback?: any): T;

  /**
   * Whether the setting resolves to a truthy value.
   *
   * @remarks
   * This is a truthiness check, not a presence check: a setting explicitly set
   * to `false`, `0` or `''` reports `false`.
   */
  has(type: SettingsType, key: string): boolean;

  /**
   * Writes a `user` setting and notifies its subscribers.
   */
  set(key: string, value: unknown): void;

  subscribe<T = any>(key: string, callback: SettingsSubscriber<T>): void;

  /**
   * Removes one subscriber, or every subscriber for `key` when `callback` is
   * omitted.
   */
  unsubscribe<T = any>(key: string, callback?: SettingsSubscriber<T>): void;

  clearSubscribers(): void;
};

export default Settings;