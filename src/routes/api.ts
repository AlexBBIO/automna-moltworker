import { Hono } from 'hono';
import type { Sandbox } from '@cloudflare/sandbox';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, mountR2Storage, syncToR2, waitForProcess } from '../gateway';
import { R2_MOUNT_PATH } from '../config';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to approve the device (CLI is still named clawdbot)
    const proc = await sandbox.startProcess(`clawdbot devices approve ${requestId} --url ws://localhost:18789`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices (CLI is still named clawdbot)
    const listProc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(`clawdbot devices approve ${device.requestId} --url ws://localhost:18789`);
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID && 
    c.env.R2_SECRET_ACCESS_KEY && 
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);
      
      // Check for sync marker file
      const proc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials 
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');
  
  const result = await syncToR2(sandbox, c.env);
  
  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json({
      success: false,
      error: result.error,
      details: result.details,
    }, status);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);
    
    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise(r => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess 
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/workspace/reset - Reset workspace to Clawdbot defaults
// This deletes the user's workspace backup from R2, triggering fresh setup on next login
adminApi.post('/workspace/reset', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.req.query('userId');
  
  if (!userId) {
    return c.json({ error: 'userId query parameter required' }, 400);
  }

  try {
    // Delete the workspace folder from R2 backup
    const userBackupPath = `${R2_MOUNT_PATH}/users/${userId}/workspace`;
    
    // First, make sure R2 is mounted
    await mountR2Storage(sandbox, c.env);
    
    // Check if the workspace exists
    const checkProc = await sandbox.startProcess(`ls -la "${userBackupPath}" 2>&1`);
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    
    if (checkLogs.stderr?.includes('No such file')) {
      return c.json({ 
        success: true, 
        message: 'Workspace backup not found (already clean)',
        userId 
      });
    }
    
    // Delete the workspace backup
    const deleteProc = await sandbox.startProcess(`rm -rf "${userBackupPath}" && echo "deleted"`);
    await waitForProcess(deleteProc, 10000);
    const deleteLogs = await deleteProc.getLogs();
    
    const success = deleteLogs.stdout?.includes('deleted');
    
    if (success) {
      return c.json({
        success: true,
        message: 'Workspace backup deleted. User will get fresh setup on next login.',
        userId,
      });
    } else {
      return c.json({
        success: false,
        error: 'Failed to delete workspace',
        stdout: deleteLogs.stdout,
        stderr: deleteLogs.stderr,
      }, 500);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/workspace/list - List user workspaces in R2
adminApi.get('/workspace/list', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    await mountR2Storage(sandbox, c.env);
    
    const proc = await sandbox.startProcess(`ls -la "${R2_MOUNT_PATH}/users/" 2>&1`);
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    
    return c.json({
      stdout: logs.stdout,
      stderr: logs.stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

/**
 * OPTIONS /api/history - CORS preflight
 */
api.options('/history', (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  return c.text('', 204);
});

/**
 * Parse JSONL content into messages array
 */
function parseJSONLHistory(content: string): Array<{ role: string; content: unknown; timestamp?: number }> {
  const messages: Array<{ role: string; content: unknown; timestamp?: number }> = [];
  const lines = content.split(/\r?\n/);
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // Handle both formats: { message: {...} } and direct { role, content }
      const msg = parsed.message || parsed;
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        messages.push({
          role: msg.role,
          content: msg.content,
          timestamp: parsed.timestamp || msg.timestamp,
        });
      }
    } catch {
      // Skip invalid JSON lines
    }
  }
  
  return messages;
}

/**
 * GET /api/history - Get chat history
 * 
 * Fast path: Read directly from R2 (no container boot needed)
 * Slow path: Fall back to container if R2 read fails
 * 
 * R2 data is synced every 5 minutes, so it may be slightly stale.
 * For fresh history during active session, WebSocket provides real-time updates.
 */
api.get('/history', async (c) => {
  // Add CORS headers for cross-origin requests from automna.ai
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  
  const userId = c.get('userId');
  const sessionKey = c.req.query('sessionKey') || 'main';
  
  if (!userId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  // === FAST PATH: Read directly from R2 ===
  try {
    const bucket = c.env.MOLTBOT_BUCKET;
    if (bucket) {
      // First, read sessions.json to find the session file path
      const sessionsKey = `users/${userId}/clawdbot/agents/main/sessions/sessions.json`;
      const sessionsObj = await bucket.get(sessionsKey);
      
      if (sessionsObj) {
        const sessionsData = JSON.parse(await sessionsObj.text());
        const sessionEntry = sessionsData[sessionKey];
        
        if (sessionEntry?.sessionFile) {
          // Extract the relative path from the session file
          // sessionFile is like "/root/.clawdbot/agents/main/sessions/main/history.jsonl"
          // We need "agents/main/sessions/main/history.jsonl"
          const relativePath = sessionEntry.sessionFile.replace(/^\/root\/\.clawdbot\//, '');
          const historyKey = `users/${userId}/clawdbot/${relativePath}`;
          
          const historyObj = await bucket.get(historyKey);
          if (historyObj) {
            const content = await historyObj.text();
            const messages = parseJSONLHistory(content);
            console.log(`[history] R2 fast path: ${messages.length} messages for ${sessionKey}`);
            return c.json({ sessionKey, messages, source: 'r2' });
          }
        }
      }
      
      // Session not found in R2 - might be new user or not synced yet
      console.log(`[history] R2 miss for user ${userId}, session ${sessionKey}`);
    }
  } catch (err) {
    console.warn('[history] R2 read failed, falling back to container:', err);
  }

  // === SLOW PATH: Fall back to container ===
  const sandbox = c.get('sandbox');
  
  try {
    // Ensure gateway is running
    await ensureMoltbotGateway(sandbox, c.env);
    
    // Read sessions.json and find the JSONL file for this session
    const script = `
      const fs = require('fs');
      const storePath = '/root/.clawdbot/agents/main/sessions/sessions.json';
      if (!fs.existsSync(storePath)) {
        console.log(JSON.stringify({ error: 'sessions.json not found' }));
        process.exit(0);
      }
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      const entry = store['${sessionKey}'];
      if (!entry) {
        console.log(JSON.stringify({ error: 'session not found', keys: Object.keys(store) }));
        process.exit(0);
      }
      const sessionFile = entry.sessionFile;
      if (!fs.existsSync(sessionFile)) {
        console.log(JSON.stringify({ error: 'JSONL file not found', sessionFile }));
        process.exit(0);
      }
      const lines = fs.readFileSync(sessionFile, 'utf-8').split(/\\r?\\n/);
      const messages = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const msg = parsed.message || parsed;
          if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
            messages.push({ role: msg.role, content: msg.content, timestamp: parsed.timestamp || msg.timestamp });
          }
        } catch {}
      }
      console.log(JSON.stringify({ sessionKey: '${sessionKey}', messages, source: 'container' }));
    `;
    
    const proc = await sandbox.startProcess(
      'node -e ' + JSON.stringify(script.replace(/\n/g, ' '))
    );
    await waitForProcess(proc, 10000);
    
    const logs = await proc.getLogs();
    try {
      return c.json(JSON.parse(logs.stdout || '{}'));
    } catch {
      return c.json({ error: 'Failed to parse output', stdout: logs.stdout, stderr: logs.stderr }, 500);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * POST /api/reset-workspace - Reset workspace to Clawdbot defaults
 * 
 * This deletes the user's workspace backup from R2, triggering fresh setup on next login.
 * Uses signed URL auth (same as webchat) - users can only reset their own workspace.
 * 
 * Optional query params:
 * - force: If "true" and user is admin, can reset any userId specified
 * - targetUserId: (admin only) Reset a different user's workspace
 */
api.post('/reset-workspace', async (c) => {
  const userId = c.get('userId');
  const adminSecret = c.req.query('adminSecret');
  const targetUserId = c.req.query('targetUserId');
  const clearSessions = c.req.query('clearSessions') !== 'false'; // Default true
  
  // Check for admin override: matches gateway token
  const isAdmin = adminSecret && c.env.MOLTBOT_GATEWAY_TOKEN && adminSecret === c.env.MOLTBOT_GATEWAY_TOKEN;
  
  // Determine which user's workspace to reset
  const resetUserId = (isAdmin && targetUserId) ? targetUserId : userId;
  
  if (!resetUserId) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const sandbox = c.get('sandbox');
  const results: { workspace?: string; sessions?: string; clawdbot?: string } = {};

  try {
    // Mount R2 if not already mounted
    await mountR2Storage(sandbox, c.env);
    
    // 1. Delete the workspace folder from R2 backup
    const userBackupPath = `${R2_MOUNT_PATH}/users/${resetUserId}/workspace`;
    const deleteWorkspaceProc = await sandbox.startProcess(`rm -rf "${userBackupPath}" 2>&1 && echo "workspace_deleted"`);
    await waitForProcess(deleteWorkspaceProc, 10000);
    const workspaceLogs = await deleteWorkspaceProc.getLogs();
    results.workspace = workspaceLogs.stdout?.includes('workspace_deleted') ? 'deleted' : 'not found or failed';
    
    // 2. Delete clawdbot data (sessions, config, etc.) if clearSessions is true
    if (clearSessions) {
      const clawdbotPath = `${R2_MOUNT_PATH}/users/${resetUserId}/clawdbot`;
      const deleteClawdbotProc = await sandbox.startProcess(`rm -rf "${clawdbotPath}" 2>&1 && echo "clawdbot_deleted"`);
      await waitForProcess(deleteClawdbotProc, 10000);
      const clawdbotLogs = await deleteClawdbotProc.getLogs();
      results.clawdbot = clawdbotLogs.stdout?.includes('clawdbot_deleted') ? 'deleted' : 'not found or failed';
      
      // 3. Restart the gateway to clear in-memory sessions
      const existingProcess = await findExistingMoltbotProcess(sandbox);
      if (existingProcess) {
        try {
          await existingProcess.kill();
          await new Promise(r => setTimeout(r, 1000));
        } catch (killErr) {
          console.error('Error killing gateway during reset:', killErr);
        }
      }
      // Start fresh gateway in background
      const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
        console.error('Gateway restart during reset failed:', err);
      });
      c.executionCtx.waitUntil(bootPromise);
    }
    
    return c.json({
      success: true,
      message: 'User data cleared and gateway restarted. Refresh to see fresh state.',
      userId: resetUserId,
      isAdmin,
      cleared: results,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, partialResults: results }, 500);
  }
});

// ============================================
// FILE MANAGEMENT APIs
// ============================================

const WORKSPACE_ROOT = '/root/clawd';
const MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10MB
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;  // 50MB
const FILE_CACHE_TTL_SECONDS = 60;  // Cache files for 60 seconds

/**
 * Get R2 key for a file path
 * Converts /root/clawd/foo/bar.md → users/{userId}/workspace/foo/bar.md
 */
function getFileR2Key(userId: string, filePath: string): string {
  const relativePath = filePath.replace(/^\/root\/clawd\/?/, '');
  return `users/${userId}/workspace/${relativePath}`;
}

/**
 * Check if cached file is still fresh based on stored mtime
 */
function isCacheFresh(cachedMtime: string | null, ttlSeconds: number = FILE_CACHE_TTL_SECONDS): boolean {
  if (!cachedMtime) return false;
  const cachedTime = parseInt(cachedMtime, 10);
  const now = Math.floor(Date.now() / 1000);
  return (now - cachedTime) < ttlSeconds;
}

/**
 * Read file from R2 storage (source of truth)
 * Returns null if file doesn't exist in R2
 * 
 * Note: R2 is now the primary storage, not just a cache.
 * Files are synced from container to R2 periodically.
 */
async function readFileFromR2(
  bucket: R2Bucket | undefined,
  userId: string,
  filePath: string,
  checkFreshness: boolean = false  // Set true for cache behavior, false for source-of-truth
): Promise<{ content: string; size: number; modified: string; source: 'r2' } | null> {
  if (!bucket) return null;
  
  try {
    const r2Key = getFileR2Key(userId, filePath);
    const obj = await bucket.get(r2Key);
    
    if (!obj) return null;
    
    // Only check freshness if explicitly requested (cache mode)
    if (checkFreshness) {
      const cachedAt = obj.customMetadata?.cachedAt;
      if (!isCacheFresh(cachedAt)) {
        console.log(`[files] R2 stale for ${filePath}`);
        return null;
      }
    }
    
    const content = await obj.text();
    const size = obj.size || parseInt(obj.customMetadata?.size || '0', 10);
    const modified = obj.customMetadata?.modified || obj.uploaded?.toISOString() || new Date().toISOString();
    
    console.log(`[files] R2 hit for ${filePath}`);
    return { content, size, modified, source: 'r2' };
  } catch (err) {
    console.warn(`[files] R2 read error for ${filePath}:`, err);
    return null;
  }
}

/**
 * Write file to R2 cache
 */
async function writeFileToR2(
  bucket: R2Bucket | undefined,
  userId: string,
  filePath: string,
  content: string,
  size: number,
  modified: string
): Promise<boolean> {
  if (!bucket) return false;
  
  try {
    const r2Key = getFileR2Key(userId, filePath);
    await bucket.put(r2Key, content, {
      customMetadata: {
        size: size.toString(),
        modified,
        cachedAt: Math.floor(Date.now() / 1000).toString(),
      },
    });
    console.log(`[files] Cached to R2: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`[files] R2 write error for ${filePath}:`, err);
    return false;
  }
}

/**
 * Delete file from R2 cache
 */
async function deleteFileFromR2(
  bucket: R2Bucket | undefined,
  userId: string,
  filePath: string
): Promise<boolean> {
  if (!bucket) return false;
  
  try {
    const r2Key = getFileR2Key(userId, filePath);
    await bucket.delete(r2Key);
    console.log(`[files] Deleted from R2: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`[files] R2 delete error for ${filePath}:`, err);
    return false;
  }
}

// Directory listing cache (shorter TTL since dirs change more often)
const DIR_CACHE_TTL_SECONDS = 30;

interface FileListItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  extension?: string;
}

/**
 * Get R2 key for directory listing cache
 */
function getDirR2Key(userId: string, dirPath: string): string {
  const relativePath = dirPath.replace(/^\/root\/clawd\/?/, '') || '_root';
  return `users/${userId}/dir-cache/${relativePath}.json`;
}

/**
 * Read directory listing from R2 cache
 */
async function readDirFromR2(
  bucket: R2Bucket | undefined,
  userId: string,
  dirPath: string
): Promise<{ files: FileListItem[]; parent: string | null } | null> {
  if (!bucket) return null;
  
  try {
    const r2Key = getDirR2Key(userId, dirPath);
    const obj = await bucket.get(r2Key);
    
    if (!obj) return null;
    
    const cachedAt = obj.customMetadata?.cachedAt;
    if (!isCacheFresh(cachedAt, DIR_CACHE_TTL_SECONDS)) {
      console.log(`[files] Dir cache stale for ${dirPath}`);
      return null;
    }
    
    const data = JSON.parse(await obj.text());
    console.log(`[files] Dir cache hit for ${dirPath}`);
    return data;
  } catch (err) {
    console.warn(`[files] Dir cache read error:`, err);
    return null;
  }
}

/**
 * Write directory listing to R2 cache
 */
async function writeDirToR2(
  bucket: R2Bucket | undefined,
  userId: string,
  dirPath: string,
  files: FileListItem[],
  parent: string | null
): Promise<boolean> {
  if (!bucket) return false;
  
  try {
    const r2Key = getDirR2Key(userId, dirPath);
    await bucket.put(r2Key, JSON.stringify({ files, parent }), {
      customMetadata: {
        cachedAt: Math.floor(Date.now() / 1000).toString(),
      },
    });
    console.log(`[files] Dir cached to R2: ${dirPath}`);
    return true;
  } catch (err) {
    console.warn(`[files] Dir cache write error:`, err);
    return false;
  }
}

/**
 * Invalidate directory cache for a path and its parent
 */
async function invalidateDirCache(
  bucket: R2Bucket | undefined,
  userId: string,
  filePath: string
): Promise<void> {
  if (!bucket) return;
  
  // Invalidate the directory containing the file
  const dirPath = filePath.substring(0, filePath.lastIndexOf('/')) || WORKSPACE_ROOT;
  const dirKey = getDirR2Key(userId, dirPath);
  
  try {
    await bucket.delete(dirKey);
    console.log(`[files] Dir cache invalidated: ${dirPath}`);
  } catch {
    // Ignore errors
  }
}

// Text file extensions worth pre-fetching
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx', 'py', 'css', 'html', 'xml', 'toml', 'ini', 'env', 'sh']);
const MAX_PREFETCH_SIZE = 100 * 1024;  // 100KB max per file
const MAX_PREFETCH_FILES = 10;  // Max files to pre-fetch per directory

/**
 * Pre-fetch small text files from a directory listing and cache in R2.
 * Called in background after directory listing to speed up file opens.
 */
async function preFetchSmallFiles(
  sandbox: Sandbox,
  bucket: R2Bucket | undefined,
  userId: string,
  files: FileListItem[]
): Promise<void> {
  if (!bucket) return;
  
  // Filter to small text files worth pre-fetching
  const textFiles = files.filter(f => 
    f.type === 'file' && 
    f.size > 0 && 
    f.size < MAX_PREFETCH_SIZE &&
    f.extension && 
    TEXT_EXTENSIONS.has(f.extension.toLowerCase())
  ).slice(0, MAX_PREFETCH_FILES);
  
  if (textFiles.length === 0) return;
  
  console.log(`[files] Pre-fetching ${textFiles.length} text files`);
  
  // Build a single shell command to cat all files with delimiters
  // Format: ===FILE:/path===\ncontent\n===END===
  const paths = textFiles.map(f => f.path);
  const catCmd = paths.map(p => `echo "===FILE:${p}===" && cat "${p}" && echo "===END==="`).join(' && ');
  
  try {
    const proc = await sandbox.startProcess(catCmd);
    await waitForProcess(proc, 30000);
    const output = proc.getLogs ? (await proc.getLogs()).stdout || '' : '';
    
    // Parse the output and cache each file
    const fileRegex = /===FILE:(.+?)===\n([\s\S]*?)===END===/g;
    let match;
    let cached = 0;
    
    while ((match = fileRegex.exec(output)) !== null) {
      const [, filePath, content] = match;
      const fileInfo = textFiles.find(f => f.path === filePath);
      
      if (fileInfo) {
        await writeFileToR2(bucket, userId, filePath, content, fileInfo.size, fileInfo.modified);
        cached++;
      }
    }
    
    console.log(`[files] Pre-cached ${cached}/${textFiles.length} files`);
  } catch (err) {
    console.warn('[files] Pre-fetch failed:', err);
  }
}

/**
 * Validate that a path is within the workspace and safe to access
 */
function validateFilePath(path: string): { valid: boolean; normalized: string; error?: string } {
  // Normalize path - remove duplicate slashes, trailing slash
  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
  
  // Must be within workspace root
  if (!normalized.startsWith(WORKSPACE_ROOT)) {
    return { valid: false, normalized, error: 'Path must be within workspace' };
  }
  
  // No path traversal
  if (normalized.includes('..')) {
    return { valid: false, normalized, error: 'Path traversal not allowed' };
  }
  
  // No access to Clawdbot internals
  if (normalized.startsWith('/root/.clawdbot')) {
    return { valid: false, normalized, error: 'Cannot access Clawdbot internals' };
  }
  
  return { valid: true, normalized };
}

/**
 * GET /api/files/list - List directory contents
 * 
 * Fast path: Check R2 cache first (30s TTL)
 * Slow path: Read from container, cache in R2
 */
api.get('/files/list', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const bucket = c.env.MOLTBOT_BUCKET;
  const path = c.req.query('path') || WORKSPACE_ROOT;
  const skipCache = c.req.query('fresh') === 'true';
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  const parent = normalized === WORKSPACE_ROOT ? null : normalized.substring(0, normalized.lastIndexOf('/')) || '/';
  
  // === FAST PATH: Check R2 cache ===
  if (!skipCache && userId) {
    const cached = await readDirFromR2(bucket, userId, normalized);
    if (cached) {
      return c.json({
        path: normalized,
        files: cached.files,
        parent: cached.parent,
        source: 'r2',
      });
    }
  }
  
  // === SLOW PATH: Read from container ===
  try {
    // Use find command to get file info: type|size|mtime|name
    const cmd = `find "${normalized}" -maxdepth 1 -printf "%y|%s|%T@|%f\\n" 2>/dev/null | tail -n +2 | head -500`;
    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, 15000);
    const logs = await proc.getLogs();
    
    const files: FileListItem[] = (logs.stdout?.split('\n').filter(Boolean) || []).map(line => {
      const [type, size, mtime, name] = line.split('|');
      const filePath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
      return {
        name,
        path: filePath,
        type: (type === 'd' ? 'directory' : 'file') as 'file' | 'directory',
        size: parseInt(size) || 0,
        modified: new Date(parseFloat(mtime) * 1000).toISOString(),
        extension: type !== 'd' ? (name.split('.').pop() || '') : undefined,
      };
    });
    
    // Sort: directories first, then alphabetically
    files.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    
    // Cache in R2 + pre-fetch small text files (don't await)
    if (userId) {
      c.executionCtx.waitUntil(
        Promise.all([
          writeDirToR2(bucket, userId, normalized, files, parent),
          preFetchSmallFiles(sandbox, bucket, userId, files),
        ])
      );
    }
    
    return c.json({ 
      path: normalized, 
      files,
      parent,
      source: 'container',
    });
  } catch (err) {
    console.error('File list error:', err);
    return c.json({ error: 'Failed to list directory' }, 500);
  }
});

/**
 * GET /api/files/read - Read file contents
 * 
 * R2-FIRST ARCHITECTURE:
 * - Primary: Read from R2 (instant, ~50ms)
 * - Fallback: Read from container (only if R2 miss, then cache)
 * 
 * R2 is the source of truth. Container syncs to R2 every 30s.
 */
api.get('/files/read', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const path = c.req.query('path');
  const encoding = c.req.query('encoding') || 'utf-8';
  const forceContainer = c.req.query('fresh') === 'true';
  
  if (!path) return c.json({ error: 'Path required' }, 400);
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  const bucket = c.env.MOLTBOT_BUCKET;
  
  // === PRIMARY: Read from R2 (source of truth) ===
  if (!forceContainer && userId && encoding !== 'base64') {
    const r2File = await readFileFromR2(bucket, userId, normalized, false);  // false = don't check TTL
    if (r2File) {
      return c.json({
        path: normalized,
        content: r2File.content,
        size: r2File.size,
        modified: r2File.modified,
        encoding,
        source: 'r2',
      });
    }
    console.log(`[files] R2 miss for ${normalized}, falling back to container`);
  }
  
  // === SLOW PATH: Read from container ===
  try {
    // Combine stat + cat into single command for speed
    const cmd = encoding === 'base64'
      ? `stat -c "%s|%Y" "${normalized}" 2>/dev/null && base64 "${normalized}"`
      : `stat -c "%s|%Y" "${normalized}" 2>/dev/null && cat "${normalized}"`;
    
    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, 30000);
    const logs = await proc.getLogs();
    const output = logs.stdout || '';
    
    // First line is stat output, rest is file content
    const firstNewline = output.indexOf('\n');
    if (firstNewline === -1 || output.startsWith('NOT_FOUND')) {
      return c.json({ error: 'File not found' }, 404);
    }
    
    const statLine = output.substring(0, firstNewline);
    const content = output.substring(firstNewline + 1);
    
    const [sizeStr, mtimeStr] = statLine.split('|');
    const size = parseInt(sizeStr) || 0;
    const modified = new Date(parseInt(mtimeStr) * 1000).toISOString();
    
    if (size > MAX_FILE_SIZE) {
      return c.json({ 
        error: 'File too large', 
        size, 
        maxSize: MAX_FILE_SIZE,
        hint: 'Use download endpoint for large files'
      }, 413);
    }
    
    // Cache in R2 for next time (don't await - fire and forget)
    if (userId && encoding !== 'base64') {
      c.executionCtx.waitUntil(
        writeFileToR2(bucket, userId, normalized, content, size, modified)
      );
    }
    
    return c.json({
      path: normalized,
      content,
      size,
      modified,
      encoding,
      source: 'container',
    });
  } catch (err) {
    console.error('File read error:', err);
    return c.json({ error: 'Failed to read file' }, 500);
  }
});

/**
 * POST /api/files/write - Write file contents
 * 
 * R2-FIRST ARCHITECTURE:
 * - Primary: Write to R2 immediately (fast response)
 * - Background: Sync to container (for AI to read)
 * 
 * Container will pick up changes within seconds via background sync.
 */
api.post('/files/write', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const bucket = c.env.MOLTBOT_BUCKET;
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  
  const { path, content, encoding = 'utf-8', createDirs = true } = body;
  
  if (!path || content === undefined) {
    return c.json({ error: 'Path and content required' }, 400);
  }
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  // Check content size
  const contentSize = encoding === 'base64' 
    ? Math.ceil(content.length * 0.75)  // Approximate decoded size
    : Buffer.from(content).length;
  
  if (contentSize > MAX_FILE_SIZE) {
    return c.json({ 
      error: 'Content too large', 
      size: contentSize, 
      maxSize: MAX_FILE_SIZE 
    }, 413);
  }
  
  const modified = new Date().toISOString();
  
  // === PRIMARY: Write to R2 first (instant) ===
  if (userId && encoding !== 'base64') {
    const success = await writeFileToR2(bucket, userId, normalized, content, contentSize, modified);
    if (!success) {
      return c.json({ error: 'Failed to write to storage' }, 500);
    }
    
    // Invalidate directory cache
    c.executionCtx.waitUntil(invalidateDirCache(bucket, userId, normalized));
    
    // Sync to container in background (for AI to read)
    c.executionCtx.waitUntil((async () => {
      try {
        if (createDirs) {
          const dir = normalized.substring(0, normalized.lastIndexOf('/'));
          if (dir) {
            const mkdirProc = await sandbox.startProcess(`mkdir -p "${dir}"`);
            await waitForProcess(mkdirProc, 5000);
          }
        }
        const escapedContent = content.replace(/'/g, "'\"'\"'");
        const proc = await sandbox.startProcess(`printf '%s' '${escapedContent}' > "${normalized}"`);
        await waitForProcess(proc, 30000);
        console.log(`[files] Synced to container: ${normalized}`);
      } catch (err) {
        console.warn(`[files] Failed to sync to container: ${normalized}`, err);
      }
    })());
    
    return c.json({
      success: true,
      path: normalized,
      size: contentSize,
      modified,
      source: 'r2',
    });
  }
  
  // === FALLBACK: Write to container directly (for binary files or no userId) ===
  try {
    if (createDirs) {
      const dir = normalized.substring(0, normalized.lastIndexOf('/'));
      if (dir) {
        const mkdirProc = await sandbox.startProcess(`mkdir -p "${dir}"`);
        await waitForProcess(mkdirProc, 5000);
      }
    }
    
    if (encoding === 'base64') {
      const proc = await sandbox.startProcess(`echo "${content}" | base64 -d > "${normalized}"`);
      await waitForProcess(proc, 30000);
    } else {
      const escapedContent = content.replace(/'/g, "'\"'\"'");
      const proc = await sandbox.startProcess(`printf '%s' '${escapedContent}' > "${normalized}"`);
      await waitForProcess(proc, 30000);
    }
    
    const statProc = await sandbox.startProcess(`stat -c "%s|%Y" "${normalized}"`);
    await waitForProcess(statProc, 5000);
    const statLogs = await statProc.getLogs();
    const [sizeStr, mtimeStr] = (statLogs.stdout?.trim() || '0|0').split('|');
    const size = parseInt(sizeStr);
    const modifiedFromStat = new Date(parseInt(mtimeStr) * 1000).toISOString();
    
    return c.json({
      success: true,
      path: normalized,
      size,
      modified: modifiedFromStat,
      source: 'container',
    });
  } catch (err) {
    console.error('File write error:', err);
    return c.json({ error: 'Failed to write file' }, 500);
  }
});

/**
 * POST /api/files/upload - Upload file (multipart form data)
 */
api.post('/files/upload', async (c) => {
  const sandbox = c.get('sandbox');
  
  let formData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Invalid form data' }, 400);
  }
  
  const file = formData.get('file') as File | null;
  const targetPath = formData.get('path') as string | null;
  
  if (!file || !targetPath) {
    return c.json({ error: 'File and path required' }, 400);
  }
  
  const { valid, normalized, error } = validateFilePath(targetPath);
  if (!valid) return c.json({ error }, 400);
  
  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json({ 
      error: 'File too large', 
      size: file.size, 
      maxSize: MAX_UPLOAD_SIZE 
    }, 413);
  }
  
  try {
    // Create parent directory
    const dir = normalized.substring(0, normalized.lastIndexOf('/'));
    if (dir) {
      const mkdirProc = await sandbox.startProcess(`mkdir -p "${dir}"`);
      await waitForProcess(mkdirProc, 5000);
    }
    
    // Read file as base64 and write via decode
    const bytes = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    
    // For large files, write in chunks to avoid command line limits
    const CHUNK_SIZE = 50000; // ~50KB chunks
    if (base64.length > CHUNK_SIZE) {
      // Write chunks to temp file, then decode
      const tempFile = `/tmp/upload_${Date.now()}`;
      for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
        const chunk = base64.slice(i, i + CHUNK_SIZE);
        const op = i === 0 ? '>' : '>>';
        const chunkProc = await sandbox.startProcess(`printf '%s' '${chunk}' ${op} "${tempFile}"`);
        await waitForProcess(chunkProc, 10000);
      }
      // Decode temp file to final destination
      const decodeProc = await sandbox.startProcess(`base64 -d "${tempFile}" > "${normalized}" && rm "${tempFile}"`);
      await waitForProcess(decodeProc, 60000);
    } else {
      // Small file - single command
      const proc = await sandbox.startProcess(`printf '%s' '${base64}' | base64 -d > "${normalized}"`);
      await waitForProcess(proc, 60000);
    }
    
    return c.json({
      success: true,
      path: normalized,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    });
  } catch (err) {
    console.error('File upload error:', err);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

/**
 * GET /api/files/download - Download file as binary
 */
api.get('/files/download', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path');
  
  if (!path) return c.json({ error: 'Path required' }, 400);
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  try {
    // Check file exists
    const checkProc = await sandbox.startProcess(`test -f "${normalized}" && echo "EXISTS" || echo "NOT_FOUND"`);
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    
    if (checkLogs.stdout?.trim() !== 'EXISTS') {
      return c.json({ error: 'File not found' }, 404);
    }
    
    // Read file as base64
    const proc = await sandbox.startProcess(`base64 "${normalized}"`);
    await waitForProcess(proc, 120000); // 2 min timeout for large files
    const logs = await proc.getLogs();
    
    const base64Content = logs.stdout?.replace(/\s/g, '') || '';
    const binaryString = atob(base64Content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const filename = normalized.split('/').pop() || 'download';
    
    // Guess content type from extension
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const contentTypes: Record<string, string> = {
      'pdf': 'application/pdf',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'json': 'application/json',
      'md': 'text/markdown',
      'txt': 'text/plain',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'text/javascript',
      'ts': 'text/typescript',
      'py': 'text/x-python',
      'csv': 'text/csv',
      'xml': 'application/xml',
      'zip': 'application/zip',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    return new Response(bytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': bytes.length.toString(),
      },
    });
  } catch (err) {
    console.error('File download error:', err);
    return c.json({ error: 'Download failed' }, 500);
  }
});

/**
 * DELETE /api/files - Delete file (move to trash)
 * 
 * Also removes file from R2 cache
 */
api.delete('/files', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const bucket = c.env.MOLTBOT_BUCKET;
  const path = c.req.query('path');
  const permanent = c.req.query('permanent') === 'true';
  
  if (!path) return c.json({ error: 'Path required' }, 400);
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  // Don't allow deleting workspace root or critical files
  const protectedPaths = [WORKSPACE_ROOT, `${WORKSPACE_ROOT}/SOUL.md`, `${WORKSPACE_ROOT}/AGENTS.md`];
  if (protectedPaths.includes(normalized)) {
    return c.json({ error: 'Cannot delete protected path' }, 403);
  }
  
  try {
    // Check if path exists
    const checkProc = await sandbox.startProcess(`test -e "${normalized}" && echo "EXISTS" || echo "NOT_FOUND"`);
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    
    if (checkLogs.stdout?.trim() !== 'EXISTS') {
      return c.json({ error: 'Path not found' }, 404);
    }
    
    // Clear from R2 cache + invalidate directory cache (don't await)
    if (userId) {
      c.executionCtx.waitUntil(
        Promise.all([
          deleteFileFromR2(bucket, userId, normalized),
          invalidateDirCache(bucket, userId, normalized),
        ])
      );
    }
    
    if (permanent) {
      // Permanent delete
      const proc = await sandbox.startProcess(`rm -rf "${normalized}"`);
      await waitForProcess(proc, 10000);
      
      return c.json({ success: true, path: normalized, permanent: true });
    } else {
      // Move to trash
      const trashDir = `${WORKSPACE_ROOT}/.trash`;
      const timestamp = Date.now();
      const filename = normalized.split('/').pop();
      const trashPath = `${trashDir}/${filename}.${timestamp}`;
      
      const mkdirProc = await sandbox.startProcess(`mkdir -p "${trashDir}"`);
      await waitForProcess(mkdirProc, 5000);
      
      const mvProc = await sandbox.startProcess(`mv "${normalized}" "${trashPath}"`);
      await waitForProcess(mvProc, 10000);
      
      return c.json({
        success: true,
        path: normalized,
        trashPath,
        trashedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  } catch (err) {
    console.error('File delete error:', err);
    return c.json({ error: 'Delete failed' }, 500);
  }
});

/**
 * POST /api/files/mkdir - Create directory
 */
api.post('/files/mkdir', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const bucket = c.env.MOLTBOT_BUCKET;
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  
  const { path } = body;
  
  if (!path) return c.json({ error: 'Path required' }, 400);
  
  const { valid, normalized, error } = validateFilePath(path);
  if (!valid) return c.json({ error }, 400);
  
  try {
    const proc = await sandbox.startProcess(`mkdir -p "${normalized}"`);
    await waitForProcess(proc, 10000);
    
    // Invalidate parent directory cache
    if (userId) {
      c.executionCtx.waitUntil(invalidateDirCache(bucket, userId, normalized));
    }
    
    return c.json({ success: true, path: normalized });
  } catch (err) {
    console.error('Mkdir error:', err);
    return c.json({ error: 'Failed to create directory' }, 500);
  }
});

/**
 * POST /api/files/move - Move/rename file or directory
 */
api.post('/files/move', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('userId') as string | undefined;
  const bucket = c.env.MOLTBOT_BUCKET;
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  
  const { from, to } = body;
  
  if (!from || !to) return c.json({ error: 'From and to paths required' }, 400);
  
  const fromValidation = validateFilePath(from);
  if (!fromValidation.valid) return c.json({ error: fromValidation.error }, 400);
  
  const toValidation = validateFilePath(to);
  if (!toValidation.valid) return c.json({ error: toValidation.error }, 400);
  
  try {
    // Check source exists
    const checkProc = await sandbox.startProcess(`test -e "${fromValidation.normalized}" && echo "EXISTS" || echo "NOT_FOUND"`);
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    
    if (checkLogs.stdout?.trim() !== 'EXISTS') {
      return c.json({ error: 'Source path not found' }, 404);
    }
    
    // Create parent directory for destination if needed
    const toDir = toValidation.normalized.substring(0, toValidation.normalized.lastIndexOf('/'));
    if (toDir) {
      const mkdirProc = await sandbox.startProcess(`mkdir -p "${toDir}"`);
      await waitForProcess(mkdirProc, 5000);
    }
    
    // Move file
    const mvProc = await sandbox.startProcess(`mv "${fromValidation.normalized}" "${toValidation.normalized}"`);
    await waitForProcess(mvProc, 10000);
    
    // Invalidate caches for both source and destination directories
    if (userId) {
      c.executionCtx.waitUntil(
        Promise.all([
          deleteFileFromR2(bucket, userId, fromValidation.normalized),
          invalidateDirCache(bucket, userId, fromValidation.normalized),
          invalidateDirCache(bucket, userId, toValidation.normalized),
        ])
      );
    }
    
    return c.json({
      success: true,
      from: fromValidation.normalized,
      to: toValidation.normalized,
    });
  } catch (err) {
    console.error('File move error:', err);
    return c.json({ error: 'Move failed' }, 500);
  }
});

export { api };
