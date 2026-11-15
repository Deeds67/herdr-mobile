// Keeps the phone's copy of the definition in step with the definition
// machine's home (~/.config/herdr-mobile, or $XDG_CONFIG_HOME/herdr-mobile).
// herdr-core has no file events, so the caller polls: every few seconds while
// the app is in front. Each poll lists checksums and reads only what changed.
import { toBase64 } from "../hc/bytes";
import { isDefinitionPath } from "./definition";
import { planInstall, type Installed } from "./install";
import type { Remote } from "./remote";

/** path → its text, or null when it's gone. Binary files are data: URIs. */
export type Changes = Record<string, string | null>;

const HOME = 'printf %s "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-mobile"';
const BOOTSTRAP = 'if [ -f "$1" ]; then cat "$1"; elif [ -e "$1" ] || [ -L "$1" ]; then echo "cannot read bootstrap config" >&2; exit 2; else exit 1; fi';
const RESOLVE = 'case "$1" in /*) p=$1;; "~/"*) p="$HOME/${1#\\~/}";; *) echo "path must be absolute or start with ~/" >&2; exit 2;; esac; if [ ! -d "$p" ] || [ ! -w "$p" ]; then echo "configured definition path does not exist or is not writable: $1" >&2; exit 3; fi; cd "$p" && pwd -P';

// Lists the definition: what desktop's watcher would count (files.rs watched()).
// -L follows symlinks, so a home linked from dotfiles (GNU Stow) counts.
const LIST = 'cd "$1" 2>/dev/null || exit 0; find -L layouts mods settings.json -type f ! -path "*/.*" ! -name "*.error" -exec cksum {} + 2>/dev/null; true';

// Lists the whole home, for installing.
const LIST_ALL = 'cd "$1" 2>/dev/null || exit 0; find -L . -type f ! -path "*/.*" ! -name "*.error" -exec cksum {} + 2>/dev/null; true';

const BINARY = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export function parseListing(out: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+) (\d+) (.+)$/);
    if (m) sums[m[3].replace(/^\.\//, "")] = `${m[1]} ${m[2]}`;
  }
  return sums;
}

export class DefinitionSync {
  private home: string | null = null;
  private configText: string | null = null;
  private shipped: Record<string, string> = {};
  private sums: Record<string, string> = {};
  private busy = false;

  constructor(private remote: Remote) {}

  /** The home's absolute path, once started. */
  get path(): string | null {
    return this.home;
  }

  /** Finds the home, installs the shipped files, and returns every definition file. */
  async start(shipped: Record<string, string>): Promise<Changes> {
    this.shipped = shipped;
    const selection = await this.readSelection();
    await this.install(selection.home, shipped);
    this.home = selection.home;
    this.configText = selection.configText;
    this.sums = {};
    return (await this.poll()) ?? {};
  }

  /** What changed since the last poll, or null when nothing did (or a poll is running). */
  async poll(): Promise<Changes | null> {
    if (!this.home || this.busy) return null;
    this.busy = true;
    try {
      const previousHome = this.home;
      const previousConfig = this.configText;
      const previousSums = this.sums;
      let removed: string[] = [];
      let switched = false;
      try {
        const selection = await this.readSelection();
        if (selection.home !== this.home || selection.configText !== this.configText) {
          removed = Object.keys(this.sums);
          await this.install(selection.home, this.shipped);
          this.home = selection.home;
          this.configText = selection.configText;
          this.sums = {};
          switched = true;
        }
        const changes = await this.readChanges();
        const confirmed = await this.readSelection();
        if (confirmed.home !== this.home || confirmed.configText !== this.configText) {
          throw new Error("definition config changed during sync; retrying");
        }
        for (const p of removed) if (!(p in changes)) changes[p] = null;
        return Object.keys(changes).length ? changes : null;
      } catch (error) {
        if (switched) {
          this.home = previousHome;
          this.configText = previousConfig;
          this.sums = previousSums;
        }
        throw error;
      }
    } finally {
      this.busy = false;
    }
  }

