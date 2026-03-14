export interface ContainerConfig {
  dockerfile: string;
  workspacePath: string;
  installCommand?: string;
}

export interface ProvisionResult {
  containerName: string;
  tempDir: string;
  imageName: string;
  startSha: string;
  workerBranch: string;
}

export interface TeardownResult {
  workerBranch: string;
  baseBranch: string;
  commitCount: number;
}
