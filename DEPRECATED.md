# ⚠️ DEPRECATED

**This Cloudflare Worker is no longer used.**

Automna has migrated from Cloudflare Workers to **Fly.io** for the agent infrastructure.

## Why Deprecated

- Cloudflare Workers container sandboxes had limitations
- Fly.io provides better isolation and persistent volumes
- Simpler architecture with dedicated VMs per user

## Current Architecture

- **Platform:** Fly.io
- **Per-user apps:** `automna-u-{shortId}.fly.dev`
- **Image:** `ghcr.io/phioranex/openclaw-docker:latest`
- **Storage:** 1GB encrypted Fly Volumes

## See

- `/docs/FLY-MIGRATION-PLAN.md` - Migration documentation
- `/landing/src/app/api/user/provision/` - Provisioning API

---

*Deprecated: 2026-02-02*
