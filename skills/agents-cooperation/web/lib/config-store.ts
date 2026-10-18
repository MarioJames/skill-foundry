import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath, DEFAULT_CONFIG, EFFORTS, CLASS_TAGS, CLASSES, loadSchema, validateConfig } from "../../scripts/agents-config.ts";
import { HttpError } from "./errors.ts";

export const SCHEMA_PATH = resolve(import.meta.dir, "../../assets/config.schema.json");
const schema = loadSchema(SCHEMA_PATH);
const revision = (bytes: Uint8Array) => `"sha256-${createHash("sha256").update(bytes).digest("hex")}"`;
export const validRevision = (value: string | null): value is string => !!value && /^"(?:missing|sha256-[a-f0-9]{64})"$/.test(value);
export const checkConfig = (value: unknown) => validateConfig(value, schema);

export class ConfigStore {
  readonly target: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(flag?: string, readonly env: Record<string, string | undefined> = process.env) {
    this.target = resolve(flag ?? env.AGENTS_COOPERATION_CONFIG ?? join(env.HOME ?? homedir(), ".config/agents-cooperation/config.json"));
    let physicalTarget = this.target;
    try { physicalTarget = realpathSync(this.target); } catch { /* Missing user targets are supported. */ }
    if (physicalTarget === realpathSync(DEFAULT_CONFIG)) throw new HttpError(400, "默认配置资产不能作为保存目标，请指定用户配置路径。");
  }
  private async raw() {
    try { return await readFile(this.target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new HttpError(500, "无法读取配置文件，请检查文件权限。"); }
  }
  private snapshot(bytes: Buffer | null, config: unknown, source: string) {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new HttpError(500, "配置文件必须是 JSON 对象。");
    return { config: { ...config, $schema: SCHEMA_PATH }, revision: bytes === null ? '"missing"' : revision(bytes), source, target: this.target, exists: bytes !== null,
      metadata: { schema, efforts: EFFORTS, classTags: CLASS_TAGS, classes: CLASSES } };
  }
  async read() {
    const bytes = await this.raw();
    let config: unknown;
    try { config = JSON.parse((bytes ?? await readFile(DEFAULT_CONFIG)).toString("utf8")); }
    catch { throw new HttpError(500, "配置文件 JSON 无法解析；未回退或覆盖现有文件。"); }
    // Reuse the CLI source semantics only after a successful target read. Missing
    // targets intentionally have a separate save path and missing revision.
    return this.snapshot(bytes, config, bytes === null ? DEFAULT_CONFIG : configPath(this.target, this.env).source);
  }
  save(config: unknown, match: string | null) {
    if (!validRevision(match)) return Promise.reject(new HttpError(428, "保存需要有效的 If-Match 版本，请先加载配置。"));
    const issues = checkConfig(config);
    if (issues.length) return Promise.reject(new HttpError(422, "配置校验未通过。", issues));
    const operation = async () => {
      const current = await this.raw();
      if ((current === null ? '"missing"' : revision(current)) !== match) throw new HttpError(409, "配置已在其他位置修改，请保留草稿并明确重新加载。");
      const document = { ...(config as object), $schema: SCHEMA_PATH };
      const bytes = Buffer.from(JSON.stringify(document, null, 2) + "\n");
      const directory = dirname(this.target);
      let temporary: string | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        temporary = join(directory, `.agents-config-${randomBytes(12).toString("hex")}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        // Ordinary external edits detected here; an uncooperative editor can still
        // race this final read and rename. This is deliberately not atomic CAS.
        const latest = await this.raw();
        if ((latest === null ? '"missing"' : revision(latest)) !== match) throw new HttpError(409, "配置已在其他位置修改，请保留草稿并明确重新加载。");
        await rename(temporary, this.target);
        temporary = undefined;
        return this.snapshot(bytes, document, this.target);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(500, "保存失败，原配置未被替换；请检查磁盘和目录权限后重试。");
      } finally {
        if (temporary) {
          try { await unlink(temporary); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(500, "保存失败且临时文件未能清理，请检查目标目录权限；原配置未被替换。");
          }
        }
      }
    };
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
