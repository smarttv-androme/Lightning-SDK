/**
 * Logging, gated on the `platform.log` setting.
 *
 * @remarks
 * If more than one argument is passed and the first is a string, that first
 * argument is used as the label instead of the log level.
 */
declare const Log: {
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

export default Log;