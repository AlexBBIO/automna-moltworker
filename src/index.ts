/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware, validateSignedUrl } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2 } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';
import { createLogger } from './logging';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }
  
  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }
  
  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  if (!env.CF_ACCESS_TEAM_DOMAIN) {
    missing.push('CF_ACCESS_TEAM_DOMAIN');
  }

  if (!env.CF_ACCESS_AUD) {
    missing.push('CF_ACCESS_AUD');
  }

  // Check for AI Gateway or direct Anthropic configuration
  if (env.AI_GATEWAY_API_KEY) {
    // AI Gateway requires both API key and base URL
    if (!env.AI_GATEWAY_BASE_URL) {
      missing.push('AI_GATEWAY_BASE_URL (required when using AI_GATEWAY_API_KEY)');
    }
  } else if (!env.ANTHROPIC_API_KEY) {
    // Direct Anthropic access requires API key
    missing.push('ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY');
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 * 
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 * 
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  
  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  
  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: CORS for cross-origin requests from automna.ai
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowedOrigins = ['https://automna.ai', 'https://www.automna.ai', 'http://localhost:3000'];
  
  // Handle preflight OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? origin! : allowedOrigins[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  
  await next();
  
  // Add CORS headers to response
  if (origin && allowedOrigins.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
});

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${url.search}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
// For signed URLs (user sessions), routes to per-user sandbox
// For admin/public routes, uses 'shared' sandbox
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const url = new URL(c.req.url);
  
  // Check for signed URL params (multi-user isolation)
  const userId = url.searchParams.get('userId');
  const hasSignedParams = userId && url.searchParams.get('exp') && url.searchParams.get('sig');
  
  if (hasSignedParams && c.env.MOLTBOT_SIGNING_SECRET) {
    // Validate signed URL
    const validation = await validateSignedUrl(url, c.env.MOLTBOT_SIGNING_SECRET);
    
    if (validation.valid && validation.userId) {
      // Create per-user sandbox
      // Normalize to lowercase to avoid Cloudflare hostname issues
      const sandboxId = `user-${validation.userId}`.toLowerCase();
      console.log(`[SANDBOX] Creating per-user sandbox: ${sandboxId}`);
      const sandbox = getSandbox(c.env.Sandbox, sandboxId, { ...options, normalizeId: true });
      c.set('sandbox', sandbox);
      c.set('userId', validation.userId);
      return next();
    } else {
      // Invalid signature - reject with 401
      console.error(`[SANDBOX] Invalid signed URL: ${validation.error}`);
      return c.json({ error: 'Unauthorized', details: validation.error }, 401);
    }
  }
  
  // No signed URL params - use admin sandbox (for CF Access authenticated routes)
  const sandbox = getSandbox(c.env.Sandbox, 'shared', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// HISTORY ENDPOINT: Accepts signed URL auth (before CF Access middleware)
// =============================================================================
// This endpoint needs to be before CF Access middleware because the webchat client
// calls it with signed URL params, not CF Access JWT

import { waitForProcess } from './gateway';

app.get('/api/history', async (c) => {
  const url = new URL(c.req.url);
  
  // Add CORS headers
  c.header('Access-Control-Allow-Origin', 'https://automna.ai');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Check for signed URL params
  const userId = url.searchParams.get('userId');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  
  if (!userId || !exp || !sig) {
    return c.json({ error: 'Missing auth params (userId, exp, sig)' }, 401);
  }
  
  // Validate signature
  if (c.env.MOLTBOT_SIGNING_SECRET) {
    const validation = await validateSignedUrl(url, c.env.MOLTBOT_SIGNING_SECRET);
    if (!validation.valid) {
      return c.json({ error: 'Unauthorized', details: validation.error }, 401);
    }
  }
  
  // Get per-user sandbox
  const options = buildSandboxOptions(c.env);
  const sandboxId = `user-${userId}`.toLowerCase();
  const sandbox = getSandbox(c.env.Sandbox, sandboxId, { ...options, normalizeId: true });
  
  const sessionKey = url.searchParams.get('sessionKey') || 'main';
  
  try {
    // Ensure gateway is running
    await ensureMoltbotGateway(sandbox, c.env, userId);
    
    // Read history from JSONL file
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
          if (parsed.message && (parsed.message.role === 'user' || parsed.message.role === 'assistant')) {
            messages.push(parsed.message);
          }
        } catch {}
      }
      console.log(JSON.stringify({ sessionKey: '${sessionKey}', messages }));
    `;
    
    const proc = await sandbox.startProcess('node -e ' + JSON.stringify(script.replace(/\n/g, ' ')));
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

// Alias for webchat client compatibility
app.get('/ws/api/history', async (c) => {
  // Forward to /api/history handler by reconstructing the URL
  const url = new URL(c.req.url);
  url.pathname = '/api/history';
  const newReq = new Request(url.toString(), c.req.raw);
  return app.fetch(newReq, c.env, c.executionCtx);
});

// =============================================================================
// KEEP-ALIVE ENDPOINT: Prevents sandbox hibernation
// =============================================================================
// Dashboard pings this every 4 minutes to keep the container warm

app.get('/api/keepalive', async (c) => {
  const url = new URL(c.req.url);
  
  // Add CORS headers
  c.header('Access-Control-Allow-Origin', 'https://automna.ai');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Check for signed URL params
  const userId = url.searchParams.get('userId');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  
  if (!userId || !exp || !sig) {
    return c.json({ error: 'Missing auth params' }, 401);
  }
  
  // Validate signature
  if (c.env.MOLTBOT_SIGNING_SECRET) {
    const validation = await validateSignedUrl(url, c.env.MOLTBOT_SIGNING_SECRET);
    if (!validation.valid) {
      return c.json({ error: 'Unauthorized', details: validation.error }, 401);
    }
  }
  
  // Get sandbox and ensure gateway is running (this keeps it warm)
  const options = buildSandboxOptions(c.env);
  const sandboxId = `user-${userId}`.toLowerCase();
  const sandbox = getSandbox(c.env.Sandbox, sandboxId, { ...options, normalizeId: true });
  
  try {
    await ensureMoltbotGateway(sandbox, c.env, userId);
    return c.json({ 
      status: 'alive', 
      userId: userId,
      timestamp: Date.now() 
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', error: errorMessage }, 500);
  }
});

app.options('/api/keepalive', (c) => {
  c.header('Access-Control-Allow-Origin', 'https://automna.ai');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  return c.text('', 204);
});

// =============================================================================
// CHAT SEND ENDPOINT: HTTP fallback for when WebSocket fails
// =============================================================================

app.options('/api/chat/send', (c) => {
  c.header('Access-Control-Allow-Origin', 'https://automna.ai');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  return c.text('', 204);
});

app.post('/api/chat/send', async (c) => {
  const url = new URL(c.req.url);
  
  c.header('Access-Control-Allow-Origin', 'https://automna.ai');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Check for signed URL params
  const userId = url.searchParams.get('userId');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  
  if (!userId || !exp || !sig) {
    return c.json({ error: 'Missing auth params' }, 401);
  }
  
  // Validate signature
  if (c.env.MOLTBOT_SIGNING_SECRET) {
    const validation = await validateSignedUrl(url, c.env.MOLTBOT_SIGNING_SECRET);
    if (!validation.valid) {
      return c.json({ error: 'Unauthorized', details: validation.error }, 401);
    }
  }
  
  // Get request body
  const body = await c.req.json<{ message: string; sessionKey?: string }>();
  const message = body.message?.trim();
  const sessionKey = body.sessionKey || 'main';
  
  if (!message) {
    return c.json({ error: 'Message is required' }, 400);
  }
  
  // Get sandbox
  const options = buildSandboxOptions(c.env);
  const sandboxId = `user-${userId}`.toLowerCase();
  const sandbox = getSandbox(c.env.Sandbox, sandboxId, { ...options, normalizeId: true });
  
  try {
    await ensureMoltbotGateway(sandbox, c.env, userId);
    
    // Send message via CLI command
    const gatewayToken = c.env.MOLTBOT_GATEWAY_TOKEN || '';
    const tokenArg = gatewayToken ? `--token "${gatewayToken}"` : '';
    const escapedMessage = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    
    const cmd = `clawdbot gateway send ${tokenArg} --session "${sessionKey}" "${escapedMessage}"`;
    console.log('[chat/send] Executing:', cmd.replace(gatewayToken, '***'));
    
    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, 60000);
    
    const logs = await proc.getLogs();
    console.log('[chat/send] stdout:', logs.stdout?.slice(0, 500));
    console.log('[chat/send] stderr:', logs.stderr?.slice(0, 500));
    
    return c.json({ 
      ok: true, 
      sessionKey,
      timestamp: Date.now()
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[chat/send] Error:', errorMessage);
    return c.json({ error: errorMessage }, 500);
  }
});

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode, debug routes, and signed URL auth)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  
  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }
  
  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }
  
  // Skip validation for signed URL authenticated requests (userId was set by sandbox middleware)
  // These requests use signed URL auth instead of CF Access, so they don't need CF_ACCESS_* vars
  if (c.get('userId')) {
    return next();
  }
  
  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));
    
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }
    
    // Return JSON error for API requests
    return c.json({
      error: 'Configuration error',
      message: 'Required environment variables are not configured',
      missing: missingVars,
      hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
    }, 503);
  }
  
  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
// Skip if already authenticated via signed URL (userId is set)
app.use('*', async (c, next) => {
  // If user is already authenticated via signed URL, skip CF Access
  if (c.get('userId')) {
    console.log('[AUTH] Skipping CF Access - user authenticated via signed URL');
    return next();
  }
  
  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({ 
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml 
  });
  
  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Alias /ws/api/* to /api/* for webchat client compatibility
// The webchat client requests /ws/api/history but our endpoint is /api/history
app.route('/ws/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';
  
  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');
  
  // Get userId for per-user isolation
  const userId = c.get('userId') as string | undefined;
  
  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');
    
    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env, userId).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      })
    );
    
    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env, userId);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json({
      error: 'Moltbot gateway failed to start',
      details: errorMessage,
      hint,
    }, 503);
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    console.log('[WS] Proxying WebSocket connection to Moltbot');
    console.log('[WS] URL:', request.url);
    console.log('[WS] Search params:', url.search);
    
    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(request, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);
    
    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }
    
    console.log('[WS] Got container WebSocket, setting up interception');
    
    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());
    
    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();
    
    console.log('[WS] Both WebSockets accepted');
    console.log('[WS] containerWs.readyState:', containerWs.readyState);
    console.log('[WS] serverWs.readyState:', serverWs.readyState);
    
    // Get gateway token for auth injection
    const gatewayToken = c.env.MOLTBOT_GATEWAY_TOKEN;
    
    // Queue for messages received before container WS is ready
    const pendingMessages: (string | ArrayBuffer)[] = [];
    let containerReady = containerWs.readyState === WebSocket.OPEN;
    
    // Flush pending messages when container becomes ready
    const flushPendingMessages = () => {
      console.log('[WS] Flushing', pendingMessages.length, 'pending messages');
      while (pendingMessages.length > 0 && containerWs.readyState === WebSocket.OPEN) {
        const msg = pendingMessages.shift();
        if (msg) containerWs.send(msg);
      }
      containerReady = true;
    };
    
    // Listen for container WS open event
    containerWs.addEventListener('open', () => {
      console.log('[WS] Container WebSocket opened');
      flushPendingMessages();
    });
    
    // If already open, mark as ready
    if (containerWs.readyState === WebSocket.OPEN) {
      containerReady = true;
    }
    
    // Relay messages from client to container, injecting auth token on connect
    serverWs.addEventListener('message', (event) => {
      console.log('[WS] Client -> Container:', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)');
      
      let dataToSend = event.data;
      
      // Intercept connect message and inject gateway token
      if (typeof event.data === 'string' && gatewayToken) {
        try {
          const msg = JSON.parse(event.data);
          if (msg.method === 'connect') {
            console.log('[WS] Intercepting connect message to inject auth token');
            msg.params = msg.params || {};
            msg.params.auth = msg.params.auth || {};
            msg.params.auth.token = gatewayToken;
            dataToSend = JSON.stringify(msg);
            console.log('[WS] Injected gateway token into connect message');
          }
        } catch (e) {
          // Not JSON, send as-is
        }
      }
      
      if (containerReady && containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(dataToSend);
      } else {
        console.log('[WS] Container not ready, queueing message');
        pendingMessages.push(dataToSend);
      }
    });
    
    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      console.log('[WS] Container -> Client (raw):', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)');
      let data = event.data;
      
      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          if (parsed.error?.message) {
            console.log('[WS] Original error.message:', parsed.error.message);
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            console.log('[WS] Transformed error.message:', parsed.error.message);
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          console.log('[WS] Not JSON or parse error:', e);
        }
      }
      
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });
    
    // Handle close events
    serverWs.addEventListener('close', (event) => {
      console.log('[WS] Client closed:', event.code, event.reason);
      containerWs.close(event.code, event.reason);
    });
    
    containerWs.addEventListener('close', (event) => {
      console.log('[WS] Container closed:', event.code, event.reason);
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      console.log('[WS] Transformed close reason:', reason);
      serverWs.close(event.code, reason);
    });
    
    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });
    
    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });
    
    console.log('[WS] Returning intercepted WebSocket response');
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);
  
  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);
  
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/**
 * Scheduled handler for cron triggers.
 * Syncs admin sandbox config/state from container to R2 for persistence.
 * 
 * Note: User-specific sandbox syncs happen within user sessions, not via cron.
 * This cron job only handles the admin sandbox (for CF Access authenticated routes).
 */
async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext
): Promise<void> {
  const logger = createLogger(env, 'cron');
  
  try {
    const options = buildSandboxOptions(env);
    const sandbox = getSandbox(env.Sandbox, 'shared', options);

    logger.info('Starting admin sandbox backup sync to R2...');
    const result = await syncToR2(sandbox, env);
    
    if (result.success) {
      logger.info('Admin backup sync completed successfully', { lastSync: result.lastSync });
    } else {
      logger.error('Admin backup sync failed', { error: result.error, details: result.details });
    }
  } catch (error) {
    logger.error('Scheduled handler crashed', {}, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
// Deploy 1769723534
