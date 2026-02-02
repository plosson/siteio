import chalk from "chalk"

// ASCII symbols (no emoji for portability)
export const symbols = {
  success: "+",
  error: "x",
  warning: "!",
  info: ">",
  bullet: "*",
  arrow: "->",
}

export function formatSuccess(message: string): string {
  return chalk.green(`${symbols.success} ${message}`)
}

export function formatError(message: string): string {
  return chalk.red(`${symbols.error} ${message}`)
}

export function formatWarning(message: string): string {
  return chalk.yellow(`${symbols.warning} ${message}`)
}

export function formatInfo(message: string): string {
  return chalk.cyan(`${symbols.info} ${message}`)
}

export function formatDim(message: string): string {
  return chalk.gray(message)
}

// Strip ANSI escape codes for accurate string length measurement
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

// Get visual width of a string (excluding ANSI codes)
function visualWidth(str: string): number {
  return stripAnsi(str).length
}

// Pad a string to a visual width (accounting for ANSI codes)
function padEndVisual(str: string, targetWidth: number): string {
  const currentWidth = visualWidth(str)
  if (currentWidth >= targetWidth) return str
  return str + " ".repeat(targetWidth - currentWidth)
}

// Table formatting for sites list
export function formatTable(
  headers: string[],
  rows: string[][],
  columnWidths?: number[]
): string {
  const widths =
    columnWidths ||
    headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => visualWidth(r[i] || "")))
    )

  const headerRow = headers
    .map((h, i) => h.padEnd(widths[i] || h.length))
    .join("  ")
  const separator = widths.map((w) => "-".repeat(w)).join("  ")
  const dataRows = rows
    .map((row) =>
      row.map((cell, i) => padEndVisual(cell || "", widths[i] || visualWidth(cell || ""))).join("  ")
    )
    .join("\n")

  return `${chalk.bold(headerRow)}\n${chalk.gray(separator)}\n${dataRows}`
}

// Format bytes to human readable
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

// Format container status with appropriate color
export function formatStatus(status: string): string {
  switch (status) {
    case "running":
      return chalk.green(status)
    case "stopped":
      return chalk.yellow(status)
    case "failed":
      return chalk.red(status)
    default:
      return chalk.dim(status)
  }
}

// Format a site version entry for history display
export function formatVersionEntry(version: {
  version: number
  deployedAt: string
  deployedBy?: string
  size: number
}): string {
  const date = new Date(version.deployedAt).toLocaleString()
  const user = version.deployedBy ? chalk.blue(version.deployedBy.padEnd(12)) : chalk.dim("unknown".padEnd(12))
  return `  ${chalk.bold(`v${version.version}`)}  ${user}  ${date}  ${formatBytes(version.size)}`
}
