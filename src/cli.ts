import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./core/config.ts";
import type { TransportKind } from "./core/contracts.ts";
import { SessionPlanner } from "./core/session.ts";
import { redact } from "./core/redaction.ts";
import { createAdapter } from "./adapters/index.ts";

interface Arguments {
  command: "dry-run";
  configPath: string;
  transport?: TransportKind;
}

function parseArguments(argv: string[]): Arguments {
  if (argv[0] !== "dry-run") {
    throw new Error("Only the dry-run command is available.");
  }
  let configPath = "config/bridge.example.json";
  let transport: TransportKind | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--config") {
      configPath = argv[++index] ?? "";
    } else if (current === "--transport") {
      const value = argv[++index];
      if (value !== "discord" && value !== "meet") {
        throw new Error("--transport must be discord or meet.");
      }
      transport = value;
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }
  if (!configPath) throw new Error("--config requires a path.");
  return { command: "dry-run", configPath, transport };
}

export async function run(argv: string[]): Promise<string> {
  const args = parseArguments(argv);
  const config = await loadConfig(resolve(args.configPath), args.transport);
  const adapter = createAdapter(config.transport);
  const planner = new SessionPlanner();
  const report = await planner.dryRun(config, adapter);
  return `${JSON.stringify(report, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((error) => {
      process.stderr.write(`${redact((error as Error).message)}\n`);
      process.exitCode = 1;
    });
}
