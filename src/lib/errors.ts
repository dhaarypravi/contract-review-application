/** Errors whose message is safe to show to the user. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super(401, "unauthenticated", "Please sign in.");
  }
}

/** Used for a missing contract and for someone else's; the two look the same. */
export class NotFoundError extends AppError {
  constructor() {
    super(404, "not_found", "Contract not found.");
  }
}

export class ValidationError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(status, code, message);
  }
}
