/**
 * Machine resource inspection: CPUs, memory, cgroup v1/v2 limits, load.
 *
 * Design note (spec): "Report CPU + memory incl. cgroup/container limits;
 * don't assume 2 cores = 2 jobs." `effectiveCores` and `effectiveLimitBytes`
 * are the honest numbers agents should reason with; the `suggestion` string
 * is advisory only — nothing here configures the lock automatically.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { CpuInfo, InspectResult, MemInfo, MachineConfig, PoolConfig } from "../shared/protocol.js";

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function parseUint(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cgroupVersion(): "v2" | "v1" | "none" {
  if (readIfExists("/sys/fs/cgroup/cgroup.controllers") !== undefined) return "v2";
  if (readIfExists("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") !== undefined) return "v1";
  return "none";
}

function cgroupCpuLimit(): { quota: number | null; period: number | null } {
  if (cgroupVersion() === "v2") {
    // "max 100000" or "200000 100000"
    const s = readIfExists("/sys/fs/cgroup/cpu.max");
    if (!s) return { quota: null, period: null };
    const [q, p] = s.split(/\s+/);
    const period = parseUint(p);
    if (q === "max") return { quota: null, period };
    const quota = parseUint(q);
    return { quota, period: period ?? 100_000 };
  }
  if (cgroupVersion() === "v1") {
    const quota = parseUint(readIfExists("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
    const period = parseUint(readIfExists("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
    return { quota: quota && quota > 0 ? quota : null, period };
  }
  return { quota: null, period: null };
}

function cgroupMemoryLimit(): { limit: number | null; usage: number | null } {
  const v = cgroupVersion();
  if (v === "v2") {
    const s = readIfExists("/sys/fs/cgroup/memory.max");
    const u = readIfExists("/sys/fs/cgroup/memory.current");
    return {
      limit: s && s !== "max" ? parseUint(s) : null,
      usage: parseUint(u),
    };
  }
  if (v === "v1") {
    const l = parseUint(readIfExists("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    const u = parseUint(readIfExists("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    // v1 reports a huge sentinel when unlimited
    return { limit: l !== null && l < 1e15 ? l : null, usage: u };
  }
  return { limit: null, usage: null };
}

export function inspectMachine(config?: MachineConfig): InspectResult {
  const cpus = os.cpus();
  const { quota, period } = cgroupCpuLimit();
  const logical = cpus.length || 1;
  let effectiveCores = logical;
  if (quota !== null && period && period > 0) {
    effectiveCores = Math.min(logical, Math.max(1, Math.floor(quota / period)));
  }
  const loadavg = os.loadavg();
  const memTotal = os.totalmem();
  const memAvailable = (os as any).availableMemory ? (os as any).availableMemory() : os.freemem();
  const { limit: cgMemLimit, usage: cgMemUsage } = cgroupMemoryLimit();
  const effectiveLimitBytes = cgMemLimit !== null ? Math.min(memTotal, cgMemLimit) : memTotal;

  const loadPerCore = loadavg[0] / effectiveCores;
  const memUsedFrac = cgMemUsage !== null && cgMemLimit ? cgMemUsage / cgMemLimit : 1 - memAvailable / memTotal;
  const loadPressure = loadPerCore > 1.25 ? "high" : loadPerCore > 0.6 ? "moderate" : "low";
  const memPressure = memUsedFrac > 0.85 ? "high" : memUsedFrac > 0.6 ? "moderate" : "low";

  const pools: Record<string, PoolConfig> = config?.pools ?? { heavy: { capacity: 1 } };
  const totalCapacity = Object.values(pools).reduce((a, p) => a + p.capacity, 0);
  const suggestion =
    `Machines vary: this one exposes ~${effectiveCores} effective core(s) and ~` +
    `${(effectiveLimitBytes / 1024 ** 3).toFixed(1)} GiB effective memory (including container limits). ` +
    `Current total lock capacity across pools is ${totalCapacity}. Judge heavy vs light by expected ` +
    `CPU/memory/IO impact; adjust capacity via load-lock configure when warranted — this is a ` +
    `cooperative budget, not an enforced one.`;

  const cpu: CpuInfo = {
    logicalCores: logical,
    model: cpus[0]?.model?.trim(),
    loadavg: [loadavg[0], loadavg[1], loadavg[2]],
    cgroupVersion: cgroupVersion(),
    cgroupCpuQuota: quota,
    cgroupCpuPeriod: period,
    effectiveCores,
    loadPerEffectiveCore: Number((loadPerCore).toFixed(2)),
  };
  const memory: MemInfo = {
    totalBytes: memTotal,
    availableBytes: memAvailable,
    freeBytes: os.freemem(),
    cgroupMemoryLimitBytes: cgMemLimit,
    cgroupMemoryUsageBytes: cgMemUsage,
    effectiveLimitBytes,
  };
  return {
    cpu,
    memory,
    pressure: {
      note:
        `1-min load per effective core: ${cpu.loadPerEffectiveCore} (${loadPressure}); ` +
        `memory used ≈ ${(memUsedFrac * 100).toFixed(0)}% of effective limit (${memPressure}).`,
      loadPressure,
      memPressure,
    },
    loadLock: { pools, suggestion },
  };
}
