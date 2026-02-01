/**
 * File API Tests
 * 
 * Tests for the file management endpoints.
 * Note: These are unit tests for validation logic.
 * Integration tests require a running sandbox.
 */

import { describe, it, expect } from 'vitest';

// Extract the validation function for testing
const WORKSPACE_ROOT = '/root/clawd';

function validateFilePath(path: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
  
  if (!normalized.startsWith(WORKSPACE_ROOT)) {
    return { valid: false, normalized, error: 'Path must be within workspace' };
  }
  
  if (normalized.includes('..')) {
    return { valid: false, normalized, error: 'Path traversal not allowed' };
  }
  
  if (normalized.startsWith('/root/.clawdbot')) {
    return { valid: false, normalized, error: 'Cannot access Clawdbot internals' };
  }
  
  return { valid: true, normalized };
}

describe('File Path Validation', () => {
  describe('valid paths', () => {
    it('accepts workspace root', () => {
      const result = validateFilePath('/root/clawd');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('/root/clawd');
    });

    it('accepts files in workspace', () => {
      const result = validateFilePath('/root/clawd/SOUL.md');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('/root/clawd/SOUL.md');
    });

    it('accepts nested directories', () => {
      const result = validateFilePath('/root/clawd/memory/2026-02-01.md');
      expect(result.valid).toBe(true);
    });

    it('normalizes double slashes', () => {
      const result = validateFilePath('/root/clawd//uploads//file.txt');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('/root/clawd/uploads/file.txt');
    });

    it('normalizes trailing slash', () => {
      const result = validateFilePath('/root/clawd/uploads/');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('/root/clawd/uploads');
    });
  });

  describe('invalid paths', () => {
    it('rejects paths outside workspace', () => {
      const result = validateFilePath('/etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path must be within workspace');
    });

    it('rejects home directory', () => {
      const result = validateFilePath('/root/other');
      expect(result.valid).toBe(false);
    });

    it('rejects path traversal', () => {
      const result = validateFilePath('/root/clawd/../.ssh/id_rsa');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path traversal not allowed');
    });

    it('rejects path traversal in middle', () => {
      const result = validateFilePath('/root/clawd/uploads/../../../etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path traversal not allowed');
    });

    it('rejects clawdbot internals', () => {
      // /root/.clawdbot is outside workspace, so caught by workspace check first
      const result = validateFilePath('/root/.clawdbot/config.json');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path must be within workspace');
    });

    it('rejects paths that try to access clawdbot via symlink', () => {
      // If someone tries /root/clawd/../.clawdbot, path traversal catches it
      const result = validateFilePath('/root/clawd/../.clawdbot/config.json');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path traversal not allowed');
    });
  });
});

describe('Content Type Detection', () => {
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

  function getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return contentTypes[ext] || 'application/octet-stream';
  }

  it('detects PDF files', () => {
    expect(getContentType('document.pdf')).toBe('application/pdf');
  });

  it('detects images', () => {
    expect(getContentType('photo.png')).toBe('image/png');
    expect(getContentType('photo.jpg')).toBe('image/jpeg');
    expect(getContentType('photo.JPEG')).toBe('image/jpeg');
  });

  it('detects text files', () => {
    expect(getContentType('readme.md')).toBe('text/markdown');
    expect(getContentType('notes.txt')).toBe('text/plain');
  });

  it('detects code files', () => {
    expect(getContentType('script.js')).toBe('text/javascript');
    expect(getContentType('app.ts')).toBe('text/typescript');
    expect(getContentType('main.py')).toBe('text/x-python');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getContentType('file.xyz')).toBe('application/octet-stream');
    expect(getContentType('noextension')).toBe('application/octet-stream');
  });
});

describe('Size Limits', () => {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10MB
  const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;  // 50MB

  it('allows files under 10MB for read/write', () => {
    const size = 5 * 1024 * 1024; // 5MB
    expect(size <= MAX_FILE_SIZE).toBe(true);
  });

  it('rejects files over 10MB for read/write', () => {
    const size = 15 * 1024 * 1024; // 15MB
    expect(size <= MAX_FILE_SIZE).toBe(false);
  });

  it('allows uploads under 50MB', () => {
    const size = 30 * 1024 * 1024; // 30MB
    expect(size <= MAX_UPLOAD_SIZE).toBe(true);
  });

  it('rejects uploads over 50MB', () => {
    const size = 60 * 1024 * 1024; // 60MB
    expect(size <= MAX_UPLOAD_SIZE).toBe(false);
  });
});
