#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# OPTIMIZED FOR FAST STARTUP
#
# Strategy: Start gateway ASAP, restore R2 in background
# This script:
# 1. Quick setup: create minimal config from template
# 2. Update config from env vars
# 3. Start gateway (accepts connections immediately)
# 4. Background: restore workspace from R2, start sync

set -e

STARTUP_START=$(date +%s%3N)
log_time() {
    local now=$(date +%s%3N)
    local elapsed=$((now - STARTUP_START))
    echo "[${elapsed}ms] $1"
}

# Check if clawdbot gateway is already running - bail early if so
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    log_time "Gateway already running, exiting."
    exit 0
fi

# Paths
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
TEMPLATE_DIR="/root/.clawdbot-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
WORKSPACE_DIR="/root/clawd"

# Per-user R2 path
if [ -n "$MOLTBOT_USER_ID" ]; then
    BACKUP_DIR="/data/moltbot/users/$MOLTBOT_USER_ID"
else
    BACKUP_DIR="/data/moltbot"
fi

log_time "User: ${MOLTBOT_USER_ID:-shared}, Backup: $BACKUP_DIR"

# Create directories
mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR"

# ============================================================
# FAST PATH: If config exists, skip to config update
# (Warm container - local files are still there)
# ============================================================
if [ -f "$CONFIG_FILE" ] && [ -f "$WORKSPACE_DIR/AGENTS.md" ]; then
    log_time "Warm container detected, skipping R2 restore"
else
    # ============================================================
    # COLD PATH: Quick R2 restore (no timestamp comparison)
    # ============================================================
    log_time "Cold start, restoring from R2..."
    
    # Try new structure first (config/ and workspace/)
    if [ -f "$BACKUP_DIR/config/clawdbot.json" ]; then
        log_time "Restoring config from R2..."
        cp -a "$BACKUP_DIR/config/." "$CONFIG_DIR/" 2>/dev/null || true
        if [ -d "$BACKUP_DIR/workspace" ]; then
            log_time "Restoring workspace from R2..."
            cp -a "$BACKUP_DIR/workspace/." "$WORKSPACE_DIR/" 2>/dev/null || true
        fi
    # Legacy: clawdbot/ subdirectory
    elif [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
        log_time "Restoring from legacy R2 backup..."
        cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/" 2>/dev/null || true
    # Legacy: flat structure  
    elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
        log_time "Restoring from legacy flat R2 backup..."
        cp -a "$BACKUP_DIR/." "$CONFIG_DIR/" 2>/dev/null || true
    else
        log_time "No R2 backup found, starting fresh"
    fi
    
    # Restore skills from legacy location if needed
    if [ ! -d "$WORKSPACE_DIR/skills" ] && [ -d "$BACKUP_DIR/skills" ]; then
        cp -a "$BACKUP_DIR/skills" "$WORKSPACE_DIR/" 2>/dev/null || true
    fi
fi

# ============================================================
# CREATE CONFIG FROM TEMPLATE IF NEEDED
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    log_time "Creating config from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
node << EOFNODE
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Clean up any broken anthropic provider config from previous runs
// (older versions didn't include required 'name' field)
if (config.models?.providers?.anthropic?.models) {
    const hasInvalidModels = config.models.providers.anthropic.models.some(m => !m.name);
    if (hasInvalidModels) {
        console.log('Removing broken anthropic provider config (missing model names)');
        delete config.models.providers.anthropic;
    }
}



// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
}

// Allow insecure auth - ALWAYS enabled for Automna MVP
// This allows webchat connections without device pairing
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowInsecureAuth = true;

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    config.channels.telegram.dm = config.channels.telegram.dm || {};
    config.channels.telegram.dm.policy = process.env.TELEGRAM_DM_POLICY || 'pairing';
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    config.channels.discord.dm = config.channels.discord.dm || {};
    config.channels.discord.dm.policy = process.env.DISCORD_DM_POLICY || 'pairing';
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
const baseUrl = process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '';
const isOpenAI = baseUrl.endsWith('/openai');

if (isOpenAI) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    console.log('Configuring OpenAI provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.openai = {
        baseUrl: baseUrl,
        api: 'openai-responses',
        models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ]
    };
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
    config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
    config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
    config.agents.defaults.model.primary = 'openai/gpt-5.2';
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Config:', JSON.stringify(config, null, 2));
EOFNODE

# ============================================================
# BOOTSTRAP WORKSPACE (FAST - minimal files only)
# Full clawdbot setup runs in background after gateway starts
# ============================================================
if [ ! -f "$WORKSPACE_DIR/AGENTS.md" ]; then
    log_time "Creating minimal workspace files..."
    mkdir -p "$WORKSPACE_DIR/memory"
    cat > "$WORKSPACE_DIR/AGENTS.md" << 'EOFAGENTS'
# Agent Instructions

You are a personal AI assistant. Help your user with whatever they need.

## Memory
- Write important facts to USER.md
- Use memory/YYYY-MM-DD.md for daily notes
- If someone says "remember this", write it to a file
EOFAGENTS
    cat > "$WORKSPACE_DIR/USER.md" << 'EOFUSER'
# About Your User

*Update this file when you learn things about your user.*

- **Name:** (not yet known)
- **Timezone:** (not yet known)
EOFUSER
    NEEDS_FULL_SETUP=true
else
    log_time "Workspace exists"
    NEEDS_FULL_SETUP=false
fi

# ============================================================
# START BACKGROUND TASKS
# ============================================================
# These run AFTER gateway starts (non-blocking)

start_background_tasks() {
    # Run full clawdbot setup if needed (adds SOUL.md, better AGENTS.md, etc.)
    if [ "$NEEDS_FULL_SETUP" = "true" ]; then
        log_time "[bg] Running full clawdbot setup..."
        clawdbot setup --workspace "$WORKSPACE_DIR" --non-interactive 2>/dev/null || true
        log_time "[bg] Full setup complete"
    fi
    
    # Start periodic R2 sync
    if [ -d "$BACKUP_DIR" ]; then
        log_time "[bg] Starting R2 sync loop..."
        while true; do
            rsync -a --delete "$WORKSPACE_DIR/" "$BACKUP_DIR/workspace/" 2>/dev/null || true
            rsync -a --delete "$CONFIG_DIR/" "$BACKUP_DIR/config/" 2>/dev/null || true
            date -Iseconds > "$BACKUP_DIR/.last-sync" 2>/dev/null || true
            sleep 30
        done
    fi
}

# Launch background tasks (runs after gateway starts)
start_background_tasks &
BACKGROUND_PID=$!
log_time "Background tasks started (PID: $BACKGROUND_PID)"

# ============================================================
# START GATEWAY
# ============================================================
log_time "Starting gateway..."

# Clean up stale lock files
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"

if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    log_time "Gateway starting with token auth"
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    log_time "Gateway starting with device pairing"
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
# Fast startup optimization: 2026-02-02
