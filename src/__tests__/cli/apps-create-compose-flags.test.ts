import { describe, expect, test } from "bun:test"
import { validateCreateOptions } from "../../commands/apps/create"
import { ValidationError } from "../../utils/errors"

describe("CLI: validateCreateOptions", () => {
  test("--compose-file without --service throws", () => {
    expect(() => validateCreateOptions({ composeFile: "/tmp/x.yml" }))
      .toThrow(/--service is required/)
  })

  test("--service without any compose source throws", () => {
    expect(() => validateCreateOptions({ image: "nginx", service: "web" }))
      .toThrow(/--service is only valid/)
  })

  test("--compose without --git throws", () => {
    expect(() => validateCreateOptions({ compose: "docker-compose.yml", service: "web" }))
      .toThrow(/--compose requires --git/)
  })

  test("--compose-file + --image throws", () => {
    expect(() => validateCreateOptions({ image: "nginx", composeFile: "/tmp/c.yml", service: "web" }))
      .toThrow(/cannot be combined/)
  })

  test("--compose-file + --service passes", () => {
    expect(() => validateCreateOptions({ composeFile: "/tmp/c.yml", service: "web" }))
      .not.toThrow()
  })

  test("--git + --compose + --service passes", () => {
    expect(() => validateCreateOptions({ git: "https://x.test/r.git", compose: "dc.yml", service: "web" }))
      .not.toThrow()
  })

  test("errors are ValidationError instances", () => {
    try {
      validateCreateOptions({ composeFile: "/tmp/c.yml" })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
    }
  })

  test("--env-file without compose throws", () => {
    expect(() => validateCreateOptions({ image: "nginx", envFile: "/tmp/.env" }))
      .toThrow(/--env-file is only valid/)
  })

  test("--env-file with --compose-file + --service passes", () => {
    expect(() =>
      validateCreateOptions({ composeFile: "/tmp/c.yml", service: "web", envFile: "/tmp/.env" })
    ).not.toThrow()
  })

  test("--env-file with --git + --compose + --service passes", () => {
    expect(() =>
      validateCreateOptions({
        git: "https://x.test/r.git",
        compose: "dc.yml",
        service: "web",
        envFile: "/tmp/.env",
      })
    ).not.toThrow()
  })
})
