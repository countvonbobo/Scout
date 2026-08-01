import path from 'node:path';

export function workspacePaths(root) {
  const workspaceRoot = path.resolve(root);
  return Object.freeze({
    root: workspaceRoot,
    config: path.join(workspaceRoot, 'workspace.json'),
    env: path.join(workspaceRoot, '.env'),
    tracker: path.join(workspaceRoot, 'data', 'opportunities.json'),
    scanRuns: path.join(workspaceRoot, 'data', 'scan-runs.jsonl'),
    categories: path.join(workspaceRoot, 'data', 'search-categories.json'),
    searchLanes: path.join(workspaceRoot, 'data', 'search-lanes.json'),
    portals: path.join(workspaceRoot, 'data', 'ats-portals.json'),
    employers: path.join(workspaceRoot, 'data', 'employers.json'),
    feedbackLearning: path.join(workspaceRoot, 'data', 'feedback-learning.json'),
    sources: path.join(workspaceRoot, 'data', 'sources.md'),
    reports: path.join(workspaceRoot, 'reports'),
    applications: path.join(workspaceRoot, 'applications'),
    profile: path.join(workspaceRoot, 'profile'),
    profileContext: path.join(workspaceRoot, 'profile', 'context.md'),
    searchProfileRaw: path.join(workspaceRoot, 'profile', 'search', 'raw.json'),
    searchProfileDraft: path.join(workspaceRoot, 'profile', 'search', 'draft.json'),
    searchProfilePublished: path.join(workspaceRoot, 'profile', 'search', 'published.json'),
    cv: path.join(workspaceRoot, 'cv'),
    imports: path.join(workspaceRoot, 'imports'),
    logs: path.join(workspaceRoot, 'logs'),
    backups: path.join(workspaceRoot, '.scout', 'backups'),
    runs: path.join(workspaceRoot, '.scout', 'runs'),
  });
}
