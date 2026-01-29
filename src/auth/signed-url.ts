/**
 * Signed URL validation for multi-user isolation.
 * 
 * URLs are signed by the backend with HMAC-SHA256:
 *   wss://moltbot.../ws?userId={clerkId}&exp={timestamp}&sig={signature}
 * 
 * This prevents users from tampering with their userId to access other users' sandboxes.
 */

export interface SignedUrlValidation {
  valid: boolean;
  userId?: string;
  error?: string;
}

/**
 * Validate a signed URL.
 * 
 * @param url - The request URL containing userId, exp, and sig params
 * @param secret - The shared HMAC secret (MOLTBOT_SIGNING_SECRET)
 * @returns Validation result with userId if valid
 */
export async function validateSignedUrl(
  url: URL,
  secret: string
): Promise<SignedUrlValidation> {
  const userId = url.searchParams.get('userId');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');

  // Check required params
  if (!userId || !exp || !sig) {
    return { valid: false, error: 'Missing required params (userId, exp, sig)' };
  }

  // Check expiry
  const expTime = parseInt(exp, 10);
  if (isNaN(expTime)) {
    return { valid: false, error: 'Invalid exp format' };
  }
  if (expTime < Date.now() / 1000) {
    return { valid: false, error: 'URL expired' };
  }

  // Validate userId format (Clerk IDs start with 'user_')
  if (!userId.startsWith('user_')) {
    return { valid: false, error: 'Invalid userId format' };
  }

  // Verify signature using Web Crypto API (available in Workers)
  const payload = `${userId}.${exp}`;
  
  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const payloadData = encoder.encode(payload);
    
    // Import key for HMAC
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    // Generate expected signature
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, payloadData);
    const expectedSig = bufferToBase64Url(signatureBuffer);
    
    // Timing-safe comparison
    if (!timingSafeEqual(sig, expectedSig)) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    return { valid: true, userId };
  } catch (err) {
    console.error('[SignedURL] Signature verification error:', err);
    return { valid: false, error: 'Signature verification failed' };
  }
}

/**
 * Convert ArrayBuffer to base64url string (URL-safe, no padding)
 */
function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // Convert to base64, then make URL-safe
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract userId from URL without validation (for logging/debugging only).
 * Always use validateSignedUrl() for actual authorization.
 */
export function extractUserId(url: URL): string | null {
  return url.searchParams.get('userId');
}
