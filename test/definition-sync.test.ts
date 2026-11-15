// DefinitionSync against a real scratch core: the home it installs, the
// changes it sees, the .error files it writes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Fleet, type MachineConfig } from "../src/hc/fleet";
import { remoteOf } from "../src/definition/remote";
import { DefinitionSync } from "../src/definition/sync";
import { hcProcessTransport } from "./node-transport";

const scratch = mkdtempSync(join(tmpdir(), "hm-def-"));
const env = { XDG_STATE_HOME: join(scratch, "state"), XDG_RUNTIME_DIR: join(scratch, "run"), HERDR_MOBILE_HOME: "" };
const home = join(scratch, "hmdef-config", "herdr-mobile");
const M: MachineConfig = { id: "d", name: "d", host: "hmdef", port: 22, user: "me" };

function until<T>(check: () => T | undefined | false, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const shipped = {
  "layouts/main.json": '{"root":{"type":"block","id":"r","content":{"mod":"spaces"}}}',
  "mods/spaces/main.js": "export default 1;",
  "AGENTS.md": "# guide",
};

async function sync() {
  return new DefinitionSync(core.remote);
}

async function startCore(session: string, extraEnv: Record<string, string> = {}) {
  const coreEnv = { ...env, ...extraEnv, HC_SESSION: session, XDG_CONFIG_HOME: join(scratch, `${session}-config`) };
  execFileSync("hc", ["server", "start"], { env: { ...process.env, ...coreEnv } });
  const f = new Fleet(async () => hcProcessTransport(coreEnv));
  f.setMachines([{ ...M, id: session, host: session, name: session }]);
  await until(() => f.snapshot().links[0]?.state === "connected");
  const target = await until(() => f.targets()[0]);
  return {
    remote: remoteOf(f, target),
    stop() {
      f.stop();
      try {
        execFileSync("hc", ["server", "stop"], { env: { ...process.env, ...coreEnv } });
      } catch {}
    },
  };
}

let core: Awaited<ReturnType<typeof startCore>>;

beforeAll(async () => {
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  core = await startCore("hmdef");
}, 30_000);

afterAll(() => {
  core?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("installs the shipped home and returns the definition", async () => {
  const s = await sync();
  const files = await s.start(shipped);
  expect(s.path).toBe(home);
  expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("# guide");
  expect(JSON.parse(readFileSync(join(home, "installed.json"), "utf8")).files).toHaveProperty("mods/spaces/main.js");
  expect(files).toEqual({ "layouts/main.json": shipped["layouts/main.json"], "mods/spaces/main.js": shipped["mods/spaces/main.js"] });
  expect(await s.poll()).toBeNull();
}, 30_000);

test("uses HERDR_MOBILE_HOME from the core's environment, as given", async () => {
  const custom = join(scratch, "def home $x");
  const other = await startCore("hmovr", { HERDR_MOBILE_HOME: custom });
  try {
    const s = new DefinitionSync(other.remote);
    const files = await s.start(shipped);
    expect(s.path).toBe(custom);
    expect(readFileSync(join(custom, "AGENTS.md"), "utf8")).toBe("# guide");
    expect(existsSync(join(custom, "installed.json"))).toBe(true);
    expect(files["layouts/main.json"]).toBe(shipped["layouts/main.json"]);
    expect(existsSync(join(scratch, "hmovr-config", "herdr-mobile"))).toBe(false);
  } finally {
    other.stop();
  }
}, 30_000);

test("each poll returns only what changed, paths with spaces too", async () => {
  const s = await sync();
  await s.start(shipped);
  mkdirSync(join(home, "mods", "my prs"), { recursive: true });
  writeFileSync(join(home, "mods", "my prs", "main.js"), "export default 2;");
  writeFileSync(join(home, "mods", "my prs", ".notes"), "hidden");
  writeFileSync(join(home, "settings.json"), '{"layout":"main"}');
  expect(await s.poll()).toEqual({ "mods/my prs/main.js": "export default 2;", "settings.json": '{"layout":"main"}' });
  rmSync(join(home, "settings.json"));
  expect(await s.poll()).toEqual({ "settings.json": null });
  expect(await s.poll()).toBeNull();
}, 30_000);

test("images come back as data URIs", async () => {
  const s = await sync();
  await s.start(shipped);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 255]);
  writeFileSync(join(home, "mods", "spaces", "logo.png"), png);
  const changes = await s.poll();
  expect(changes?.["mods/spaces/logo.png"]).toBe(`data:image/png;base64,${png.toString("base64")}`);
  rmSync(join(home, "mods", "spaces", "logo.png"));
}, 30_000);

test("writes and clears .error files", async () => {
  const s = await sync();
  await s.start(shipped);
  await s.writeError("mods/spaces", "mods/spaces/main.js:1: boom");
  expect(readFileSync(join(home, "mods", "spaces.error"), "utf8")).toBe("mods/spaces/main.js:1: boom\n");
  expect(await s.poll()).toBeNull();
  await s.writeError("mods/spaces", null);
  expect(existsSync(join(home, "mods", "spaces.error"))).toBe(false);
}, 30_000);

test("a shipped mod the person edited is moved aside on the next start", async () => {
  const s = await sync();
  await s.start(shipped);
  writeFileSync(join(home, "mods", "spaces", "main.js"), "export default 'mine';");
  const again = await sync();
  const files = await again.start({ ...shipped, "mods/spaces/main.js": "export default 3;" });
  expect(readFileSync(join(home, "mods", "spaces-edited", "main.js"), "utf8")).toBe("export default 'mine';");
  expect(files["mods/spaces/main.js"]).toBe("export default 3;");
  expect(files["mods/spaces-edited/main.js"]).toBe("export default 'mine';");
  renameSync(join(home, "mods", "spaces-edited"), join(scratch, "aside"));
}, 30_000);

test("files and folders linked from elsewhere (GNU Stow) count, and edits through them show", async () => {
  const s = await sync();
  await s.start(shipped);
  const dots = join(scratch, "dotfiles");
  mkdirSync(join(dots, "mods", "mine"), { recursive: true });
  writeFileSync(join(dots, "settings.json"), '{"layout":"main"}');
  writeFileSync(join(dots, "mods", "mine", "main.js"), "export default 4;");
  symlinkSync(join(dots, "settings.json"), join(home, "settings.json"));
  symlinkSync(join(dots, "mods", "mine"), join(home, "mods", "mine"));
  expect(await s.poll()).toEqual({ "settings.json": '{"layout":"main"}', "mods/mine/main.js": "export default 4;" });
  writeFileSync(join(dots, "mods", "mine", "main.js"), "export default 5;");
  expect(await s.poll()).toEqual({ "mods/mine/main.js": "export default 5;" });
  rmSync(join(home, "settings.json"));
  rmSync(join(home, "mods", "mine"));
}, 30_000);
