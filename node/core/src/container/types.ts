export interface ContainerConfig {
  devcontainer: string;
  workspacePath: string;
  installCommand: string;
}

export interface ProvisionResult {
  containerName: string;
  tempDir: string;
  imageName: string;
  startSha: string;
}
