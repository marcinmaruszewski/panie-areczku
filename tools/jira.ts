import { tool } from "@opencode-ai/plugin/tool";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "created",
  "updated",
  "comment"
];

type OutputFormat = "table" | "json" | "text";

type JiraAuth = {
  token: string;
  email?: string;
};

type JiraBase = {
  baseUrl: URL;
  origin: string;
};

type JiraComment = {
  author: string;
  created: string;
  body: string;
};

export type JiraIssueSummary = {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  reporter: string;
  priority: string;
  created: string;
  updated: string;
  url: string;
  comments: JiraComment[];
};

function parseJiraIssueUrl(issueUrl: string): { origin: string; issueKey: string } {
  const parsed = new URL(issueUrl);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const browseIdx = parts.findIndex((p) => p.toLowerCase() === "browse");
  if (browseIdx === -1 || !parts[browseIdx + 1]) {
    throw new Error("URL must contain /browse/{ISSUE-KEY}");
  }
  return { origin: parsed.origin, issueKey: parts[browseIdx + 1] };
}

function resolveBaseFromEnv(): JiraBase {
  const raw = process.env.JIRA_BASE_URL;
  if (!raw) {
    throw new Error("Set JIRA_BASE_URL env var, e.g. https://company.atlassian.net");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(raw);
  } catch {
    throw new Error("JIRA_BASE_URL must be a valid absolute URL");
  }

  if (baseUrl.username || baseUrl.password) {
    throw new Error("JIRA_BASE_URL must not include credentials");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("JIRA_BASE_URL must use https");
  }
  if (baseUrl.search || baseUrl.hash) {
    throw new Error("JIRA_BASE_URL must not include query params or hash");
  }

  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }

  return { baseUrl, origin: baseUrl.origin };
}

function resolveAuthFromEnv(): JiraAuth {
  const token = process.env.JIRA_API_TOKEN;
  if (!token) {
    throw new Error("Set JIRA_API_TOKEN env var with your API token");
  }
  return { token, email: process.env.JIRA_EMAIL };
}

function buildAuthHeader(auth: JiraAuth): string {
  if (auth.email) {
    const encoded = Buffer.from(`${auth.email}:${auth.token}`, "utf8").toString("base64");
    return `Basic ${encoded}`;
  }
  return `Bearer ${auth.token}`;
}

function buildFieldsParam(fieldsArg?: string): string {
  if (!fieldsArg || fieldsArg.trim().length === 0) {
    return DEFAULT_FIELDS.join(",");
  }
  const cleaned = fieldsArg
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const unique = Array.from(new Set([...cleaned, ...DEFAULT_FIELDS]));
  return unique.join(",");
}

function pickCommentBody(comment: any): string {
  if (typeof comment?.renderedBody === "string") return comment.renderedBody;
  if (typeof comment?.body === "string") return comment.body;
  return "";
}

function formatCommentBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  const limit = 400;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function formatSummary(summary: JiraIssueSummary, format: OutputFormat): any {
  if (format === "json") return summary;
  const commentLines = summary.comments.map((c) => `- [${c.author} @ ${c.created}] ${formatCommentBody(c.body)}`);

  if (format === "text") {
    return [
      `Key: ${summary.key}`,
      `Summary: ${summary.summary}`,
      `Status: ${summary.status}`,
      `Assignee: ${summary.assignee}`,
      `Reporter: ${summary.reporter}`,
      `Priority: ${summary.priority}`,
      `Created: ${summary.created}`,
      `Updated: ${summary.updated}`,
      `URL: ${summary.url}`,
      "Comments:",
      ...commentLines
    ].join("\n");
  }

  const rows: Array<[string, string]> = [
    ["Key", summary.key],
    ["Summary", summary.summary],
    ["Status", summary.status],
    ["Assignee", summary.assignee],
    ["Reporter", summary.reporter],
    ["Priority", summary.priority],
    ["Created", summary.created],
    ["Updated", summary.updated],
    ["URL", summary.url]
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const table = rows.map(([label, value]) => `${label.padEnd(labelWidth)} : ${value || "-"}`).join("\n");
  const commentsBlock = commentLines.length ? `\nComments:\n${commentLines.join("\n")}` : "\nComments: none";
  return `${table}${commentsBlock}`;
}

export default tool({
  description: "Fetch a JIRA issue summary from its URL",
  args: {
    issueUrl: tool.schema.string().url().describe("Full JIRA issue URL, e.g. https://company.atlassian.net/browse/KEY-123"),
    fields: tool.schema.string().optional().describe("Comma-separated fields to include; defaults plus provided"),
    format: tool.schema.enum(["table", "json", "text"]).optional().describe("Output format: table (default), json, or text"),
    timeoutMs: tool.schema.number().int().positive().optional().describe("Request timeout in milliseconds (default 15000)"),
    commentsLimit: tool.schema.number().int().positive().max(100).optional().describe("Max comments to include (default 20)"),
    debug: tool.schema.boolean().optional().describe("Log the outgoing JIRA API request details")
  },
  async execute({ issueUrl, fields, format = "table", timeoutMs, commentsLimit, debug }) {
    const { origin: issueOrigin, issueKey } = parseJiraIssueUrl(issueUrl);
    const { baseUrl, origin } = resolveBaseFromEnv();
    const auth = resolveAuthFromEnv();
    const params = buildFieldsParam(fields);
    const controller = new AbortController();
    const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 15000;
    const limit = typeof commentsLimit === "number" && commentsLimit > 0 ? commentsLimit : 20;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      if (issueOrigin !== origin) {
        throw new Error(`Issue URL host (${issueOrigin}) does not match JIRA_BASE_URL (${origin})`);
      }

      const apiUrl = new URL(`rest/api/3/issue/${encodeURIComponent(issueKey)}`, baseUrl);
      apiUrl.searchParams.set("fields", params);
      apiUrl.searchParams.set("expand", "renderedFields");
      if (debug) {
        console.log(`[jira-summary] GET ${apiUrl.toString()}`);
      }

      const res = await fetch(apiUrl, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: buildAuthHeader(auth),
          Accept: "application/json"
        },
        signal: controller.signal
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const detail = body ? `: ${body}` : "";
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Auth failed (status ${res.status})${detail}`);
        }
        if (res.status === 404) {
          throw new Error(`Issue not found: ${issueKey}`);
        }
        if (res.status === 429) {
          throw new Error(`Rate limited by JIRA (429)${detail}`);
        }
        throw new Error(`JIRA request failed with status ${res.status}${detail}`);
      }

      const body = (await res.json()) as any;
      const commentsRaw: any[] = body.renderedFields?.comment?.comments ?? body.fields?.comment?.comments ?? [];
      const comments = commentsRaw.slice(0, limit).map((c) => ({
        author: c?.author?.displayName ?? "",
        created: c?.created ?? "",
        body: pickCommentBody(c)
      }));

      const summary: JiraIssueSummary = {
        key: body.key,
        summary: body.fields?.summary ?? "",
        status: body.fields?.status?.name ?? "",
        assignee: body.fields?.assignee?.displayName ?? "",
        reporter: body.fields?.reporter?.displayName ?? "",
        priority: body.fields?.priority?.name ?? "",
        created: body.fields?.created ?? "",
        updated: body.fields?.updated ?? "",
        url: `${origin}/browse/${body.key}`,
        comments
      };

      return formatSummary(summary, format);
    } finally {
      clearTimeout(timer);
    }
  }
});
