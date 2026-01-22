import fs from 'fs';
import path from 'path';
import { tool } from '@opencode-ai/plugin';

function getDefaultSlug(): string {
  return process.env.TASK_SLUG || '';
}

function defaultBaseDir(slug?: string): string {
  const resolvedSlug = typeof slug === 'string' ? slug : getDefaultSlug();
  return path.join(process.cwd(), '.panie-areczku', resolvedSlug);
}

type ResolveBaseDirArgs = {
  baseDir?: string;
  slug?: string;
};

function resolveBaseDir(args: ResolveBaseDirArgs = {}): string {
  const baseDir = args.baseDir || process.env.TASK_BASE_DIR || defaultBaseDir(args.slug);
  return path.resolve(baseDir);
}

function defaultTaskFilePath(baseDir?: string): string {
  return path.join(baseDir || defaultBaseDir(), 'tasks.json');
}

function defaultLogFilePath(baseDir?: string): string {
  return path.join(baseDir || defaultBaseDir(), 'task.log');
}

function defaultPrdFilePath(baseDir?: string): string {
  return path.join(baseDir || defaultBaseDir(), 'PRD.md');
}
const VALID_STATUS_LIST = ['todo', 'doing', 'done', 'blocked', 'failed'] as const;
const VALID_STATUSES = new Set(VALID_STATUS_LIST);

type TaskStatus = (typeof VALID_STATUS_LIST)[number];

type ResolvePathsArgs = {
  taskFilePath?: string;
  logFilePath?: string;
  baseDir?: string;
  slug?: string;
};

type ResolvePrdPathArgs = {
  prdFilePath?: string;
  baseDir?: string;
  slug?: string;
};

type TaskRecord = {
  id?: string;
  status?: TaskStatus;
  summary?: string;
  updatedAt?: string;
  retries?: number;
  [key: string]: unknown;
};

type TaskFileData = {
  version?: number;
  statuses?: TaskStatus[];
  tasks?: Array<TaskRecord | null>;
  [key: string]: unknown;
};

function resolvePaths(args: ResolvePathsArgs = {}): { taskFilePath: string; logFilePath: string } {
  const baseDir = resolveBaseDir({ baseDir: args.baseDir, slug: args.slug });
  const prefersBaseDir = Boolean(args.baseDir || args.slug);
  const defaultTaskPath = defaultTaskFilePath(baseDir);
  const defaultLogPath = defaultLogFilePath(baseDir);
  const taskFilePath =
    args.taskFilePath ||
    (prefersBaseDir ? defaultTaskPath : process.env.TASK_FILE_PATH || defaultTaskPath);
  const logFilePath =
    args.logFilePath || (prefersBaseDir ? defaultLogPath : process.env.TASK_LOG_FILE_PATH || defaultLogPath);
  return {
    taskFilePath: path.resolve(taskFilePath),
    logFilePath: path.resolve(logFilePath),
  };
}

function resolvePrdPath(args: ResolvePrdPathArgs = {}): string {
  const baseDir = resolveBaseDir({ baseDir: args.baseDir, slug: args.slug });
  const prefersBaseDir = Boolean(args.baseDir || args.slug);
  const defaultPrdPath = defaultPrdFilePath(baseDir);
  const prdFilePath =
    args.prdFilePath ||
    (prefersBaseDir ? defaultPrdPath : process.env.PRD_FILE_PATH || defaultPrdPath);
  return path.resolve(prdFilePath);
}

function readTasksFile(taskFilePath: string): TaskFileData {
  try {
    const raw = fs.readFileSync(taskFilePath, 'utf8');
    const data = JSON.parse(raw || '{}') as TaskFileData;
    if (!Array.isArray(data.tasks)) return { tasks: [] };
    return data;
  } catch {
    return { tasks: [] };
  }
}

function writeTasksFile(taskFilePath: string, data: TaskFileData): void {
  const payload = {
    version: data.version || 1,
    statuses: data.statuses || Array.from(VALID_STATUSES),
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
  };
  fs.mkdirSync(path.dirname(taskFilePath), { recursive: true });
  fs.writeFileSync(taskFilePath, JSON.stringify(payload, null, 2));
}

function appendLog(logFilePath: string, entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  fs.appendFileSync(logFilePath, line);
}

function getNextTaskInternal(taskFilePath: string): TaskRecord | null {
  const data = readTasksFile(taskFilePath);
  const next = (data.tasks || []).find((task) => task && task.status === 'todo');
  return next || null;
}

