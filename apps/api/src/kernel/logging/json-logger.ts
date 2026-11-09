import type { LoggerService, LogLevel } from '@nestjs/common';
import type { AppConfig } from '../config';
import { currentLogContext } from './log-context';

/** Severity order: a logger at a level writes that level and everything more severe. */
const SEVERITY: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/** Field names whose values never reach a log line (§4.14 protected secrets). */
const SECRET_FIELD = /authorization|token|passcode|secret|password|cookie/i;

export interface JsonLoggerOptions {
  level: LogLevel;
  /** Process role written on every line (`api`, `worker`). */
  service: string;
  version?: string;
  /** Line sink; defaults to stdout (stderr for warn and above). */
  write?: (line: string, level: LogLevel) => void;
  now?: () => Date;
}

/**
 * One JSON object per line for log collectors (§5.11 observability, §4.10): time, level, service,
 * context, message, the correlation id of the request being served (AsyncLocalStorage), the stack
 * of an error, and the fields of a structured message. Secret-looking fields are replaced. It
 * implements the framework's logger interface, so every `new Logger(context)` in the modules
 * writes through it without change.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly now: () => Date;

  constructor(private readonly options: JsonLoggerOptions) {
    this.threshold = SEVERITY[options.level];
    this.write =
      options.write ??
      ((line, level) => {
        (SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout).write(`${line}\n`);
      });
    this.now = options.now ?? (() => new Date());
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] < this.threshold) return;
    // The framework passes (message, context) and, for errors, (message, stack, context).
    const rest = [...params];
    const context =
      rest.length > 0 && typeof rest[rest.length - 1] === 'string'
        ? (rest.pop() as string)
        : undefined;
    let stack = rest.find((p): p is string => typeof p === 'string' && p.includes('\n'));
    const line: Record<string, unknown> = {
      time: this.now().toISOString(),
      level,
      service: this.options.service,
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(context ? { context } : {}),
    };
    if (message instanceof Error) {
      line['message'] = message.message;
      stack = stack ?? message.stack;
    } else if (message !== null && typeof message === 'object') {
      Object.assign(line, redact(message as Record<string, unknown>));
    } else {
      line['message'] = String(message);
    }
    const correlationId = currentLogContext()?.correlationId;
    if (correlationId && line['correlationId'] === undefined) line['correlationId'] = correlationId;
    if (stack) line['stack'] = stack;
    this.write(safeStringify(line), level);
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : value;
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ level: 'error', message: 'log line could not be serialized' });
  }
}

/**
 * The logger for a process (§5.11): JSON lines when `LOG_FORMAT=json` (the production default),
 * otherwise the framework's readable console output at `LOG_LEVEL`.
 */
export function createLogger(config: AppConfig, service: string): LoggerService | LogLevel[] {
  const format = config.LOG_FORMAT ?? (config.NODE_ENV === 'production' ? 'json' : 'text');
  if (format === 'json') {
    return new JsonLogger({ level: config.LOG_LEVEL, service, version: config.APP_VERSION });
  }
  return [config.LOG_LEVEL];
}
