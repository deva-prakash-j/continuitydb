import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { requiredIdentifier } from "./security.js";

const MEMORY_KINDS = new Set(["working", "inference", "git-fact", "decision"]);
const SENSITIVITIES = new Set(["public", "private", "sensitive", "restricted"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function boundedNumber(value, fallback, min, max, name) {
  const numeric = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`${name} must be a finite number`);
  return clamp(numeric, min, max);
}

function secureJson(path) {
  if (!path) return {};
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error("capture policy file must not be readable or writable by group/other");
  return JSON.parse(readFileSync(path, "utf8"));
}

function futureIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function safeRepoPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) return null;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return value;
}

export function loadCapturePolicy(path) {
  const input = secureJson(path);
  const projectRoots = {};
  for (const [projectId, configured] of Object.entries(input.project_roots || {})) {
    requiredIdentifier(projectId, "project_id");
    const root = typeof configured === "string" ? configured : configured?.root;
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error(`project root for ${projectId} must be absolute`);
    const allowedRefs = typeof configured === "string" ? ["HEAD"] : configured.allowed_refs || ["HEAD"];
    if (!Array.isArray(allowedRefs) || !allowedRefs.length || allowedRefs.length > 32) {
      throw new Error(`allowed_refs for ${projectId} must contain 1-32 refs`);
    }
    projectRoots[projectId] = Object.freeze({
      root: realpathSync(root),
      allowed_refs: Object.freeze(allowedRefs.map((ref) => requiredIdentifier(ref, "git_ref"))),
    });
  }
  return Object.freeze({
    working_ttl_seconds: boundedNumber(input.working_ttl_seconds, 86_400, 300, 604_800, "working_ttl_seconds"),
    inference_ttl_seconds: boundedNumber(input.inference_ttl_seconds, 604_800, 3_600, 2_592_000, "inference_ttl_seconds"),
    auto_activate_confidence: boundedNumber(input.auto_activate_confidence, 0.8, 0.5, 1, "auto_activate_confidence"),
    max_records_per_project_per_agent: boundedNumber(input.max_records_per_project_per_agent, 10_000, 100, 1_000_000, "max_records_per_project_per_agent"),
    project_roots: Object.freeze(projectRoots),
  });
}

