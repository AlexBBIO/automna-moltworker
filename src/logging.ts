/**
 * Persistent logging module for Moltbot Sandbox
 * 
 * Writes important events to R2 for debugging when wrangler tail isn't available.
 * Logs are stored as JSON lines in R2 under /_logs/
 */

import type { MoltbotEnv } from './types';

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Create a logger instance bound to environment
 */
export function createLogger(env: MoltbotEnv, source: string) {
  const log = async (level: LogEntry['level'], message: string, data?: Record<string, unknown>, error?: Error) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      data,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    // Always log to console for wrangler tail
    const consoleMsg = `[${source}] ${message}`;
    if (level === 'error') {
      console.error(consoleMsg, data || '', error || '');
    } else if (level === 'warn') {
      console.warn(consoleMsg, data || '');
    } else {
      console.log(consoleMsg, data || '');
    }

    // Write to R2 if bucket is available (fire and forget for non-critical)
    if (env.MOLTBOT_BUCKET && (level === 'error' || level === 'warn')) {
      try {
        await writeLogToR2(env, entry);
      } catch (e) {
        console.error('[logging] Failed to write to R2:', e);
      }
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log('debug', message, data),
    info: (message: string, data?: Record<string, unknown>) => log('info', message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('warn', message, data),
    error: (message: string, data?: Record<string, unknown>, error?: Error) => log('error', message, data, error),
  };
}

/**
 * Write a log entry to R2
 */
async function writeLogToR2(env: MoltbotEnv, entry: LogEntry): Promise<void> {
  if (!env.MOLTBOT_BUCKET) return;

  // Use date-based key for organization
  const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
  const key = `_logs/${date}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;

  await env.MOLTBOT_BUCKET.put(key, JSON.stringify(entry), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Fetch recent logs from R2 (for debugging)
 */
export async function getRecentLogs(env: MoltbotEnv, limit = 50): Promise<LogEntry[]> {
  if (!env.MOLTBOT_BUCKET) return [];

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const logs: LogEntry[] = [];

  for (const date of [today, yesterday]) {
    const list = await env.MOLTBOT_BUCKET.list({ prefix: `_logs/${date}/`, limit: limit - logs.length });
    
    for (const obj of list.objects) {
      const data = await env.MOLTBOT_BUCKET.get(obj.key);
      if (data) {
        try {
          logs.push(JSON.parse(await data.text()));
        } catch {
          // Skip malformed entries
        }
      }
      if (logs.length >= limit) break;
    }
    if (logs.length >= limit) break;
  }

  // Sort by timestamp descending
  return logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Global error handler wrapper
 */
export function wrapWithErrorLogging<T extends (...args: unknown[]) => Promise<unknown>>(
  env: MoltbotEnv,
  source: string,
  fn: T
): T {
  const logger = createLogger(env, source);
  
  return (async (...args: unknown[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error('Unhandled exception', { args: args.map(a => typeof a) }, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }) as T;
}
