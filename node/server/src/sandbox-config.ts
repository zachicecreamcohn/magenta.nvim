export type OnUnknownHostBehavior = "prompt" | "allow" | "deny";

export type SandboxConfig = {
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
    onUnknownHost: OnUnknownHostBehavior;
  };
  requireApprovalPatterns: string[];
  strace: {
    autoAllowViolations: boolean;
  };
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  filesystem: {
    allowWrite: ["./"],
    denyWrite: [".env", ".git/hooks/", ".magenta", "~/.magenta"],
    denyRead: [
      // Credentials and keys (literal paths → subpath matching blocks dir + all contents)
      "~/.ssh",
      "~/.gnupg",
      "~/.aws",
      "~/.azure",
      "~/.config/gcloud",
      "~/.docker",
      "~/.kube",
      "~/.password-store",
      "~/.netrc",
      "~/.npmrc",
      "~/.pypirc",
      "~/.gem",
      "~/.config/gh",
      // Shell configs (can execute code on shell startup)
      "~/.bashrc",
      "~/.bash_profile",
      "~/.bash_login",
      "~/.bash_logout",
      "~/.zshrc",
      "~/.zprofile",
      "~/.zshenv",
      "~/.zlogin",
      "~/.zlogout",
      "~/.profile",
      "~/.config/fish",
    ],
    allowRead: [],
  },
  network: {
    allowedDomains: [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "pypi.org",
      "files.pythonhosted.org",
      "rubygems.org",
      "crates.io",
    ],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    onUnknownHost: "prompt",
  },
  requireApprovalPatterns: ["git\\s+push"],
  strace: {
    autoAllowViolations: false,
  },
};
