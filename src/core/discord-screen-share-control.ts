export type DiscordScreenShareAction = "start" | "stop";

export interface FixedTaskPromptRunner {
  streamChat(messages: readonly { readonly role: "user"; readonly content: string }[], options?: { readonly signal?: AbortSignal }): AsyncIterable<string>;
}

const SUCCESS_MARKERS: Readonly<Record<DiscordScreenShareAction, string>> = {
  start: "DISCODEX_SCREEN_SHARE_STARTED",
  stop: "DISCODEX_SCREEN_SHARE_STOPPED",
};

export function discordScreenSharePrompt(action: DiscordScreenShareAction): string {
  const operation = action === "start"
    ? [
        "公式Discordデスクトップアプリを前面にし、現在参加中の音声チャンネルの画面共有アイコンを押してください。",
        "共有対象は現在のCodex作業画面を一つだけ選び、公式UIのGo Liveを押してください。",
        "Discord UIで配信中表示を確認できた場合だけ、最後の行に DISCODEX_SCREEN_SHARE_STARTED と出力してください。",
      ]
    : [
        "公式Discordデスクトップアプリを前面にし、現在の画面共有だけを公式UIから停止してください。",
        "Discordの音声接続、Discodex runner、Codex音声通話は停止しないでください。",
        "Discord UIで配信終了を確認できた場合だけ、最後の行に DISCODEX_SCREEN_SHARE_STOPPED と出力してください。",
      ];
  return [
    "Discodex Relayの利用者が明示的に画面共有操作を押しました。",
    ...operation,
    "独自映像配信、Discord Activity、self-bot、非公開API、コード変更、設定変更は行わないでください。",
    "Discordアプリ、対象voice channel、共有対象を一意に確認できない場合は操作せず、最後の行に DISCODEX_SCREEN_SHARE_BLOCKED と出力してください。",
  ].join("\n");
}

export async function runDiscordScreenShareAction(
  action: DiscordScreenShareAction,
  runner: FixedTaskPromptRunner,
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly action: DiscordScreenShareAction; readonly status: "confirmed" | "blocked" }> {
  let response = "";
  for await (const chunk of runner.streamChat([{ role: "user", content: discordScreenSharePrompt(action) }], { signal })) {
    response += chunk;
    if (response.length > 16_384) response = response.slice(-16_384);
  }
  return {
    ok: response.includes(SUCCESS_MARKERS[action]),
    action,
    status: response.includes(SUCCESS_MARKERS[action]) ? "confirmed" : "blocked",
  };
}
