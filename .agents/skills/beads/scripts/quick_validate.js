import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = Object.freeze(["external_product_url", "voice_agent_identity", "supported_os", "observable_real_e2e"]);
const PROXY_KINDS = new Set(["process", "participant", "counter", "count", "unit", "unit_test", "mock", "internal_transport", "transport"]);

function object(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

function descendants(issues, epicId) {
  const ids = new Set([epicId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const issue of issues) {
      if (ids.has(issue.parent) && !ids.has(issue.id)) { ids.add(issue.id); changed = true; }
    }
  }
  ids.delete(epicId);
  return ids;
}

export function quickValidate(issues, epicId) {
  const errors = [];
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const epic = byId.get(epicId);
  if (!epic || epic.issue_type !== "epic") return { valid: false, epic_id: epicId, errors: [`${epicId}: canonical Epic not found`] };
  const acceptance = object(epic.metadata?.product_acceptance);
  const productUrl = String(acceptance.product_url ?? "");
  if (!/^https:\/\/[^\s]+$/i.test(productUrl)) errors.push("external_product_url: external HTTPS product URL missing");
  if (String(epic.external_ref ?? "") !== productUrl) errors.push("external_product_url: Epic external_ref must match product_acceptance.product_url");
  if (!String(acceptance.voice_agent_identity ?? "").trim()) errors.push("voice_agent_identity: concrete voice brain/agent identity missing");
  if (!Array.isArray(acceptance.supported_os) || !acceptance.supported_os.length || acceptance.supported_os.some((value) => !String(value).trim())) errors.push("supported_os: nonempty supported OS list missing");

  const requirementMap = object(acceptance.requirements);
  const childIds = descendants(issues, epicId);
  for (const requirement of REQUIRED) {
    const forward = object(requirementMap[requirement]);
    if (!forward.issue_id || !forward.test_ref || !forward.evidence_ref) {
      errors.push(`${requirement}: Epic -> child -> test -> evidence link incomplete`);
      continue;
    }
    if (!childIds.has(forward.issue_id)) {
      errors.push(`${requirement}: ${forward.issue_id} is not a descendant of ${epicId}`);
      continue;
    }
    const child = byId.get(forward.issue_id);
    const trace = object(child.metadata?.acceptance_trace);
    const reverse = object(object(trace.requirements)[requirement]);
    if (trace.epic_id !== epicId || reverse.test_ref !== forward.test_ref || reverse.evidence_ref !== forward.evidence_ref) {
      errors.push(`${requirement}: child reverse trace does not match Epic mapping`);
      continue;
    }
    if (requirement === "observable_real_e2e") {
      const kind = String(reverse.evidence_kind ?? "").toLowerCase();
      if (kind !== "observable_real_e2e" || PROXY_KINDS.has(kind)) errors.push("observable_real_e2e: proxy-only evidence cannot close product acceptance");
      for (const field of ["actor", "environment", "operation", "observable_result"]) {
        if (!String(reverse[field] ?? "").trim()) errors.push(`observable_real_e2e: ${field} missing`);
      }
    }
  }
  return { valid: errors.length === 0, epic_id: epicId, checked_requirements: REQUIRED, errors };
}

export function readCanonical(repo) {
  const result = spawnSync("bd", ["-C", repo, "--readonly", "list", "--all", "--json"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bd readonly readback failed (${result.status}): ${String(result.stderr).trim()}`);
  const issues = JSON.parse(String(result.stdout).trim());
  if (!Array.isArray(issues)) throw new Error("bd readonly readback was not an issue array");
  return issues;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoIndex = process.argv.indexOf("--repo");
  const epicIndex = process.argv.indexOf("--epic");
  const repo = path.resolve(repoIndex >= 0 ? process.argv[repoIndex + 1] : ".");
  const epicId = epicIndex >= 0 ? process.argv[epicIndex + 1] : "";
  if (!epicId) {
    console.error("Usage: node quick_validate.js --repo <canonical-repo> --epic <canonical-epic-id>");
    process.exit(2);
  }
  try {
    const result = quickValidate(readCanonical(repo), epicId);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { PROXY_KINDS, REQUIRED };
