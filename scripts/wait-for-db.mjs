import { execSync } from "node:child_process";

const DEADLINE_MS = 60_000;
const started = Date.now();

while (Date.now() - started < DEADLINE_MS) {
  try {
    execSync("docker compose exec -T db pg_isready -U agentcorp", {
      stdio: "ignore",
    });
    console.log("postgres ready");
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
console.error("postgres did not become ready within 60s");
process.exit(1);
