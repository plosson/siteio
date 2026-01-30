import * as readline from "readline"

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
