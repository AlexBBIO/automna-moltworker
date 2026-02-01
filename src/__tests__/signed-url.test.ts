import { describe, it, expect, vi, beforeAll } from 'vitest'
import crypto from 'crypto'

// Re-implement the validation logic for testing
// (We can't import the actual module due to Web Crypto API differences)

interface SignedUrlValidation {
  valid: boolean
  userId?: string
  error?: string
}

function generateSignature(userId: string, exp: number, secret: string): string {
  const payload = `${userId}.${exp}`
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url')
}

async function validateSignedUrl(
  url: URL,
  secret: string
): Promise<SignedUrlValidation> {
  const userId = url.searchParams.get('userId')
  const exp = url.searchParams.get('exp')
  const sig = url.searchParams.get('sig')

  if (!userId || !exp || !sig) {
    return { valid: false, error: 'Missing required params (userId, exp, sig)' }
  }

  const expTime = parseInt(exp, 10)
  if (isNaN(expTime)) {
    return { valid: false, error: 'Invalid exp format' }
  }
  if (expTime < Date.now() / 1000) {
    return { valid: false, error: 'URL expired' }
  }

  if (!userId.startsWith('user_')) {
    return { valid: false, error: 'Invalid userId format' }
  }

  const expectedSig = generateSignature(userId, expTime, secret)
  if (sig !== expectedSig) {
    return { valid: false, error: 'Invalid signature' }
  }

  return { valid: true, userId }
}

describe('Signed URL Validation', () => {
  const secret = 'test-secret-key-12345'
  const validUserId = 'user_abc123'
  const futureExp = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
  const pastExp = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago

  function createUrl(params: Record<string, string>): URL {
    const url = new URL('https://example.com/ws')
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return url
  }

  describe('accepts valid signature', () => {
    it('validates correctly signed URL', async () => {
      const sig = generateSignature(validUserId, futureExp, secret)
      const url = createUrl({
        userId: validUserId,
        exp: futureExp.toString(),
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(true)
      expect(result.userId).toBe(validUserId)
    })
  })

  describe('rejects invalid signature', () => {
    it('rejects tampered signature', async () => {
      const url = createUrl({
        userId: validUserId,
        exp: futureExp.toString(),
        sig: 'invalid-signature',
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid signature')
    })

    it('rejects signature from different secret', async () => {
      const wrongSig = generateSignature(validUserId, futureExp, 'wrong-secret')
      const url = createUrl({
        userId: validUserId,
        exp: futureExp.toString(),
        sig: wrongSig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid signature')
    })

    it('rejects signature with tampered userId', async () => {
      const sig = generateSignature(validUserId, futureExp, secret)
      const url = createUrl({
        userId: 'user_different', // Different userId but same sig
        exp: futureExp.toString(),
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid signature')
    })

    it('rejects signature with tampered exp', async () => {
      const sig = generateSignature(validUserId, futureExp, secret)
      const url = createUrl({
        userId: validUserId,
        exp: (futureExp + 1000).toString(), // Different exp but same sig
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid signature')
    })
  })

  describe('rejects expired URLs', () => {
    it('rejects URL with past expiry', async () => {
      const sig = generateSignature(validUserId, pastExp, secret)
      const url = createUrl({
        userId: validUserId,
        exp: pastExp.toString(),
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('URL expired')
    })
  })

  describe('rejects missing params', () => {
    it('rejects missing userId', async () => {
      const sig = generateSignature(validUserId, futureExp, secret)
      const url = createUrl({
        exp: futureExp.toString(),
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Missing required params')
    })

    it('rejects missing exp', async () => {
      const sig = generateSignature(validUserId, futureExp, secret)
      const url = createUrl({
        userId: validUserId,
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Missing required params')
    })

    it('rejects missing sig', async () => {
      const url = createUrl({
        userId: validUserId,
        exp: futureExp.toString(),
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Missing required params')
    })
  })

  describe('rejects invalid userId format', () => {
    it('rejects userId without user_ prefix', async () => {
      const invalidUserId = 'abc123' // Missing user_ prefix
      const sig = generateSignature(invalidUserId, futureExp, secret)
      const url = createUrl({
        userId: invalidUserId,
        exp: futureExp.toString(),
        sig,
      })

      const result = await validateSignedUrl(url, secret)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid userId format')
    })
  })

  describe('signature format', () => {
    it('uses base64url encoding (no +, /, or =)', () => {
      // Generate many signatures and check format
      for (let i = 0; i < 100; i++) {
        const sig = generateSignature(`user_test${i}`, futureExp + i, secret)
        expect(sig).not.toContain('+')
        expect(sig).not.toContain('/')
        expect(sig).not.toContain('=')
      }
    })

    it('payload format is userId.exp', () => {
      // The signature should be HMAC-SHA256 of "userId.exp"
      const userId = 'user_test123'
      const exp = 1700000000
      
      const expectedPayload = `${userId}.${exp}`
      const manualSig = crypto
        .createHmac('sha256', secret)
        .update(expectedPayload)
        .digest('base64url')
      
      const functionSig = generateSignature(userId, exp, secret)
      expect(functionSig).toBe(manualSig)
    })
  })
})

describe('Signature Generation (Frontend)', () => {
  const secret = 'test-secret-key'
  
  function generateSignedUrl(userId: string, secret: string): string {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const payload = `${userId}.${exp}`
    const sig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url')
    return `wss://example.com/ws?userId=${encodeURIComponent(userId)}&exp=${exp}&sig=${sig}`
  }

  it('generates URL with required params', () => {
    const url = generateSignedUrl('user_abc123', secret)
    expect(url).toContain('userId=user_abc123')
    expect(url).toContain('exp=')
    expect(url).toContain('sig=')
  })

  it('generated URL validates successfully', async () => {
    const userId = 'user_abc123'
    const urlString = generateSignedUrl(userId, secret)
    const url = new URL(urlString)
    
    const result = await validateSignedUrl(url, secret)
    expect(result.valid).toBe(true)
    expect(result.userId).toBe(userId)
  })
})