export function verifyGitEvidence({ project_id, git_commit, repo_path, content_checksum, body }, policy) {
  const project = policy.project_roots[project_id];
  if (!project) return { verified: false, reason: "project root is not configured" };
  if (typeof git_commit !== "string" || !/^[a-f0-9]{7,64}$/i.test(git_commit)) {
    return { verified: false, reason: "git_commit must be a 7-64 character hexadecimal object id" };
  }
  const path = safeRepoPath(repo_path);
  if (!path) return { verified: false, reason: "repo_path must be a safe repository-relative path" };
  if (typeof content_checksum !== "string" || !/^[a-f0-9]{64}$/i.test(content_checksum)) {
    return { verified: false, reason: "content_checksum must be a SHA-256 hex digest" };
  }
  try {
    execFileSync("git", ["cat-file", "-e", `${git_commit}^{commit}`], {
      cwd: project.root,
      stdio: "ignore",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const reachable = project.allowed_refs.some((ref) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", git_commit, ref], {
          cwd: project.root,
          stdio: "ignore",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!reachable) return { verified: false, reason: "commit is not reachable from an allowed ref" };
    const contents = execFileSync("git", ["show", `${git_commit}:${path}`], {
      cwd: project.root,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== content_checksum.toLowerCase()) return { verified: false, reason: "repository content checksum does not match" };
    const excerpt = typeof body === "string" ? body.trim() : "";
    if (!excerpt || !contents.toString("utf8").includes(excerpt)) {
      return { verified: false, reason: "git-fact body must be an exact excerpt from the verified file" };
    }
    return { verified: true, reason: "commit, path, checksum and exact excerpt verified in configured project root" };
  } catch {
    return { verified: false, reason: "commit or path was not found in configured project root" };
  }
}

export class CapturePolicy {
  constructor(config = loadCapturePolicy(null)) {
    this.config = config;
  }

  evaluate(input, identity, vault) {
    const kind = input.memory_kind || "inference";
    if (!MEMORY_KINDS.has(kind)) throw new Error(`unsupported memory_kind: ${kind}`);
    const projectId = input.project_id ? requiredIdentifier(input.project_id, "project_id") : null;
    if (projectId && !identity.allowed_projects.includes(projectId)) {
      const error = new Error(`project ${projectId} is not allowed for this caller`);
      error.code = "FORBIDDEN";
      throw error;
    }
    const sensitivity = input.sensitivity || "private";
    if (!SENSITIVITIES.has(sensitivity) || !identity.allowed_sensitivities.includes(sensitivity)) {
      const error = new Error(`sensitivity ${sensitivity} is not allowed for this caller`);
      error.code = "FORBIDDEN";
      throw error;
    }
    const confidence = boundedNumber(input.confidence, 0.5, 0, 0.9, "confidence");
    const gitSubjectSymbol = input.symbol && typeof input.body === "string" && input.body.includes(input.symbol)
      ? input.symbol
      : "";
    const subjectKey = input.subject_key
      ? requiredIdentifier(input.subject_key, "subject_key")
      : kind === "git-fact" && input.repo_path
        ? `git:${createHash("sha256").update(`${input.repo_path}\u0000${gitSubjectSymbol}`).digest("hex")}`
        : null;
    const captureIdempotencyKey = input.idempotency_key
      ? `capture:${createHash("sha256").update([
        identity.tenant_id,
        identity.owner_id,
        identity.principal_id,
        identity.agent_id || identity.principal_id,
        projectId || "global",
        input.idempotency_key,
      ].join("\u0000")).digest("hex")}`
      : undefined;
    const base = {
      body: input.body,
      title: input.title,
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      agent_id: identity.agent_id || identity.principal_id,
      namespace_id: projectId ? `project/${projectId}` : "personal/global",
      project_id: projectId,
      type: kind,
      sensitivity: sensitivity === "public" ? "private" : sensitivity,
      confidence,
      importance: boundedNumber(input.importance, 0.5, 0, 0.75, "importance"),
      source_type: `agent-${kind}`,
      source_uri: null,
      repo_path: null,
      symbol: null,
      git_commit: null,
      branch: null,
      tags: input.tags,
      subject_key: subjectKey,
      idempotency_key: captureIdempotencyKey,
      observed_at: input.observed_at,
      metadata: {
        capture_policy: "risk-based-v1",
        originating_principal: identity.principal_id,
      },
    };

    const idempotentRetry = input.idempotency_key && vault.findByIdempotency({
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      namespace_id: base.namespace_id,
      agent_id: base.agent_id,
      idempotency_key: base.idempotency_key,
    });
    if (projectId && !idempotentRetry && vault.captureCount({
      tenant_id: identity.tenant_id,
      owner_id: identity.owner_id,
      agent_id: identity.agent_id || identity.principal_id,
      project_id: projectId,
    }) >= this.config.max_records_per_project_per_agent) {
      const error = new Error("capture quota exceeded for this agent and project");
      error.code = "FORBIDDEN";
      throw error;
    }

    if (["sensitive", "restricted"].includes(sensitivity)) {
      return { disposition: "quarantined", reason: "high-sensitivity agent capture requires review", record: base };
    }
    if (!projectId) {
      return { disposition: "proposed", reason: "global agent memory requires review", record: base };
    }
    if (subjectKey && vault.findActiveConflict({ ...base, subject_key: subjectKey })) {
      return { disposition: "quarantined", reason: "active memory with the same subject has different content", record: base };
    }
    if (kind === "decision") {
      return { disposition: "proposed", reason: "agent-observed decisions require review", record: base };
    }
    if (kind === "git-fact") {
      const git = verifyGitEvidence({
        project_id: projectId,
        git_commit: input.git_commit,
        repo_path: input.repo_path,
        content_checksum: input.content_checksum,
        body: input.body,
      }, this.config);
      if (git.verified) {
        const verifiedSymbol = input.symbol && input.body.includes(input.symbol) ? input.symbol : null;
        base.title = verifiedSymbol ? `${input.repo_path}:${verifiedSymbol}` : input.repo_path;
        base.source_type = "git-verified-agent";
        base.source_uri = `git://${projectId}@${input.git_commit}/${input.repo_path}`;
        base.repo_path = input.repo_path;
        base.symbol = verifiedSymbol;
        base.git_commit = input.git_commit;
        base.branch = null;
        base.metadata.git_content_sha256 = input.content_checksum.toLowerCase();
      } else {
        base.metadata.claimed_git = {
          repo_path: input.repo_path || null,
          symbol: input.symbol || null,
          git_commit: input.git_commit || null,
          branch: input.branch || null,
          content_checksum: input.content_checksum || null,
        };
      }
      if (git.verified) {
        return confidence >= this.config.auto_activate_confidence
          ? { disposition: "active", reason: git.reason, record: base }
          : { disposition: "proposed", reason: "confidence is below auto-activation threshold", record: base };
      }
      return git.reason === "project root is not configured"
        ? { disposition: "proposed", reason: git.reason, record: base }
        : { disposition: "quarantined", reason: git.reason, record: base };
    }
    if (kind === "working") {
      const requested = boundedNumber(input.ttl_seconds, this.config.working_ttl_seconds, 300, this.config.working_ttl_seconds, "ttl_seconds");
      base.expires_at = futureIso(requested);
      return { disposition: "active", reason: "project-scoped working memory with bounded TTL", record: base };
    }

    if (!subjectKey) {
      return { disposition: "proposed", reason: "durable inference requires a stable subject_key", record: base };
    }

    const requested = boundedNumber(input.ttl_seconds, this.config.inference_ttl_seconds, 3_600, this.config.inference_ttl_seconds, "ttl_seconds");
    base.expires_at = futureIso(requested);
    return confidence >= this.config.auto_activate_confidence
      ? { disposition: "active", reason: "high-confidence project inference with bounded TTL", record: base }
      : { disposition: "proposed", reason: "confidence is below auto-activation threshold", record: base };
  }
}
