import { resolve } from "node:path";
import { runDependencyPreflight } from "./dependencies/preflight.ts";

const report = runDependencyPreflight(resolve("."));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
