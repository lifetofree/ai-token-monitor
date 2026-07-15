# Mac System Metrics: Library Choice for the Daemon

Research for GitHub issue #5 ("Choose Mac system-metrics library for the daemon"), part of the
wayfinder map in issue #4 ("Mac System Monitor on ESP32 Display").

Environment this research was verified against: macOS 26.5.2 (Darwin), Apple Silicon, Node.js
v26 docs (current at time of writing, July 2026). Commands below were run directly on a live
Apple Silicon Mac, not just read from man pages, so output samples are empirical, not
hypothetical.

## 1. Question

The Mac daemon (Node.js, launchd, logged-in user, no sudo, macOS 13+, sampling every 2s) must
produce a single JSON-serializable snapshot containing: CPU utilization %, memory used/total
(+ ideally pressure, not just raw numbers), network throughput bytes/sec up and down per active
interface, CPU die/package temperature, and battery percentage + charging state. Issue #5 asks
which of (a) the built-in `os` module, (b) the `systeminformation` npm package, (c) shelling out
to macOS CLI tools via `child_process`, or (d) some newer alternative, should be used — subject to
the project's zero-runtime-dependency policy, no native compilation, and no root.

## 2. Findings by option

### (a) Node's built-in `os` module

Primary source: [Node.js `os` module docs](https://nodejs.org/api/os.html).

- **`os.cpus()`** (added v0.3.3) — "Returns an array of objects containing information about each
  logical CPU core," each with `model`, `speed` (MHz), and `times: { user, nice, sys, idle, irq }`
  given in **cumulative milliseconds since boot**. There is no direct "% CPU used" value; a caller
  must take two snapshots and diff the counters (exactly what `systeminformation`'s
  `currentLoad()` does internally — confirmed by reading its source, see §2b). No per-package
  temperature field exists on this object at all.
- **`os.totalmem()` / `os.freemem()`** (added v0.3.3) — "Returns the total amount of system memory
  in bytes" / "Returns the amount of free system memory in bytes as an integer." These are raw
  totals only. On macOS, `freemem()` reflects only truly-free pages (equivalent to `vm_stat`'s
  "Pages free"), which is characteristically a very small, misleading number on macOS because the
  OS deliberately keeps free pages low and holds reclaimable content in the inactive/file-cache
  and compressor pools. There is no "available" or "pressure" concept anywhere in the `os` module.
- **`os.networkInterfaces()`** (added v0.6.0) — returns, per interface name, an array of assigned
  address objects with only `address`, `netmask`, `family`, `mac`, `internal`, `scopeid`, `cidr`.
  Confirmed directly from the docs' own field list and example JSON — there is no rx/tx byte
  counter field anywhere in the returned structure. This exactly matches the issue's framing: `os`
  gives interface *configuration*, not interface *traffic*.
- Battery and CPU temperature: `os` has no APIs for either at all.

**Conclusion for (a):** confirmed as described in the issue — `os` can contribute to CPU% (via
`os.cpus()` diffed) but cannot deliver memory pressure, network throughput, temperature, or
battery. No privilege requirement (all pure in-process reads), but incomplete for 3 of 5 metrics.

### (b) `systeminformation` npm package

Primary sources: [GitHub repo](https://github.com/sebhildebrandt/systeminformation) source at
`master`, specifically `lib/cpu.js`, `lib/memory.js`, `lib/network.js`, `lib/battery.js`, and
`package.json`, fetched and read directly (not blog summaries).

- **Zero native/compiled dependencies in the core package.** `package.json` for
  `systeminformation@5.31.17` has no `"dependencies"` key at all — confirmed by direct
  inspection of the fetched manifest. It is a pure-JS package for all of CPU, memory, network,
  and battery.
- **However, on macOS, its core implementation *is* a `child_process` wrapper around the exact
  same CLI tools discussed in option (c):**
  - `si.mem()` on darwin: `exec('vm_stat 2>/dev/null | egrep "Pages active|Pages inactive|Pages speculative|Pages wired down|Pages occupied by compressor|Pages purgeable|File-backed pages|Anonymous pages"', ...)` followed by `exec('sysctl -n vm.swapusage 2>/dev/null', ...)` (`lib/memory.js` lines ~261, ~275).
  - `si.networkStats()` on darwin: builds and execs `'netstat -bdnI ' + ifaceSanitized` per
    interface (`lib/network.js` line ~1449), i.e. the same `netstat -ib`-family command from
    option (c), invoked once per interface per call.
  - `si.battery()` on darwin: `exec('ioreg -n AppleSmartBattery -r | egrep "CycleCount|IsCharging|...";  pmset -g batt | grep %', ...)` (`lib/battery.js` line ~195) — same `pmset -g batt` primitive as option (c), plus a noisy `ioreg` dump for extra fields the daemon doesn't need.
  - `si.currentLoad()`: implemented in pure JS via `os.cpus()` diffed over an interval
    (`lib/cpu.js` `getLoad`/`getFullLoad`, confirmed by reading source) — no subprocess spawn.
  - **Practical implication:** for CPU/memory/network/battery, adding `systeminformation` does not
    avoid subprocess spawning at 2s cadence — it just repackages the same spawns with a parsing
    layer, plus a bit of extra overhead (its battery call also always shells to `ioreg`, which is
    unnecessary weight for a daemon that only needs percent + charging state).
- **`si.cpuTemperature()` on darwin does NOT work out of the box.** Reading `lib/cpu.js` directly:
  on the darwin branch it does `try { result = osxTemp.cpuTemperature(); } catch { util.noop(); }`
  where `osxTemp = require('osx-temperature-sensor')`, and separately
  `try { const macosTemp = require('macos-temperature-sensor'); ... } catch { util.noop(); }`.
  **Neither package is a dependency of `systeminformation`** — both are optional, must be
  manually `npm install`-ed by the consumer, and if absent, `cpuTemperature()` silently resolves
  to `{ main: null, cores: [], max: null, socket: [], chipset: null }` with no error. This
  confirms and sharpens the issue's premise: `systeminformation` alone gets **no CPU temperature
  on macOS**, contradicting a casual assumption that it "just works." Community reports (e.g. the
  long-standing [`cpuTemperature not returning anything on OSX or Windows` GitHub issue #36](https://github.com/sebhildebrandt/systeminformation/issues/36)) corroborate this.
  - `osx-temperature-sensor` (`sebhildebrandt/osx-temperature-sensor`, README fetched directly):
    "captures CPU temperature on macOS using SMC," ships a `binding.gyp` (native addon, requires
    `node-gyp`/compiler toolchain at install time), targets Intel-era SMC access, with only a
    changelog note ("v1.0.8: add Apple Silicon M1 support") for newer hardware — its own README
    does not document current reliability on Apple Silicon.
  - `macos-temperature-sensor` (`sebhildebrandt/macos-temperature-sensor`, package.json and C
    source fetched directly): explicitly Apple-Silicon-only (`"cpu": ["arm64"]`), and its
    `package.json` has `"scripts": { "install": "node-gyp rebuild", ... }` and
    `"gypfile": true` — i.e., **it requires a native compile step on install**, which directly
    conflicts with the daemon's "no native compilation" hard constraint. Its `binding.gyp` links
    `IOKit`/`CoreFoundation` frameworks. Its `lib/src/temps.c` (fetched directly) implements
    temperature reads via the private, undocumented `IOHIDEventSystemClient*` API family (see §3)
    — no root check anywhere in the C source.
- This project's `docs/new-feature.md` (line 37) currently states `systeminformation`
  is "already in package.json" — this repo's actual `package.json` has no `dependencies` block at
  all (only `vitest` as a devDependency); this is a documentation error to be aware of, not a fact
  to build on.

**Conclusion for (b):** `systeminformation` would be a real new runtime dependency (not already
present), and for 4 of 5 metrics it buys convenience/parsing only — the underlying macOS calls are
identical `child_process` invocations to option (c). For CPU temperature specifically, it buys
nothing without also manually installing one of two optional companion packages, at least one of
which requires native compilation (violates a hard constraint) and both of which rely on
undocumented private APIs.

### (c) Shelling out via `child_process`

Primary sources: Apple's own `man` pages, read directly (`man vm_stat`, `man top`, `man netstat`,
`man pmset`, `man powermetrics`, `man iostat`, `man memory_pressure`), plus live command output
captured on this machine.

- **`vm_stat`** (`man vm_stat(1)`): "displays Mach virtual memory statistics." Confirmed live
  output includes `Pages free`, `Pages active`, `Pages inactive`, `Pages speculative`,
  `Pages wired down`, `Pages purgeable`, `Pages occupied by compressor`, `Pages stored in
  compressor`, etc., with a fixed page size line (`page size of 16384 bytes` on this machine —
  note this is **not always 4096**, and any parser must read the page-size header rather than
  hardcode it). No privilege requirement; this is what `systeminformation` itself execs (see §2b).
- **`top -l 1`** (`man top(1)`): one-shot snapshot mode ("`-l samples` Use logging mode and
  display samples samples, even if standard output is a terminal"). Live output confirmed a
  `CPU usage: 22.98% user, 15.56% sys, 61.44% idle` line and a
  `PhysMem: 35G used (7279M wired, 13G compressor), 177M unused.` line directly in the global
  header — i.e., `top -l 1` gives a ready-made CPU% and a ready-made memory-used/total view
  without needing `os.cpus()` diffing at all, at the cost of spawning and parsing a full `top`
  process every sample.
- **`netstat -ib`** (`man netstat(1)`): the `-i` interface display provides "a table of cumulative
  statistics regarding packets transferred," and `-b` "show[s] the number of bytes in and out."
  Live output confirmed columns `Ibytes`/`Obytes` are **cumulative since boot**, per interface,
  with duplicate rows per address family for the same interface (must dedupe, e.g. by taking the
  `<Link#N>` row or first row per iface name). This confirms the issue's framing exactly: **byte
  counts must be diffed between two samples 2s apart** to get bytes/sec; `netstat -ib` alone does
  not give a rate. Still fully supported on current macOS (26.5.2, exercised live). Alternative
  confirmed in the man page: `netstat -I <iface> -w <wait>` runs in a continuous mode that "will
  continuously display the information regarding packet traffic" already as periodic deltas — this
  could be run as one long-lived child process instead of re-spawning `netstat` every 2s.
- **`iostat`** (`man iostat(8)`): confirmed this is **not** a network tool on macOS — it "displays
  kernel I/O statistics on terminal, device and cpu operations" (disk/CPU/tty only). The issue's
  mention of `iostat` for network throughput does not hold on macOS; `netstat -ib` (or
  `netstat -w`) is the correct primitive, not `iostat`.
- **`pmset -g batt`** (`man pmset(1)`): "-g with a 'batt' or 'ps' argument will show the state of
  all attached power sources." No root required — verified live:
  `Now drawing from 'AC Power'\n -InternalBattery-0 (id=22937699)\t80%; AC attached; not charging present: true`.
  Format is stable, well-documented informally across the ecosystem, and trivially parseable with
  a regex for the percentage and charge state keywords (`charging`/`discharging`/
  `AC attached; not charging`/`charged`). The man page separately states plainly, in the SETTING
  section, "pmset must be run as root **in order to modify any settings**" — reading (`-g`) is
  explicitly not gated by that requirement, confirmed empirically since it ran fine unprivileged.
- **`powermetrics`**: **this is the hard blocker.** Running it live as the logged-in user (no
  sudo) on this machine produced:
  ```
  $ powermetrics -n 1 -i 1000
  powermetrics must be invoked as the superuser
  ```
  and a non-interactive `sudo -n` attempt failed with `sudo: a password is required` — i.e. there
  is no passwordless path for a launchd-run, logged-in-user daemon to invoke it. The man page
  itself doesn't spell out the privilege requirement in its OPTIONS text, but the tool's own
  runtime behavior is unambiguous and directly confirms the issue's framing: **`powermetrics`
  (and therefore both the `smc` temperature sampler and the `thermal` pressure sampler it exposes)
  requires root, full stop, on this current macOS version.** This is a hard blocker for the
  "no sudo" daemon constraint as stated.
- **`pmset -g therm`** (undocumented-by-man-page but real `-g` subcommand, listed as
  "-g therm shows thermal conditions that affect CPU speed. Not available on all platforms."):
  ran without root and returned
  `Note: No thermal warning level has been recorded / Note: No performance warning level has been recorded / Note: No CPU power status has been recorded`
  on this idle machine — i.e. it is accessible without root, but it exposes a *coarse
  warning/pressure level* (akin to iOS's `ProcessInfo.thermalState`), not a raw temperature in
  Celsius, and evidently only populates once a throttling-relevant event has actually occurred.
  This is not a substitute for a numeric CPU die temperature reading.
- **Memory pressure, specifically** — this is *not* one of the CLI tools the issue named, but is
  directly relevant to the "ideally memory pressure" requirement:
  - `memory_pressure` (`man memory_pressure(1)`): documented options are all about *simulating*
    pressure (`-l level`, `-p percent_free`, `-S`, `-s`), not reading current pressure. However,
    invoking the binary with **no arguments** on this machine produced full current-state output
    (free/purgeable/purged pages, swap-ins/outs, page queue counts, compressor stats) — this is
    undocumented-by-the-man-page behavior observed empirically, not something to rely on without
    a version-pinned regression check.
  - `sysctl vm.memory_pressure` and `sysctl kern.memorystatus_level` — both readable without root,
    confirmed live (`vm.memory_pressure: 0`, `kern.memorystatus_level: 42`). These are the same
    underlying kernel counters that macOS's own low-memory notification system and (almost
    certainly) Activity Monitor's "Memory Pressure" graph are built on. **These are undocumented
    kernel `sysctl` OIDs** — there is no Apple developer documentation found for them; they are
    not part of any public API and their meaning/availability could change between macOS
    versions without notice. Treat as an empirical, unofficial signal, not a stable contract.

**Conclusion for (c):** every metric except CPU die temperature is achievable via `child_process`
with tools that are confirmed present and working, unprivileged, on current macOS. CPU
utilization, memory (raw + a pressure proxy), network (with diffing), and battery are all
realistic. CPU die/package temperature is not achievable through any CLI tool without root
(`powermetrics`), full stop — this is the one gap 100%-shared with option (b)'s built-in behavior.

### (d) Alternatives

- **`macos-temperature-sensor` / `osx-temperature-sensor`** — already covered in §2b; both are
  native addons (`node-gyp`/`binding.gyp`), disqualified by the "no native compilation" constraint
  regardless of their privilege behavior.
- **The underlying technique both of those packages (and third-party community tools) use** —
  the private, undocumented `IOHIDEventSystemClient`/`IOHIDServiceClient` API family
  (`IOHIDEventSystemClientCreate`, `IOHIDServiceClientCopyEvent` with
  `kIOHIDEventTypeTemperature`), resolved via `dlopen`/`dlsym` on
  `/System/Library/Frameworks/IOKit.framework/IOKit` — is corroborated across multiple
  independent, long-running open-source projects: `freedomtan/sensors` (technique dates to
  2016-2018, per license header found in `fermion-star/apple_sensors/temp_sensor.m`),
  `fermion-star/apple_sensors`, and `sebhildebrandt/macos-temperature-sensor`'s own C source
  (`lib/src/temps.c`, fetched directly — implements exactly this call sequence with no privilege
  check present in the code). Community write-ups (`vladkens/macmon`'s README framing "No sudo"
  for its Rust equivalent; a 2025-12 blog post on building a macOS thermal-throttling app) treat
  this as the standard non-root way modern menu-bar temperature tools (e.g. Stats.app, TG Pro-style
  utilities) get sensor data on Apple Silicon. **This is genuine evidence that non-root CPU
  temperature reading is possible on Apple Silicon** — but only via a compiled, private-API
  binary/addon; there is no way to reach it from pure JS/`child_process` against a stock macOS
  CLI tool.
- No official Apple documentation (WWDC session, developer.apple.com API reference, or IOKit
  header) describing or sanctioning this API was found. It is unambiguously a private framework
  surface (no public header declares `IOHIDEventSystemClientCreate`); Apple could change or
  restrict it without notice, and code using it would likely be rejected from the Mac App Store
  (irrelevant here since this is a personal, non-distributed launchd daemon, but worth flagging).
- One community claim surfaced during research states flatly "there is no SMC on Apple Silicon
  Macs" (in the sense of the classic Intel-era `AppleSMC.kext` key/value interface that
  `osx-cpu-temp`/`SMCKit`-style tools use) — this is **not independently verified against an
  Apple primary source** in this research pass; it is included here as an unresolved claim, not
  a fact. What is independently corroborated across multiple sources is that Apple Silicon
  temperature data is available via the different, HID-event-based path described above.

## 3. The CPU temperature problem (dedicated section)

This is very likely the deciding constraint for issue #5, so stating it plainly:

**On this current Apple Silicon Mac (macOS 26.5.2), running `powermetrics` — the only stock macOS
CLI tool that surfaces CPU die/package temperature or SMC/thermal data — as the logged-in user
without sudo fails immediately with the literal, empirically-reproduced error `"powermetrics must
be invoked as the superuser"`.** A non-interactive `sudo -n powermetrics ...` also fails
(`sudo: a password is required`), confirming there is no passwordless escalation path available to
a launchd-run, logged-in-user daemon as currently constrained. This is a hard, confirmed blocker
for getting CPU temperature through any CLI-tool/`child_process` route, and it is equally a
blocker for `systeminformation`'s temperature story insofar as that story also ultimately depends
on either SMC/`powermetrics`-adjacent access or a native addon.

Separately, **non-root CPU temperature reading is possible on Apple Silicon**, but only via a
different mechanism: the private, undocumented IOKit `IOHIDEventSystemClient` HID-event API,
which several independent open-source projects use successfully without elevated privileges. This
path requires native code (a compiled Node addon, or a separately-compiled small Objective-C/C
helper binary invoked via `child_process`) — there is no pure-JavaScript way to call a private
Mach-O framework symbol. Both ready-made Node packages that wrap this technique
(`osx-temperature-sensor`, `macos-temperature-sensor`) ship a `node-gyp`/`binding.gyp` native build
step, which conflicts with this project's "no native compilation" constraint even though neither
one requires root.

**Bottom line:** CPU temperature is obtainable without root on Apple Silicon, but not without
native compilation. Given both constraints together ("no sudo" AND "no native compile step"), CPU
temperature is **not reachable** through any path found in this research that also satisfies both
constraints simultaneously. Something has to give: either accept a native-compiled helper
(one-time build step, e.g. run once at `npm install`/setup rather than every sample), accept a
sudo/launchd-with-elevated-privileges tradeoff for the daemon (conflicts with "no sudo" as
currently stated), or ship the metric as `null`/"unavailable" and surface that state on the
ESP32/web UI. This research did not find a fourth option.

## 4. Recommendation

**Bottom line: stay dependency-free. Use `child_process` calls to `top -l 1`, `vm_stat` +
`sysctl vm.memory_pressure`, `netstat -ib` (diffed across samples), and `pmset -g batt` for CPU,
memory (+ pressure), network, and battery respectively. Do not add `systeminformation` or any
other runtime dependency. Mark CPU temperature as unavailable (`null`) in the JSON payload unless
the project is willing to accept one of the two tradeoffs below for that single metric — that
decision is a separate, explicit call to make, not a default.**

Why not `systeminformation`: per §2b, its darwin implementation for CPU/memory/network/battery is
itself a thin wrapper around the same subprocess calls recommended below — adopting it buys a
parsing convenience layer at the cost of a new runtime dependency (this project currently has
zero), while its `battery()` path adds an unneeded `ioreg` call, and it delivers *nothing* extra
for CPU temperature without also manually adding a native-compiled optional dependency. There is
no metric in this list where `systeminformation` is uniquely capable and the zero-dependency path
is impractical — the bar in the task's hard constraints for justifying a new dependency ("a
metric is simply unavailable without root, or the parsing is too fragile to trust") is not met.

Concrete next steps for whoever implements the daemon:

1. **CPU %**: spawn `top -l 1 -n 0 -stats cpu` (or parse the full `top -l 1` output) once per 2s
   tick and regex the `CPU usage: X% user, Y% sys, Z% idle` line into `100 - idle`. Alternative:
   use `os.cpus()` and diff two snapshots yourself (no subprocess) if avoiding the `top` spawn
   overhead every 2s is preferred — this is a real tradeoff (`top` gives a ready global % but
   spawns a process; `os.cpus()` diffing is subprocess-free but needs a two-sample delta, meaning
   the first tick after daemon start has no valid CPU% until a second sample arrives).
2. **Memory**: spawn `vm_stat` (parse `Pages free/active/inactive/wired down/occupied by
   compressor`, and read the page-size header rather than hardcoding it — it was 16384 bytes on
   this test machine, not the traditional 4096) to compute used/total in bytes. For a pressure
   signal beyond raw numbers, also read `sysctl vm.memory_pressure` (documented above as
   unofficial/undocumented — wrap in a try/catch and treat a parse failure as "pressure unknown,"
   not a crash).
3. **Network**: spawn `netstat -ib`, parse per-interface `Ibytes`/`Obytes` (dedupe rows per
   interface name, e.g. keep only the `<Link#N>` row), retain the previous sample's counters and
   interface list in the daemon's own state, and divide `(current - previous) / elapsed_seconds`
   for bytes/sec up and down per active interface on each 2s tick. First tick has no valid rate
   (no prior sample) — same caveat as CPU. Consider `netstat -I <iface> -w 2` as a persistent
   child process alternative if repeated spawn overhead at 2s cadence proves measurable in
   practice — this was confirmed viable per the netstat man page but not benchmarked in this
   research pass.
4. **Battery**: spawn `pmset -g batt`, regex `(\d+)%` for percentage and check for
   `charging`/`discharging`/`AC attached; not charging`/`charged` substrings for charging state.
   No `ioreg` call needed for just percent + charging state.
5. **CPU temperature**: return `null` / omit the field, and have the ESP32/web layers render an
   "unavailable" state for that one row, **unless** a follow-up decision (outside the scope of
   this research ticket) chooses one of:
   - Accept a native-compiled helper binary (small standalone Objective-C/C tool using the
     `IOHIDEventSystemClient` technique documented in §2d/§3, built once, invoked via
     `child_process` every 2s) — satisfies "no sudo" but not "no native compilation" as currently
     phrased; would need that constraint to be relaxed to "no native compilation at *runtime* /
     no build step for daemon *updates*," with the one-time build happening at setup/install.
   - Accept a `sudo`/elevated-launchd tradeoff for `powermetrics --samplers smc` specifically
     (e.g. a narrowly-scoped `sudoers` NOPASSWD entry for that one command, or a separate
     root-run helper daemon that only publishes the temperature value) — satisfies "no native
     compile" but not "no sudo" as currently phrased.

This keeps `package.json` unchanged (no new `dependencies` entry), which preserves the project's
existing zero-runtime-dependency posture referenced in `docs/prompt_draft.md`'s R3 and this
repo's current `package.json` (only `vitest` as a devDependency).

## 5. Open questions / risks

- **Undocumented kernel `sysctl`s** (`vm.memory_pressure`, `kern.memorystatus_level`) — no Apple
  developer documentation was found describing these OIDs, their exact semantics, or a stability
  guarantee across macOS versions. Flagged as empirically-observed, not officially documented.
- **`memory_pressure` binary's no-argument behavior** (dumping current stats rather than doing
  nothing or erroring) is not described in its own man page. This should be re-verified on
  whatever macOS version the daemon actually ships against, since it's undocumented and could be
  version-specific.
- **"No SMC on Apple Silicon Macs"** — one search-result summary asserted this; it was not
  independently corroborated against an Apple primary source in this pass, and it is somewhat in
  tension with `powermetrics`'s `smc` sampler still existing as a documented sampler name. Treat
  as unresolved rather than settled.
- **`pmset -g therm`'s real output when a thermal event has actually occurred** could not be
  observed on this idle test machine (it only showed "no ... recorded" notices); its format under
  actual thermal pressure was not empirically verified in this research pass, only its
  no-arguments-required, no-root behavior.
- **Whether Apple's private `IOHIDEventSystemClient` API silently breaks in a future macOS
  release** is an inherent, unbounded risk of relying on it (should the project ever choose that
  tradeoff for CPU temperature) — there is no changelog or deprecation notice mechanism for
  private APIs, by definition.
- **Actual CPU/parsing overhead of spawning `top`/`vm_stat`/`netstat`/`pmset` every 2 seconds**
  was not benchmarked in this research pass (out of scope for RESEARCH mode); the recommendation
  in §4 to consider a persistent `netstat -w` process instead of repeated spawns is a
  design-time option to evaluate, not a measured conclusion.
