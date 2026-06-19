export const insufficientFunds = {
  code: 100,
  message: 'Player has not enough funds to process an action'
} as const;

export class DomainError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly payload: { code: number; message: string }
  ) {
    super(payload.message);
  }
}

export function insufficientFundsError(): DomainError {
  return new DomainError(422, insufficientFunds);
}
