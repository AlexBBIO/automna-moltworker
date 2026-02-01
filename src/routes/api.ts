import { Hono } from 'hono';
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

export { api };