function updateTaskStatusInternal(
  taskFilePath: string,
  logFilePath: string,
  id: string,
  status: TaskStatus,
  summary = ''
): TaskRecord {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}. Allowed: ${Array.from(VALID_STATUSES).join(', ')}`);
  }
  const data = readTasksFile(taskFilePath);
  const tasks = data.tasks || [];
  const idx = tasks.findIndex((task) => task && task.id === id);
  if (idx === -1) {
    throw new Error(`Task with id '${id}' not found in ${taskFilePath}`);
  }
  const now = new Date().toISOString();
  const existing = tasks[idx] as TaskRecord;
  const updated = {
    ...existing,
    status,
    summary: summary || existing.summary || '',
    updatedAt: now,
    retries: typeof existing.retries === 'number' ? existing.retries : 0,
  };
  tasks[idx] = updated;
  writeTasksFile(taskFilePath, { ...data, tasks });
  appendLog(logFilePath, `${id} -> ${status} :: ${summary || 'no summary'} [${now}]`);
  return updated;
}

function incrementRetriesInternal(taskFilePath: string, logFilePath: string, id: string): number {
  const data = readTasksFile(taskFilePath);
  const tasks = data.tasks || [];
  const idx = tasks.findIndex((task) => task && task.id === id);
  if (idx === -1) {
    throw new Error(`Task with id '${id}' not found in ${taskFilePath}`);
  }
  const existing = tasks[idx] as TaskRecord;
  const retries = (existing.retries || 0) + 1;
  tasks[idx] = { ...existing, retries };
  writeTasksFile(taskFilePath, { ...data, tasks });
  appendLog(logFilePath, `${id} retries=${retries}`);
  return retries;
}

function ensureTaskFile(taskFilePath: string): void {
  if (!fs.existsSync(taskFilePath)) {
    writeTasksFile(taskFilePath, { version: 1, tasks: [] });
    return;
  }
  const data = readTasksFile(taskFilePath);
  if (!Array.isArray(data.tasks)) {
    writeTasksFile(taskFilePath, { version: 1, tasks: [] });
  }
}

export const getNextTask = tool({
  description: 'Get the next todo task from a tasks list.',
  args: {
    taskFilePath: tool.schema.string().optional().describe('Path to tasks.json'),
    logFilePath: tool.schema.string().optional().describe('Path to log file'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const { taskFilePath } = resolvePaths(args);
    ensureTaskFile(taskFilePath);
    const task = getNextTaskInternal(taskFilePath);
    return JSON.stringify(task ?? null, null, 2);
  },
});

export const updateTaskStatus = tool({
  description: 'Update a task status in a tasks list.',
  args: {
    id: tool.schema.string().describe('Task id'),
    status: tool.schema.enum(VALID_STATUS_LIST).describe('New status'),
    summary: tool.schema.string().optional().describe('Optional summary'),
    taskFilePath: tool.schema.string().optional().describe('Path to tasks.json'),
    logFilePath: tool.schema.string().optional().describe('Path to log file'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const { taskFilePath, logFilePath } = resolvePaths(args);
    ensureTaskFile(taskFilePath);
    const updated = updateTaskStatusInternal(
      taskFilePath,
      logFilePath,
      args.id,
      args.status,
      args.summary || ''
    );
    return JSON.stringify(updated, null, 2);
  },
});

export const incrementRetries = tool({
  description: 'Increment retries counter for a task.',
  args: {
    id: tool.schema.string().describe('Task id'),
    taskFilePath: tool.schema.string().optional().describe('Path to tasks.json'),
    logFilePath: tool.schema.string().optional().describe('Path to log file'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const { taskFilePath, logFilePath } = resolvePaths(args);
    ensureTaskFile(taskFilePath);
    const retries = incrementRetriesInternal(taskFilePath, logFilePath, args.id);
    return JSON.stringify({ id: args.id, retries }, null, 2);
  },
});

export const TASK_FILE = tool({
  description: 'Return the tasks.json path.',
  args: {
    taskFilePath: tool.schema.string().optional().describe('Path to tasks.json'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const { taskFilePath } = resolvePaths(args);
    return taskFilePath;
  },
});

export const LOG_FILE = tool({
  description: 'Return the task manager log path.',
  args: {
    logFilePath: tool.schema.string().optional().describe('Path to log file'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const { logFilePath } = resolvePaths(args);
    return logFilePath;
  },
});

export const PRD_FILE = tool({
  description: 'Return the PRD.md path.',
  args: {
    prdFilePath: tool.schema.string().optional().describe('Path to PRD.md'),
    baseDir: tool.schema.string().optional().describe('Base directory for task artifacts'),
    slug: tool.schema.string().optional().describe('Slug for .panie-areczku/<slug>'),
  },
  async execute(args) {
    const prdFilePath = resolvePrdPath(args);
    return prdFilePath;
  },
});
