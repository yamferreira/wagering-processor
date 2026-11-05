import type { Subprocess } from "bun";
import type { AppConfig } from "../../src/infrastructure/config/config";

/**
 * Real OS processes running `src/main.ts` (one "instance" each, A31).
 *
 * - Readiness: the child sends `{ type: "ready" }` over IPC once its roles are started.
 * - stop(): graceful shutdown. Real SIGTERM on POSIX; on Windows Bun turns kill("SIGTERM") into
 *   an immediate TerminateProcess, so the same shutdown path is triggered over IPC instead.
 * - kill(): abrupt (SIGKILL / TerminateProcess) — a crash, no cleanup.
 * - Every spawned process is tracked and killed on test teardown or when the test runner exits,
 *   so no orphan survives a failing test.
 */
const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const live = new Set<Instance>();

process.once("exit", () => {
  for (const instance of live) instance.proc.kill("SIGKILL");
});

export interface Instance {
  name: string;
  proc: Subprocess;
  port: number;
  baseUrl: string;
  logs: string[];
  exited: Promise<number>;
  stop(timeoutMs?: number): Promise<number>;
  kill(): Promise<number>;
}

export interface SpawnOptions {
  name?: string;
  config: Partial<AppConfig>;
  /** Echo the child's stdout/stderr (debugging). */
  echo?: boolean;
  readyTimeoutMs?: number;
}

export function configToEnv(config: Partial<AppConfig>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    env[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return env;
}

let spawned = 0;

export async function spawnInstance(options: SpawnOptions): Promise<Instance> {
  spawned += 1;
  const name = options.name ?? `instance-${spawned}`;
  let port = options.config.PORT ?? 0;
  const logs: string[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const proc = Bun.spawn(["bun", "src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, ...configToEnv(options.config) },
    stdout: "pipe",
    stderr: "pipe",
    ipc(message) {
      const ready = message as { type?: string; port?: number };
      if (ready?.type === "ready") {
        if (ready.port) port = ready.port;
        resolveReady();
      }
    },
  });
  void collect(proc.stdout as ReadableStream<Uint8Array>, logs, options.echo ? `[${name}] ` : undefined);
  void collect(proc.stderr as ReadableStream<Uint8Array>, logs, options.echo ? `[${name}!] ` : undefined);

  const exited = proc.exited.then((code) => {
    live.delete(instance);
    rejectReady(new Error(`${name} exited with ${code} before becoming ready:\n${logs.slice(-20).join("\n")}`));
    return code;
  });

  const instance: Instance = {
    name,
    proc,
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    logs,
    exited,
    async stop(timeoutMs = 20_000) {
      if (proc.exitCode !== null || proc.signalCode !== null) return exited;
      if (process.platform === "win32") proc.send({ type: "shutdown" });
      else proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
    async kill() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      return exited;
    },
  };
  live.add(instance);

  const timeout = setTimeout(
    () => rejectReady(new Error(`${name} not ready after ${options.readyTimeoutMs ?? 20_000} ms:\n${logs.slice(-20).join("\n")}`)),
    options.readyTimeoutMs ?? 20_000,
  );
  try {
    await ready;
  } catch (error) {
    await instance.kill();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return instance;
}

/** Kills every instance still alive (afterAll / afterEach safety net). */
export async function killAllInstances(): Promise<void> {
  await Promise.all([...live].map((instance) => instance.kill()));
}

export function liveInstanceCount(): number {
  return live.size;
}

async function collect(stream: ReadableStream<Uint8Array>, sink: string[], echoPrefix?: string): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        sink.push(line);
        if (echoPrefix) console.log(echoPrefix + line);
      }
    }
  } catch {
    // stream closed with the process
  }
  if (buffer) sink.push(buffer);
}

/** Parsed JSON log lines of an instance (non-JSON lines are skipped). */
export function jsonLogs(instance: Instance): Record<string, unknown>[] {
  return instance.logs.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}
