import { describe, expect, it } from 'vitest';
import { signBody, verifyAuthorizationHeader } from '../src/auth/hmac.js';

describe('HMAC auth', () => {
  it('matches the copyable HMAC example from the spec', () => {
    const raw = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}';
    expect(signBody(raw, 'test')).toBe('442c4cd8926008096225416b21f5a1862fbf4fc4e5224362e3b463e85a39f40a');
  });

  it('verifies signatures in constant-time compatible buffers', () => {
    const raw = Buffer.from('{"hello":"world"}');
    const signature = signBody(raw, 'test');
    expect(verifyAuthorizationHeader(`HMAC-SHA256 ${signature}`, raw, 'test')).toBe(true);
    expect(verifyAuthorizationHeader(`HMAC-SHA256 ${signature.replace(/.$/, '0')}`, raw, 'test')).toBe(false);
  });
});
