#!/usr/bin/env node
import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultSpecDir = path.join(repoRoot, "circuits", "formal", "specs");

const args = new Set(process.argv.slice(2));
const selfTest = args.has("--self-test");
const requireTargetArtifacts = args.has("--require-target-artifacts");

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function rel(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/");
}

function compact(source) {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "");
}

function sourceEntryFor(artifact, spec) {
  const entries = Object.values(artifact.file_map ?? {});
  const suffix = spec.source_path.replaceAll("\\", "/");
  return entries.find((entry) => entry.path?.replaceAll("\\", "/").endsWith(suffix))
    ?? entries.find((entry) => entry.path?.replaceAll("\\", "/").includes(`/circuits/${spec.circuit}/src/main.nr`));
}

function assertBytecodeLooksLikeAcir(artifact, circuit) {
  if (typeof artifact.bytecode !== "string" || artifact.bytecode.length === 0) {
    fail(`${circuit}: missing compiled ACIR bytecode`);
  }
  const decoded = gunzipSync(Buffer.from(artifact.bytecode, "base64"));
  if (decoded.length < 64) {
    fail(`${circuit}: compiled ACIR bytecode is unexpectedly small`);
  }
  if (!artifact.noir_version || !artifact.hash) {
    fail(`${circuit}: artifact must include noir_version and hash metadata`);
  }
}

function assertAbi(artifact, spec) {
  const params = artifact.abi?.parameters ?? [];
  for (const param of params) {
    const kind = param.type?.kind === "array" ? param.type?.type?.kind : param.type?.kind;
    if (kind !== "field") {
      fail(`${spec.circuit}: ABI input ${param.name} must be a field or field array`);
    }
  }
  const byVisibility = (visibility) => params
    .filter((param) => param.visibility === visibility)
    .map((param) => param.name);
  const publicNames = byVisibility("public");
  const privateNames = byVisibility("private");

  const expectedPublic = spec.abi.public.filter((name) => name !== "return");
  for (const name of expectedPublic) {
    if (!publicNames.includes(name)) fail(`${spec.circuit}: missing public ABI input ${name}`);
  }
  for (const name of spec.abi.private) {
    if (!privateNames.includes(name)) fail(`${spec.circuit}: missing private ABI input ${name}`);
  }
  for (const name of publicNames) {
    if (!expectedPublic.includes(name)) fail(`${spec.circuit}: unexpected public ABI input ${name}`);
  }
  for (const name of privateNames) {
    if (!spec.abi.private.includes(name)) fail(`${spec.circuit}: unexpected private ABI input ${name}`);
  }
  for (const [name, length] of Object.entries(spec.abi.arrays ?? {})) {
    const param = params.find((candidate) => candidate.name === name);
    if (param?.type?.kind !== "array" || param.type.length !== length) {
      fail(`${spec.circuit}: ABI input ${name} must be a field array of length ${length}`);
    }
  }
  const returnType = artifact.abi?.return_type;
  if (
    spec.abi.public.includes("return")
    && (returnType?.visibility !== "public" || returnType?.abi_type?.kind !== "field")
  ) {
    fail(`${spec.circuit}: expected a public field return value`);
  }
}

const checkers = {
  "u64-round-trip-range": (s) => s.includes("fnconstrain_u64(v:Field)->u64{letnarrowed=vasu64;assert(narrowedasField==v);narrowed}"),
  "withdraw-amount-u64-witness": (s) => s.includes("letwithdraw_u64=constrain_u64(withdraw_amount);"),
  "amount-u64-witness": (s) => s.includes("letamount_u64=constrain_u64(amount);"),
  "withdraw-lte-amount": (s) => s.includes("assert(withdraw_u64<=amount_u64);"),
  "change-is-amount-minus-withdraw": (s) => s.includes("letchange=amount-withdraw_amount;"),
  "change-commitment-uses-change": (s) => s.includes("letexpected_change=hash_leaf(change_nullifier,change_secret,change);") && s.includes("assert(expected_change==change_commitment);"),
  "hash-leaf-includes-amount": (s) => s.includes("fnhash_leaf(nullifier:Field,secret:Field,amount:Field)->Field{hash2(hash2(hash2(LEAF_DOMAIN,nullifier),secret),amount)}"),
  "spent-leaf-uses-amount": (s) => s.includes("letleaf=hash_leaf(nullifier,secret,amount);"),
  "computed-root-asserted": (s) => (s.includes("letcomputed_root=compute_root(leaf,path_siblings,path_bits);") || s.includes("letcomputed_root=compute_root(leaf,path_siblings,path_bits);")) && (s.includes("assert(computed_root==root);") || s.includes("assert(computed_root==merkle_root);")),
  "nullifier-hash-asserted": (s) => s.includes("letnf=hash_nullifier(nullifier);") && s.includes("assert(nf==nullifier_hash);"),
  "kyc-hash-asserted": (s) => s.includes("letcomputed_kyc=hash_kyc(kyc_preimage);") && s.includes("assert(computed_kyc==kyc_hash);"),
  "disclosed-amount-u64-witness": (s) => s.includes("letdisclosed_u64=constrain_u64(disclosed_amount);"),
  "threshold-u64-witness": (s) => s.includes("letthreshold_u64=constrain_u64(threshold);"),
  "amount-equals-disclosed": (s) => s.includes("assert(amount_u64==disclosed_u64);"),
  "amount-gte-threshold": (s) => s.includes("assert(amount_u64>=threshold_u64);"),
  "hasher-poseidon2-two-input": (s) => s.includes("pubfnmain(a:Field,b:Field)->pubField{Poseidon2::hash([a,b],2)}")
};

