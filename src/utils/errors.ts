import chalk from "chalk"

export class SiteioError extends Error {
  constructor(
    message: string,
    public code: "USER" | "SYSTEM" = "SYSTEM"
  ) {
    super(message)
    this.name = "SiteioError"
  }
}

export class ValidationError extends SiteioError {
  constructor(message: string) {
    super(message, "USER")
    this.name = "ValidationError"
  }
}

export class ApiError extends SiteioError {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message, statusCode && statusCode >= 400 && statusCode < 500 ? "USER" : "SYSTEM")
    this.name = "ApiError"
  }
}

export class ConfigError extends SiteioError {
  constructor(message: string) {
    super(message, "USER")
    this.name = "ConfigError"
  }
}

export function handleError(error: unknown): never {
  if (error instanceof SiteioError) {
    console.error(chalk.red(`x ${error.message}`))
    process.exit(error.code === "USER" ? 1 : 2)
  }

  if (error instanceof Error) {
    console.error(chalk.red(`x ${error.message}`))
    if (process.env.DEBUG) {
      console.error(chalk.gray(error.stack))
    }
    process.exit(2)
  }

  console.error(chalk.red(`x Unknown error: ${String(error)}`))
  process.exit(2)
}
