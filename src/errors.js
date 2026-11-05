export class ServiceError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function requireThat(condition, code, message, statusCode = 422) {
  if (!condition) throw new ServiceError(code, message, statusCode);
}
