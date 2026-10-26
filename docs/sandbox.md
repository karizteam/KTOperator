# Sandbox

**All AI-directed command execution goes through a sandbox backend.** The
sandbox manager is owned by the runtime; the model cannot select backends,
change limits, add mounts, or weaken isolation. If no backend is available,
execution is refused with diagnostics — never downgraded silently.

## Backend: `docker` (preferred)

Real container isolation. Invocation built by `DockerBackend.buildArgs`:

```
docker run --rm -i
  --network none                    # unless sandbox.network=true
  --read-only                       # read-only root filesystem
  --cap-drop ALL                    # no Linux capabilities
  --security-opt no-new-privileges
  --user 65534:65534                # nobody
  --memory <m> --cpus <n> --pids-limit <p>
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m
  --mount type=bind,source=<workspace>,target=/work,ro|rw
  --workdir /work
  -e HOME=/tmp -e TMPDIR=/tmp …     # plus explicit per-call env only
  <image> <argv…>
```

Guarantees: kernel namespaces + cgroup limits; workspace is the only host
mount (read-only unless the call is authorized writable); network off by
default; no docker socket anywhere; minimal env; `--rm` cleanup; process
cancellation kills the client which terminates the container.

Requires: Docker CLI + daemon and `sandbox.image` (default `node:22-alpine`)
pulled. `operator sandbox status` checks all three and explains precisely
what is missing.

## Backend: `restricted-process` (explicit opt-in fallback)

For hosts without containers. **It is not a container.** It exists so
read-only diagnostics and carefully approved commands still work on
container-less machines after the user reads this document and runs:

```bash
operator config set security.allowRestrictedProcessFallback true
```

Applies: structured argv (no shell), minimal env, isolated HOME/TMP created
per run and deleted after, workspace-bound cwd, timeout with process-tree
kill, bounded output capture, prlimit `nofile`/`fsize` on Linux, and uid
demotion to `nobody` if Operator itself were ever run as root (do not run
Operator as root).

Honest limitations:

- **No filesystem isolation** — the process can read anything the user can.
  The workspace boundary still applies to *tools*, but a spawned compiler or
  test runner sees the normal filesystem.
- **No network isolation** — `sandbox.network=false` cannot be enforced.
- **No memory or process-count enforcement.** RLIMIT_AS measures virtual
  address space (kills legitimate runtimes like Node) and RLIMIT_NPROC
  counts every process of the UID (false kills on busy hosts); both were
  deliberately removed, so memory/pid limits are **only** guaranteed by the
  Docker backend's cgroups.
- Windows: no uid drop, no rlimits (weakest mode).

If these limitations are unacceptable, do not enable the fallback — install
Docker. `operator sandbox status` always states which guarantees the active
backend does and does not provide.

## Managed process layer (both backends)

- Executables resolved on a minimal PATH; structured argv only.
- `stdio` pipes with byte-bounded buffers and truncation flags.
- Timeout → SIGTERM to the process group → SIGKILL after 5s; Windows uses
  `taskkill /T /F`.
- AbortSignal from Ctrl+C follows the same kill path.
- Every run is recorded; `inspect_command_result` reads the bounded history;
  `terminate_managed_process` targets only live managed ids.

## Platform matrix

| Platform | docker | restricted-process |
|---|---|---|
| Linux 10.15+ distros | Full (cgroups v1/v2 via Docker) | prlimit nofile/fsize; no net/fs isolation |
| macOS | Via Docker Desktop | timeout/output only (no rlimit helper) |
| Windows 10/11 | Via Docker Desktop (Linux containers) | reduced mode; no uid drop, no rlimits |

A dedicated Windows Containers backend (Process-isolation) and macOS
`container` support are roadmap items; until then the fallback is the only
non-Docker path and its limits are stated above.
