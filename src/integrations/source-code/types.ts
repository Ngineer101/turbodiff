export interface RepositoryTreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
  size: number | null;
  sha: string;
}

export interface RepositoryTreeResult {
  path: string;
  entries: RepositoryTreeEntry[];
}

export interface RepositoryFileResult {
  path: string;
  ref: string;
  sha: string;
  size: number;
  text: string | null;
  binary: boolean;
  too_large: boolean;
  content_base64: string | null;
}

export interface SaveRepositoryFileResult {
  ok: boolean;
  content_sha: string;
  commit_sha: string;
  branch: string;
  pr: { number: number; url: string } | null;
}