function verifyChecks(spec, source) {
  const normalized = compact(source);
  for (const property of spec.properties) {
    for (const check of property.checks) {
      const checker = checkers[check];
      if (!checker) fail(`${spec.circuit}: unknown formal check ${check}`);
      if (!checker(normalized)) {
        fail(`${spec.circuit}: property ${property.id} failed check ${check}`);
      }
    }
  }
}

function validateSpec(spec) {
  if (!spec.circuit) fail("spec is missing circuit");
  if (!spec.source_path) fail(`${spec.circuit}: spec is missing source_path`);
  if (!Array.isArray(spec.artifact_candidates) || spec.artifact_candidates.length === 0) {
    fail(`${spec.circuit}: spec must declare artifact_candidates`);
  }
  if (!Array.isArray(spec.abi?.public) || !Array.isArray(spec.abi?.private)) {
    fail(`${spec.circuit}: spec must declare abi.public and abi.private`);
  }
  if (!Array.isArray(spec.properties) || spec.properties.length === 0) {
    fail(`${spec.circuit}: spec must declare at least one property`);
  }
  const propertyIds = new Set();
  for (const property of spec.properties) {
    if (!property.id) fail(`${spec.circuit}: property is missing id`);
    if (propertyIds.has(property.id)) fail(`${spec.circuit}: duplicate property ${property.id}`);
    propertyIds.add(property.id);
    if (!Array.isArray(property.checks) || property.checks.length === 0) {
      fail(`${spec.circuit}: property ${property.id} must declare checks`);
    }
  }
}

function verifySpec(spec, overrideArtifact = null) {
  validateSpec(spec);
  const artifactCandidates = requireTargetArtifacts
    ? spec.artifact_candidates.filter((candidate) => candidate.includes("/target/") || candidate.includes("\\target\\"))
    : spec.artifact_candidates;
  const candidates = artifactCandidates.map((candidate) => path.join(repoRoot, candidate));
  const artifactPath = candidates.find((candidate) => existsSync(candidate));
  if (!artifactPath && !overrideArtifact) {
    fail(`${spec.circuit}: no compiled artifact found in ${artifactCandidates.join(", ")}`);
  }

  const artifact = overrideArtifact ?? readJson(artifactPath);
  assertBytecodeLooksLikeAcir(artifact, spec.circuit);
  assertAbi(artifact, spec);

  const entry = sourceEntryFor(artifact, spec);
  if (!entry?.source) {
    fail(`${spec.circuit}: compiled artifact does not include ${spec.source_path} in file_map`);
  }

  const sourcePath = path.join(repoRoot, spec.source_path);
  if (existsSync(sourcePath)) {
    const currentSource = readFileSync(sourcePath, "utf8");
    if (compact(currentSource) !== compact(entry.source)) {
      const artifactRel = artifactPath ? rel(artifactPath) : "";
      if (!artifactRel.startsWith("frontend/src/circuits/")) {
        fail(`${spec.circuit}: compiled artifact source differs from ${spec.source_path}; re-run nargo compile`);
      }
      if (!overrideArtifact) {
        console.warn(`${spec.circuit}: warning: ${artifactRel} is stale relative to ${spec.source_path}; CI verifies freshly compiled target artifacts`);
      }
    }
  }

  verifyChecks(spec, entry.source);
  return `${spec.circuit}: verified ${spec.properties.map((property) => property.id).join(", ")} using ${artifactPath ? rel(artifactPath) : "mutated artifact"}`;
}

function loadSpecs() {
  return readdirSync(defaultSpecDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readJson(path.join(defaultSpecDir, file)));
}

function runSelfTest(specs) {
  const shieldedPool = specs.find((spec) => spec.circuit === "shielded_pool");
  if (!shieldedPool) fail("self-test: shielded_pool spec is missing");
  const artifactPath = shieldedPool.artifact_candidates
    .map((candidate) => path.join(repoRoot, candidate))
    .find((candidate) => existsSync(candidate));
  if (!artifactPath) fail("self-test: no shielded_pool artifact available");

  const mutations = [
    {
      name: "withdraw comparison",
      from: "assert(withdraw_u64 <= amount_u64);",
      to: "assert(withdraw_u64 <= withdraw_u64);"
    },
    {
      name: "change arithmetic",
      from: "let change = amount - withdraw_amount;",
      to: "let change = amount;"
    }
  ];

  const rejected = [];
  for (const mutation of mutations) {
    const mutant = structuredClone(readJson(artifactPath));
    const entry = sourceEntryFor(mutant, shieldedPool);
    entry.source = entry.source.replace(mutation.from, mutation.to);
    if (!entry.source.includes(mutation.to)) {
      fail(`self-test: could not apply ${mutation.name} mutation`);
    }

    try {
      verifySpec(shieldedPool, mutant);
    } catch (error) {
      rejected.push(`${mutation.name} (${error.message})`);
      continue;
    }
    fail(`self-test: ${mutation.name} mutation was accepted`);
  }
  return `self-test: mutations rejected: ${rejected.join("; ")}`;
}

try {
  const specs = loadSpecs();
  const results = specs.map((spec) => verifySpec(spec));
  if (selfTest) results.push(runSelfTest(specs));
  for (const result of results) console.log(result);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
