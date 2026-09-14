/**
 * Timer ids. These wrap the browser's `setTimeout` / `setInterval`, which
 * return a number — deliberately not `ReturnType<typeof setTimeout>`, which
 * resolves to `NodeJS.Timeout` in any app that pulls in `@types/node`.
 */
export type TimeoutId = number;
export type IntervalId = number;

/**
 * Event handler. Typed loosely on the event because targets here range from
 * `window` to platform objects dispatching `CustomEvent`s with their own
 * `detail` shapes.
 */
export type RegistryEventHandler = (event: any) => void;

/**
 * Anything the registry can attach to. Structural rather than `EventTarget`:
 * the runtime only ever calls `addEventListener` / `removeEventListener`, so
 * player wrappers and other non-DOM emitters qualify.
 */
export interface RegistryEventTarget {
  addEventListener(...args: any[]): void;
  removeEventListener(...args: any[]): void;
}

/**
 * Tracked timers and event listeners, so everything can be torn down at once
 * on app close via {@link Registry.clear}.
 */
declare const Registry: {
  /**
   * Registers a timeout. Extra arguments are passed to the callback.
   */
  setTimeout(callback: (...params: any[]) => void, timeout?: number, ...params: any[]): TimeoutId;

  clearTimeout(timeoutId: TimeoutId): void;

  clearTimeouts(): void;

  /**
   * Registers an interval. Extra arguments are passed to the callback.
   */
  setInterval(
    callback: (...params: any[]) => void,
    interval?: number,
    ...params: any[]
  ): IntervalId;

  clearInterval(intervalId: IntervalId): void;

  clearIntervals(): void;

  addEventListener(
    target: RegistryEventTarget,
    event: string,
    handler: RegistryEventHandler
  ): void;

  removeEventListener(
    target: RegistryEventTarget,
    event: string,
    handler: RegistryEventHandler
  ): void;

  /**
   * Removes the listeners for `target` and `event`; every listener on `target`
   * when `event` is omitted; every registered listener when both are omitted.
   */
  removeEventListeners(target?: RegistryEventTarget, event?: string): void;

  /**
   * Clears all tracked timeouts, intervals and event listeners. Call on app
   * close.
   */
  clear(): void;
};

export default Registry;