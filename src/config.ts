/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/** Mount path for R2 persistent storage inside the container */
export const R2_MOUNT_PATH = '/data/moltbot';

/** R2 bucket name for persistent storage */
export const R2_BUCKET_NAME = 'moltbot-data';

/**
 * Get the R2 storage path for a user.
 * For multi-user isolation, each user's data is stored under /users/{userId}/
 * 
 * @param userId - The Clerk user ID (e.g., 'user_abc123')
 * @returns The R2 path prefix for this user's data
 */
export function getUserR2Path(userId?: string): string {
  if (userId) {
    return `${R2_MOUNT_PATH}/users/${userId}`;
  }
  // Fallback for admin/legacy - uses root path
  return R2_MOUNT_PATH;
}
