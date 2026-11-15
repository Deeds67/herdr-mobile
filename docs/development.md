# Development

## Set up and check

On an Apple Silicon Mac or x86-64 Linux, enter the repo's Android shell:

```sh
nix develop
adb devices -l
```

The shell provides Node 22, pnpm, Java 17, ADB, and the Android 36 SDK/NDK.
Entering it accepts the Android SDK license. The first run downloads the toolchain.
Keep at least 20 GB free for the SDKs, Gradle caches, and native build outputs.

Mirror and control a USB-connected Android phone from the computer:

```sh
scrcpy --serial <device-serial> --window-title "Herdr phone"
```

Use the serial shown by `adb devices -l`. Mirroring does not enable live code
updates; those require a development client and Metro.

```sh
pnpm install          # also generates the terminal page and the embedded mod files
pnpm test             # against real scratch hc cores; builds the mod engine's C core with cc
pnpm typecheck
```

The tests need `hc` and `cc` on `PATH`. They run their cores in scratch
sessions with scratch state directories, so they never see your terminals.

## Layout

- `app/`: screens (Expo Router). `index.tsx` draws the definition's layout;
  `screen/[id].tsx` is a mod pushed with `screen.open`; `session/[key].tsx`,
  `settings.tsx` and `machines.tsx` are the app's own.
- `src/hc/`: the hc protocol client (`connection.ts`), the merged view of all
  machines (`fleet.ts`), and each machine's `herdr-app` document, which desktop
  shares (`herdr-doc.ts`). No React Native imports, so the tests run in Node.
- `src/definition/`: the definition. `defaults/` is the shipped home (layouts,
  mods, icons, the agents' guide and `.d.ts` files); `sync.ts` keeps the
  phone's copy in step with the definition machine; `store.ts` keeps last good
  versions and `.error` files; `controller.ts` wires them into the app.
- `src/mods/`: running mods. `runtime/` is the JavaScript each engine loads
  (`herdr-ui`, `herdr`); `copy.ts` runs one mod copy; `data.ts` and
  `../commands.ts` are what mods read and do; `engine-wasm.ts` is the engine
  built to WebAssembly, for tests and `check.mjs`.
- `src/ui/mods/`: draws layouts, mod descriptions, overlays and the app menu.
- `src/check/`: `check.mjs`, which agents run in the definition home.
- `modules/mod-engine/`: the native mod engine: QuickJS-ng (`cpp/quickjs/`)
  behind a small C layer (`cpp/mod_engine.c`), on one thread of its own. Android
  only so far. The tests build the C layer with `cc` and drive it through
  `cpp/me_cli.c`.
- `modules/hc-ssh/`: the native SSH module (Kotlin, JSch + BouncyCastle, on
  Android; Swift, SwiftNIO SSH, on iOS).
- `plugins/with-ios-scene.js`: adopts the UIScene life cycle, which iOS 27
  requires and Expo's template lacks.
- `src/terminal/`: xterm.js in a WebView, fed by hc's attach stream.
- `scripts/build-mod-files.mjs`: embeds the runtime and the shipped home (with
  `check.mjs`, bundled by esbuild) as generated TypeScript. It runs on install
  and before tests and typecheck; run it yourself while Metro runs.

## Definition home

By default, the app reads `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-mobile` on
the definition machine. Set `HERDR_MOBILE_HOME` to use another existing,
writable directory:

```sh
export HERDR_MOBILE_HOME="$HOME/other/herdr-mobile/customizations"
hc server stop
hc server start
```

Set this variable in the environment that launches `herdr-core`. A value set
only in the phone app or an `hc` client shell cannot change an already-running
core. For a service-managed core, set it in that service's environment and
restart the service. The app passes the value to a quoted remote command; paths
with spaces are supported. An invalid explicit path is an error, not a silent
fallback. If unset, the existing XDG/HOME default is unchanged.

## JavaScript and native changes

A change is native when it touches `modules/`, `plugins/`, `app.json`, or a
native dependency. Everything else (TypeScript, the mod runtime, the shipped
home, assets) is a JavaScript change.

A JavaScript change reaches a development client through Metro and reaches
installed apps as an over-the-air update. A native change needs a new
development client and a new APK. See [releasing.md](releasing.md).

QuickJS-ng is pinned to the release `@jitl/quickjs-ng-wasmfile-release-sync` is
built from (`modules/mod-engine/cpp/quickjs/VERSION`), so the phone, the tests
and `check.mjs` run the same engine. Bump both together.

To run the app on a phone, see [android-phone.md](android-phone.md).
