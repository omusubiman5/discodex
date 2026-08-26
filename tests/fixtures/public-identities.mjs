function discordId(offset) {
  return ((10n ** 17n) + BigInt(offset)).toString();
}

function codexTaskId(offset) {
  return ["01abcdef", "0000", "4000", "8000", String(offset).padStart(12, "0")].join("-");
}

export const TEST_DISCORD_ID_1 = discordId(1);
export const TEST_DISCORD_ID_2 = discordId(2);
export const TEST_DISCORD_ID_3 = discordId(3);
export const TEST_DISCORD_ID_4 = discordId(4);
export const TEST_DISCORD_ID_5 = discordId(5);
export const TEST_DISCORD_ID_6 = discordId(6);
export const TEST_DISCORD_ID_7 = discordId(7);
export const TEST_DISCORD_ID_8 = discordId(8);
export const TEST_DISCORD_ID_9 = discordId(9);
export const TEST_DISCORD_ID_10 = discordId(10);

export const TEST_CODEX_TASK_ID_1 = codexTaskId(1);
export const TEST_CODEX_TASK_ID_2 = codexTaskId(2);
export const TEST_CODEX_TASK_ID_3 = codexTaskId(3);