  private async readSelection(): Promise<{ home: string; configText: string | null }> {
    const defaultResult = await this.remote.exec(["sh", "-c", HOME]);
    if (defaultResult.code !== 0 || !defaultResult.stdout) throw new Error(`cannot find the definition home: ${defaultResult.stderr.trim()}`);
    const defaultHome = defaultResult.stdout;
    const configPath = `${defaultHome}/config.json`;
    const config = await this.remote.exec(["sh", "-c", BOOTSTRAP, "bootstrap", configPath]);
    if (config.code === 1) return { home: defaultHome, configText: null };
    if (config.code !== 0) throw new Error(config.stderr.trim() || `cannot read ${configPath}`);

    let value: unknown;
    try {
      value = JSON.parse(config.stdout);
    } catch {
      throw new Error(`${configPath}: invalid JSON`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${configPath}: expected a JSON object`);
    if (Object.keys(value).some((key) => key !== "definition")) throw new Error(`${configPath}: unexpected config field`);
    const definition = (value as { definition?: unknown }).definition;
    if (definition === undefined) return { home: defaultHome, configText: config.stdout };
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`${configPath}: definition must be an object`);
    }
    if (Object.keys(definition).some((key) => key !== "path")) throw new Error(`${configPath}: unexpected definition field`);
    const path = (definition as { path?: unknown }).path;
    if (path === undefined) return { home: defaultHome, configText: config.stdout };
    if (typeof path !== "string" || !path.trim()) throw new Error(`${configPath}: definition.path must be a non-empty string`);
    if (!(path.startsWith("/") || path.startsWith("~/"))) {
      throw new Error(`${configPath}: definition.path must be absolute or start with ~/`);
    }
    const resolved = await this.remote.exec(["sh", "-c", RESOLVE, "resolve", path]);
    if (resolved.code !== 0 || !resolved.stdout) {
      throw new Error(resolved.stderr.trim() || `${configPath}: configured definition path is invalid`);
    }
    return { home: resolved.stdout.trimEnd(), configText: config.stdout };
  }

  private async readChanges(): Promise<Changes> {
    const home = this.home!;
    const out = await this.remote.exec(["sh", "-c", LIST, "list", home]);
    const now = parseListing(out.stdout);
    const changes: Changes = {};
    for (const p of Object.keys(this.sums)) if (!(p in now)) changes[p] = null;
    const changed = Object.keys(now).filter((p) => now[p] !== this.sums[p] && isDefinitionPath(p));
    await Promise.all(changed.map(async (p) => {
      try {
        changes[p] = await this.readFile(p);
      } catch {
        // Gone between the listing and the read, or unreadable: the next poll sees it.
        delete now[p];
      }
    }));
    this.sums = now;
    return changes;
  }

  /** A file in the home: text, or a data: URI for images. */
  async readFile(path: string): Promise<string> {
    const full = `${this.home}/${path}`;
    const ext = path.split(".").pop()!.toLowerCase();
    if (BINARY.test(path)) return `data:${MIME[ext]};base64,${toBase64(await this.remote.readBytes(full))}`;
    return this.remote.read(full);
  }

  /** The .error files there now, as error keys (mods/prs.error → "mods/prs"). */
  async listErrors(): Promise<string[]> {
    if (!this.home) return [];
    const r = await this.remote.exec(["sh", "-c", 'cd "$1" 2>/dev/null && find . -name "*.error" -type f; true', "list", this.home]);
    return r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, "").replace(/\.error$/, ""));
  }

  /** Writes a file in the home. */
  async writeFile(path: string, text: string) {
    if (!this.home) throw new Error("the definition machine is not connected");
    await this.remote.write(`${this.home}/${path}`, text);
  }

  /** Moves a file or folder in the home. */
  async move(from: string, to: string) {
    if (!this.home) throw new Error("the definition machine is not connected");
    const r = await this.remote.exec(["mv", `${this.home}/${from}`, `${this.home}/${to}`]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot move ${from}`);
  }

  /** Writes <key>.error (settings.error, layouts/main.error, mods/prs.error), or removes it. */
  async writeError(key: string, message: string | null) {
    if (!this.home) return;
    const path = `${this.home}/${key}.error`;
    if (message === null) await this.remote.exec(["rm", "-f", path]);
    else await this.remote.write(path, message.endsWith("\n") ? message : `${message}\n`);
  }

  private async install(home: string, shipped: Record<string, string>) {
    const out = await this.remote.exec(["sh", "-c", LIST_ALL, "list", home]);
    const remote = parseListing(out.stdout);
    let installed: Installed = { files: {} };
    try {
      installed = JSON.parse(await this.remote.read(`${home}/installed.json`));
    } catch {}
    const plan = planInstall(shipped, remote, installed);
    if (!plan.write.length && !plan.rescue.length && !plan.remove.length && JSON.stringify(installed) === JSON.stringify(plan.installed)) return;
    for (const [from, to] of plan.rescue) {
      const r = await this.remote.exec(["mv", `${home}/${from}`, `${home}/${to}`]);
      if (r.code !== 0) throw new Error(`cannot move ${from} aside: ${r.stderr}`);
    }
    for (const p of plan.write) await this.remote.write(`${home}/${p}`, shipped[p]);
    if (plan.remove.length) await this.remote.exec(["rm", "-f", ...plan.remove.map((p) => `${home}/${p}`)]);
    await this.remote.write(`${home}/installed.json`, JSON.stringify(plan.installed, null, 2) + "\n");
  }
}
