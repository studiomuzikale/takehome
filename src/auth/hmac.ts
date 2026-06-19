import { createHmac, timingSafeEqual } from 'node:crypto';

const authorizationPattern = /^HMAC-SHA256 ([a-f0-9]{64})$/i;

export function signBody(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyAuthorizationHeader(
  authorization: string | undefined,
  rawBody: Buffer,
  secret: string
): boolean {
  if (!authorization) return false;

  const match = authorizationPattern.exec(authorization.trim());
  if (!match) return false;

  const expected = Buffer.from(signBody(rawBody, secret), 'hex');
  const actual = Buffer.from(match[1], 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
