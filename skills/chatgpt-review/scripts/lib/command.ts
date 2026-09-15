export async function command(argv: string[], seconds = 25): Promise<string> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: process.env });
  const timer = setTimeout(() => p.kill(), seconds * 1000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw new Error(`${argv[0]} failed (${code}): ${(err || out).slice(0, 800)}`);
    return out;
  } finally { clearTimeout(timer); }
}
export function required(opts: Record<string, string>, key: string) {
  if (!opts[key]) throw new Error(`Missing --${key}`);
  return opts[key];
}
