export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

export class RuntimeActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeActionError";
  }
}

export class ProfileNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileNotImplementedError";
  }
}

export class BudgetExceeded extends Error {
  readonly acceptanceId: string;
  readonly budget: number;
  readonly used: number;

  constructor(message: string, acceptanceId: string, budget: number, used: number) {
    super(message);
    this.name = "BudgetExceeded";
    this.acceptanceId = acceptanceId;
    this.budget = budget;
    this.used = used;
  }
}
