export interface CredentialLease {
  use<T>(consumer: (credential: string) => Promise<T>): Promise<T>;
  dispose(): void;
}

export interface BotCredentialProvider {
  readonly storage: "windows-credential-manager" | "macos-keychain" | "development-environment";
  acquire(): Promise<CredentialLease>;
}

export class EnvironmentCredentialProvider implements BotCredentialProvider {
  readonly storage = "development-environment" as const;
  readonly #variableName: string;

  constructor(variableName = "CODEX_BRIDGE_DISCORD_BOT_TOKEN") {
    this.#variableName = variableName;
  }

  async acquire(): Promise<CredentialLease> {
    const credential = process.env[this.#variableName];
    if (!credential) throw new Error(`${this.#variableName} is not set in this process.`);
    let disposed = false;
    return {
      async use<T>(consumer: (value: string) => Promise<T>): Promise<T> {
        if (disposed) throw new Error("Credential lease is disposed.");
        return consumer(credential);
      },
      dispose(): void {
        disposed = true;
      },
    };
  }
}
