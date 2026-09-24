import { describe, test, expect } from "bun:test"
import { serviceProblem, watchServices } from "../../lib/app-health"
import type { AppServiceStatus, AppStatus } from "../../types"

const svc = (over: Partial<AppServiceStatus>): AppServiceStatus => ({
  service: "web",
  primary: true,
  state: "running",
  ...over,
})

describe("Unit: serviceProblem", () => {
  test("a running service without healthcheck is fine", () => {
    expect(serviceProblem(svc({}))).toBeNull()
  })

  test("a one-shot sidecar that exited 0 (migration job) is fine", () => {
    expect(serviceProblem(svc({ primary: false, state: "exited", exitCode: 0 }))).toBeNull()
  })

  test("the primary exiting 0 is still a failure: it must stay up", () => {
    expect(serviceProblem(svc({ state: "exited", exitCode: 0 }))).toBe("exited (exit code 0)")
  })

  test("a sidecar exiting non-zero is a failure", () => {
    expect(serviceProblem(svc({ primary: false, state: "exited", exitCode: 1 }))).toBe("exited (exit code 1)")
  })

  test("exited without a known exit code is not treated as a clean exit", () => {
    expect(serviceProblem(svc({ primary: false, state: "exited" }))).toBe("exited")
  })

  test("crash loops and dead containers are failures", () => {
    expect(serviceProblem(svc({ state: "restarting", exitCode: 0 }))).toBe("keeps restarting")
    expect(serviceProblem(svc({ primary: false, state: "dead" }))).toBe("is dead")
  })

  test("running but unhealthy is a failure; starting is not", () => {
    expect(serviceProblem(svc({ health: "unhealthy" }))).toBe("is unhealthy")
    expect(serviceProblem(svc({ health: "starting" }))).toBeNull()
  })

  test("a missing or never-started primary is a failure; the same sidecar state is not", () => {
    expect(serviceProblem(svc({ state: "missing" }))).toBe("has no container")
    expect(serviceProblem(svc({ state: "created" }))).toBe("was never started")
    expect(serviceProblem(svc({ primary: false, state: "created" }))).toBeNull()
  })
})

describe("Unit: watchServices", () => {
  const noSleep = async () => {}

  function sequence(samples: AppServiceStatus[][]): () => Promise<AppStatus> {
    let i = 0
    return async () => ({ name: "app", services: samples[Math.min(i++, samples.length - 1)]! })
  }

  test("catches a problem that only shows up mid-window", async () => {
    // Crash loops look "running" for a moment between restarts
    const problems = await watchServices(
      sequence([[svc({})], [svc({ state: "restarting", exitCode: 1 })], [svc({})]]),
      { windowMs: 6, intervalMs: 3, sleepFn: noSleep }
    )
    expect(problems).toEqual([{ service: "web", problem: "keeps restarting" }])
  })

  test("stops sampling at the first sample with problems and reports all of them", async () => {
    let calls = 0
    const bad = [
      svc({}),
      svc({ service: "redis", primary: false, state: "restarting" }),
      svc({ service: "db", primary: false, state: "exited", exitCode: 2 }),
    ]
    const problems = await watchServices(
      async () => (calls++, { name: "app", services: bad }),
      { windowMs: 60, intervalMs: 3, sleepFn: noSleep }
    )
    expect(calls).toBe(1)
    expect(problems).toEqual([
      { service: "redis", problem: "keeps restarting" },
      { service: "db", problem: "exited (exit code 2)" },
    ])
  })

  test("healthy app yields no problems and samples across the whole window", async () => {
    let calls = 0
    const slept: number[] = []
    const problems = await watchServices(
      async () => {
        calls++
        return { name: "app", services: [svc({})] }
      },
      { windowMs: 9, intervalMs: 3, sleepFn: async (ms) => void slept.push(ms) }
    )
    expect(problems).toEqual([])
    expect(calls).toBe(4)
    expect(slept).toEqual([3, 3, 3])
  })

  test("a zero window still takes one sample", async () => {
    let calls = 0
    await watchServices(async () => (calls++, { name: "app", services: [] }), { windowMs: 0, intervalMs: 3, sleepFn: noSleep })
    expect(calls).toBe(1)
  })

  test("status errors propagate instead of being reported as healthy", async () => {
    await expect(
      watchServices(async () => { throw new Error("agent down") }, { windowMs: 0, sleepFn: noSleep })
    ).rejects.toThrow("agent down")
  })
})
