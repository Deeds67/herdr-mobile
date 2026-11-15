// DefinitionSync against a real scratch core: the home it installs, the
// changes it sees, the .error files it writes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { Fleet, type MachineConfig } from "../src/hc/fleet";
import { remoteOf, type Remote } from "../src/definition/remote";
import { DefinitionSync } from "../src/definition/sync";
import { hcProcessTransport } from "./node-transport";

const scratch = mkdtempSync(join(tmpdir(), "hm-def-"));
const userHome = join(scratch, "user-home");
const env = { HOME: userHome, XDG_STATE_HOME: join(scratch, "state"), XDG_RUNTIME_DIR: join(scratch, "r"), XDG_CONFIG_HOME: join(scratch, "config"), HC_SESSION: "hmdef" };
const home = join(scratch, "config", "herdr-mobile");
const M: MachineConfig = { id: "d", name: "d", host: "hmdef", port: 22, user: "me" };
let fleet: Fleet;

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
  const target = await until(() => fleet.targets()[0]);
  return new DefinitionSync(remoteOf(fleet, target));
}

beforeAll(async () => {
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  execFileSync("hc", ["server", "start"], { env: { ...process.env, ...env } });
  fleet = new Fleet(async () => hcProcessTransport(env));
  fleet.setMachines([M]);
  await until(() => fleet.snapshot().links[0]?.state === "connected");
}, 30_000);

afterEach(() => rmSync(join(home, "config.json"), { force: true, recursive: true }));

afterAll(() => {
  fleet?.stop();
  try {
    execFileSync("hc", ["server", "stop"], { env: { ...process.env, ...env } });
  } catch {}
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

test("uses a configured home with spaces and returns its files", async () => {
  const custom = join(scratch, "custom definitions");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, "settings.json"), '{"layout":"custom"}');
  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: custom } }));

  const s = await sync();
  const files = await s.start(shipped);

  expect(s.path).toBe(realpathSync(custom));
  expect(files["settings.json"]).toBe('{"layout":"custom"}');
  expect(files["layouts/main.json"]).toBe(shipped["layouts/main.json"]);
}, 30_000);

test("expands a home-relative configured path without shell evaluation", async () => {
  const custom = join(userHome, "custom definitions");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: "~/custom definitions" } }));

  const s = await sync();
  await s.start(shipped);

  expect(s.path).toBe(realpathSync(custom));
}, 30_000);

test("uses the default home when the definition path is absent", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: {} }));
  const s = await sync();
  await s.start(shipped);
  expect(s.path).toBe(home);
}, 30_000);

test("rejects invalid, relative, and missing configured homes without falling back", async () => {
  for (const [text, message] of [
    ["{", "invalid JSON"],
    [JSON.stringify({ definition: { path: "relative" } }), "absolute or start with ~/"],
    [JSON.stringify({ definition: { path: "" } }), "non-empty"],
    [JSON.stringify({ definition: { path: 42 } }), "non-empty string"],
    [JSON.stringify({ definition: [] }), "definition must be an object"],
    [JSON.stringify({ other: true }), "unexpected config field"],
    [JSON.stringify({ definition: { path: join(scratch, "missing") } }), "does not exist or is not writable"],
  ]) {
    writeFileSync(join(home, "config.json"), text);
    const s = await sync();
    await expect(s.start(shipped)).rejects.toThrow(message);
  }
}, 30_000);

test("a bad runtime config preserves the current home and recovers when fixed", async () => {
  const custom = join(scratch, "runtime home");
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: custom } }));
  const s = await sync();
  await s.start(shipped);

  writeFileSync(join(home, "config.json"), "not JSON");
  await expect(s.poll()).rejects.toThrow("invalid JSON");
  expect(s.path).toBe(realpathSync(custom));

  rmSync(join(home, "config.json"));
  const recovered = await s.poll();
  expect(s.path).toBe(home);
  expect(recovered?.["layouts/main.json"]).toBe(shipped["layouts/main.json"]);
}, 30_000);

test("treats configured paths as data, not shell code", async () => {
  const marker = join(scratch, "should-not-exist");
  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: `${join(scratch, "missing")}; touch ${marker}` } }));
  const s = await sync();
  await expect(s.start(shipped)).rejects.toThrow("does not exist or is not writable");
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("rejects an unreadable bootstrap config", async () => {
  mkdirSync(join(home, "config.json"));
  const s = await sync();
  await expect(s.start(shipped)).rejects.toThrow("cannot read bootstrap config");
}, 30_000);

test("discards a home poll if bootstrap config changes while it is in flight", async () => {
  const firstHome = join(scratch, "first candidate");
  const secondHome = join(scratch, "second candidate");
  mkdirSync(join(firstHome, "mods", "candidate-one"), { recursive: true });
  mkdirSync(join(secondHome, "mods", "candidate-two"), { recursive: true });
  writeFileSync(join(firstHome, "mods", "candidate-one", "main.js"), "export default 1;");
  writeFileSync(join(secondHome, "mods", "candidate-two", "main.js"), "export default 2;");
  const target = await until(() => fleet.targets()[0]);
  const base = remoteOf(fleet, target);
  let changeConfigDuringList = false;
  const remote: Remote = {
    ...base,
    async exec(argv) {
      const result = await base.exec(argv);
      if (changeConfigDuringList && argv.some((arg) => arg.includes("find -L layouts mods settings.json"))) {
        changeConfigDuringList = false;
        writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: secondHome } }));
      }
      return result;
    },
  };
  const s = new DefinitionSync(remote);
  await s.start(shipped);

  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: firstHome } }));
  changeConfigDuringList = true;
  await expect(s.poll()).rejects.toThrow("changed during sync");
  expect(s.path).toBe(home);

  const changes = await s.poll();
  expect(s.path).toBe(realpathSync(secondHome));
  expect(changes?.["mods/candidate-two/main.js"]).toBe("export default 2;");
  expect(changes?.["mods/candidate-one/main.js"]).toBeUndefined();
}, 30_000);

test("configuration changes switch homes and removing it returns to the default", async () => {
  const custom = join(scratch, "switched home");
  mkdirSync(join(custom, "mods", "local"), { recursive: true });
  writeFileSync(join(custom, "mods", "local", "main.js"), "export default 7;");
  const s = await sync();
  await s.start(shipped);

  writeFileSync(join(home, "config.json"), JSON.stringify({ definition: { path: custom } }));
  const selected = await s.poll();
  expect(s.path).toBe(realpathSync(custom));
  expect(selected?.["mods/local/main.js"]).toBe("export default 7;");

  rmSync(join(home, "config.json"));
  const reset = await s.poll();
  expect(s.path).toBe(home);
  expect(reset?.["mods/local/main.js"]).toBeNull();
  expect(reset?.["layouts/main.json"]).toBe(shipped["layouts/main.json"]);
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
