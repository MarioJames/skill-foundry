export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 1,
  ) {
    super(message);
  }
}

export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCli(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError("internal_error", error instanceof Error ? error.message : String(error));
    emit({ ok: false, error: { code: failure.code, message: failure.message } });
    process.exitCode = failure.status;
  }
}

export function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, string | true> {
  const values = new Set(valueFlags);
  const booleans = new Set(booleanFlags);
  const parsed = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "-h") {
      parsed.set("--help", true);
    } else if (booleans.has(flag)) {
      parsed.set(flag, true);
    } else if (values.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined) throw new CliError("missing_value", `${flag} requires a value`, 2);
      parsed.set(flag, value);
      index += 1;
    } else {
      throw new CliError("unknown_option", `Unknown option: ${flag}`, 2);
    }
  }
  return parsed;
}
