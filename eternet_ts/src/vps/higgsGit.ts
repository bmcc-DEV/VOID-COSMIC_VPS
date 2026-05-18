/**
 * HiggsGit — versionamento de workers WASM (stub)
 */

export interface HiggsCommit {
  id: string;
  message: string;
  phase: "accumulate" | "superposition" | "collapse";
  wasmHash: string;
}

export interface ScarToken {
  token: string;
  mergeCommit: string;
  authorizedDeploy: boolean;
}

export class HiggsGit {
  private commits: HiggsCommit[] = [];
  private branches = new Map<string, HiggsCommit[]>();

  constructor(readonly repoName: string, readonly fieldStrength = 0.8) {}

  init(): void {
    this.commits = [];
    this.branches.clear();
  }

  commit(message: string, wasmHash: string, phase: HiggsCommit["phase"] = "accumulate"): HiggsCommit {
    const c: HiggsCommit = {
      id: `hg_${this.commits.length}`,
      message,
      phase,
      wasmHash,
    };
    this.commits.push(c);
    return c;
  }

  branch(name: string): void {
    this.branches.set(name, [...this.commits]);
  }

  merge(branchName: string, collapseThreshold = 0.75): ScarToken {
    const branch = this.branches.get(branchName) ?? [];
    this.commits.push(...branch);
    const token = `scar_${Date.now().toString(16)}`;
    return {
      token,
      mergeCommit: this.commits[this.commits.length - 1]?.id ?? "",
      authorizedDeploy: collapseThreshold <= 1.0,
    };
  }
}
