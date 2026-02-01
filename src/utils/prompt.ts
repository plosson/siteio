import * as readline from "readline"

export async function text(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message}: `, resolve)
  })
  rl.close()

  return answer.trim()
}

export async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message} [y/N] `, resolve)
  })
  rl.close()

  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
}

export async function select<T extends string>(
  message: string,
  options: { value: T; label: string }[]
): Promise<T> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  console.error(message)
  options.forEach((opt, i) => {
    console.error(`  ${i + 1}) ${opt.label}`)
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question("Choice: ", resolve)
  })
  rl.close()

  const index = parseInt(answer, 10) - 1
  const option = options[index]
  if (option) {
    return option.value
  }

  // Try matching by value
  const match = options.find((o) => o.value.toLowerCase() === answer.toLowerCase())
  if (match) {
    return match.value
  }

  console.error(`Invalid choice: ${answer}`)
  process.exit(1)
  throw new Error("Unreachable") // For TypeScript
}
