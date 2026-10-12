export type Content = {
  kind: 'text' | 'binary' | 'large' | 'submodule' | 'symlink';
  text?: string;
  hash?: string;
  size: number;
};
export type ChangedFile = {
  path: string;
  oldPath: string;
  status: string;
  left: Content | null;
  right: Content | null;
};
export type Comparison = {
  id: string;
  reviewId: string;
  provider: string;
  createdAt: number;
  left: string;
  right: string;
  selection: { left: string; right: string; mode: string };
  files: ChangedFile[];
};
export type Review = {
  id: string;
  title: string;
  description: string;
  source: 'vcs' | 'files';
  provider: string;
  repo: string;
  status: 'in_progress' | 'completed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  latestSequence: number;
};
export type Anchor = {
  comparisonId: string;
  provider: string;
  path: string;
  oldPath: string;
  side: 'left' | 'right' | 'file';
  startLine?: number;
  endLine?: number;
  contentHash?: string;
  selectedText?: string;
  context?: string;
  leftRevision: string;
  rightRevision: string;
};
export type Comment = {
  id: string;
  reviewId: string;
  body: string;
  status: 'open' | 'resolved';
  anchor: Anchor;
  createdAt: number;
  updatedAt: number;
};
export type Provider = {
  id: string;
  kind: string;
  enabled: boolean;
  builtin?: boolean;
  error?: string;
};
export type Assets = {
  grammars: { id: string; extensions: string[]; value: Record<string, unknown> }[];
  themes: { id: string; value: Record<string, unknown> }[];
  errors: { id: string; message: string }[];
};
export type Token = { content: string; color?: string };
export type DiffRow = {
  left?: { line: number; text: string; tokens?: Token[] };
  right?: { line: number; text: string; tokens?: Token[] };
  kind: 'equal' | 'change';
  /** Original aligned row index, stable across folding and unified rendering. */
  sourceIndex?: number;
  gap?: number;
  gapEnd?: number;
};
export type RowRange = { start: number; end: number };
export type LineStats = { added: number; deleted: number };
export type Draft = {
  id?: string;
  comparisonId: string;
  path: string;
  side: 'left' | 'right' | 'file';
  startLine?: number;
  endLine?: number;
  body: string;
  status?: string;
};
