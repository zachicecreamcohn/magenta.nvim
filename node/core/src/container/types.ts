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
}
