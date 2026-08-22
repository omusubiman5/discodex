export const DAVE_POLICY = Object.freeze({
  required: true,
  minimumVoiceGatewayVersion: 8,
  preferredProvider: "discord/libdave",
  allowCustomCryptography: false,
  allowUnencryptedFallback: false,
  persistKeyMaterial: false,
  evaluationStatus: "build-and-integration-spike-required",
});

export function assertDaveConfig(provider: string, gatewayVersion: number): void {
  if (provider !== DAVE_POLICY.preferredProvider) {
    throw new Error("Only the official discord/libdave provider is approved for evaluation.");
  }
  if (gatewayVersion !== DAVE_POLICY.minimumVoiceGatewayVersion) {
    throw new Error("Discord Voice Gateway v8 is required for DAVE.");
  }
}
