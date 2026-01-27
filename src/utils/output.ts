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

// Table formatting for sites list
export function formatTable(
  headers: string[],
  rows: string[][],
  columnWidths?: number[]
): string {
  const widths =
    columnWidths ||
    headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
    )

  const headerRow = headers
    .map((h, i) => h.padEnd(widths[i] || h.length))
    .join("  ")
  const separator = widths.map((w) => "-".repeat(w)).join("  ")
  const dataRows = rows
    .map((row) =>
      row.map((cell, i) => (cell || "").padEnd(widths[i] || cell.length)).join("  ")
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

// Generate random password
export function generatePassword(length: number = 13): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let password = ""
  const randomBytes = crypto.getRandomValues(new Uint8Array(length))
  for (let i = 0; i < length; i++) {
    password += chars[randomBytes[i]! % chars.length]
  }
  return password
}
