<img src="assets/icon.svg" width="64" height="64" alt="">

# OpenClaw iOS reply alerts

A plugin for the [OpenClaw](https://docs.openclaw.ai) Gateway. It sends a notification to your **iPhone or iPad** when the agent has finished replying in a conversation you started in the OpenClaw app or the web Dashboard.

You can send a message, put your phone away, and get a notification when the answer is ready.

- It only alerts for **your own** app and web conversations.
- It does **not** alert for Telegram or other chat channels, heartbeats, scheduled jobs, sub-agents, cancelled or failed runs, or replies with no visible text.
- Each iPhone and iPad is **off** until you switch it on.
- The alert text is generic by default: **OpenClaw** / **Your reply is ready.** You can choose to show the conversation name and the start of the reply instead.

> **Status:** tested by hand on one Gateway (OpenClaw 2026.11.6) with one iPhone and one iPad, and covered by automated tests. It works only on a Gateway where **one person** owns every paired device. See [docs/status.md](docs/status.md).

## Installation guide

### What you need

- An OpenClaw Gateway, version 2026.11.6 or newer, running on your computer.
- Node.js 24 or newer, and `git`. The `jq` tool helps in step 3, but it is optional.
- The OpenClaw app on your iPhone or iPad, already paired with this Gateway. Notifications must be allowed for the app.
- A web browser that can open the Gateway's Dashboard over **HTTPS** (for example Tailscale Serve) or on **localhost** (`http://127.0.0.1:18789/`).
- You are the only person who pairs devices with this Gateway.

### Step 1: Download and build

```sh
git clone https://github.com/shapeless-space/openclaw-ios-push.git
cd openclaw-ios-push
npm ci
npm run build
npm prune --omit=dev
```

The last command removes the build tools, so the copy that OpenClaw makes stays small.

### Step 2: Install the plugin

```sh
openclaw plugins install . --force
```

OpenClaw will say that the plugin is **not enabled yet**. That is expected, because it needs settings first. If it asks for capability consent instead, run the same command again with `--accept-capabilities` added.

### Step 3: Give the plugin its own key

The plugin talks to the Gateway with its own paired identity. This identity can only read and write. It cannot change settings or pair devices. The plugin config does not hold any password or token.

First, find the path of the OpenClaw CLI. Run `openclaw gateway status` and find the line that starts with `CLI version`. It ends with a path like `.../node_modules/openclaw/dist/entry.js`. Your CLI path is the same, but ending in `openclaw.mjs` instead of `dist/entry.js`.

Then run this, with your CLI path:

```sh
OPENCLAW_GATEWAY_TOKEN="$(jq -r .gateway.auth.token ~/.openclaw/openclaw.json)" \
  node scripts/pair-cli-identity.mjs \
  --cli /path/to/node_modules/openclaw/openclaw.mjs \
  --identity-dir ~/.openclaw/plugin-state/ios-reply-alerts/cli-identity
```

Without `jq`, replace the first line with `OPENCLAW_GATEWAY_TOKEN="<your Gateway token>" \`.

The script uses your Gateway token once, only to pair. It does not save that token. At the end it should print `node.list: ok   admin method: refused (good)`.

### Step 4: Find your profile id

```sh
openclaw users list
```

Pick the profile that your iPhone and iPad use. If your phone connects through Tailscale Serve, it is usually the long id, not `gateway-owner`. If you pick the wrong one, the Reply alerts page in step 7 will say that no iPhone or iPad belongs to you. In that case, try the other profile.

### Step 5: Add the settings

Replace the three paths and the profile id with your own values. Use full paths, not `~`.

```sh
openclaw config set plugins.entries.ios-reply-alerts.config '{
  "stateDir": "/Users/you/.openclaw/plugin-state/ios-reply-alerts/state",
  "owner": { "profileId": "<your profile id>" },
  "gateway": {
    "cliPath": "/path/to/node_modules/openclaw/openclaw.mjs",
    "url": "ws://127.0.0.1:18789",
    "identityDir": "/Users/you/.openclaw/plugin-state/ios-reply-alerts/cli-identity"
  }
}' --strict-json
```

### Step 6: Let the plugin see where a message came from

```sh
openclaw config set plugins.entries.ios-reply-alerts.hooks.allowConversationAccess true --strict-json
openclaw plugins enable ios-reply-alerts
```

OpenClaw says where a turn came from (app, web or Telegram) only to plugins that have this permission. With it, OpenClaw also passes the conversation's messages to the plugin. The plugin does not read, keep or log those messages. It reads only the channel, the trigger, and the source of the input.

### Step 7: Switch alerts on for your iPhone and iPad

1. Open the Gateway's **Dashboard** in a web browser. Use HTTPS or localhost; plugin pages do not load over plain HTTP on a network address.
2. Open the **Reply alerts** page. It is hidden at first: add it to the menu with **Customize**.
3. You will see your iPhone and iPad. Turn on the ones you want.

The OpenClaw iOS app's Settings screen cannot show plugin pages, so use the web Dashboard for this step.

### Step 8: Try it

1. On your iPhone, send a message in the OpenClaw app, for example "Write three sentences about the sea."
2. Wait until the agent starts working, then switch to another app or lock the screen.
3. When the reply is ready, every device that you switched on gets an alert.

## Show the conversation name and reply (optional)

```sh
openclaw config set plugins.entries.ios-reply-alerts.config.alert '{"content":"preview"}' --strict-json
```

The alert title becomes the conversation's name. The text becomes the start of the reply, up to 180 characters. Keep in mind:

- The preview shows on your lock screen.
- It travels through Apple's push service.
- To go back, set `"content": "generic"`.

## If it does not work

Turn on the troubleshooting log, try again, and look at the lines from the plugin:

```sh
openclaw config set plugins.entries.ios-reply-alerts.config.logEvidenceShape true --strict-json
openclaw logs --plain --limit 400 | grep "ios-reply-alerts:"
```

The log shows only short codes and field names, never message text. Common codes:

| Code | What it means | What to do |
| --- | --- | --- |
| `submitted-accepted` | Apple accepted the alert. | Check notification settings on the device. |
| `not-opted-in` | That device is switched off. | Switch it on (step 7). |
| `owner-has-no-devices` | The conversation's owner has no iPhone or iPad here. | Check the profile id (step 4). |
| `origin-missing` | OpenClaw did not tell the plugin where the turn came from. | Do step 6, then `openclaw plugins reload ios-reply-alerts`. |
| `ineligible-channel` | The turn came from Telegram or another channel. | This is expected. |
| `not-user-turn` | A heartbeat, a scheduled job or a relayed message. | This is expected. |
| `child-run` | Sub-agent work. | This is expected. |

Turn the log off again with `logEvidenceShape false`.

## Turn it off or remove it

```sh
openclaw plugins disable ios-reply-alerts        # stop alerts, keep the settings
openclaw plugins uninstall ios-reply-alerts      # remove the plugin
openclaw devices list                            # find the plugin's identity ("openclaw-tui")
openclaw devices remove <device id>              # remove that identity
```

## Privacy

- With the default setting, the alert has no message text.
- The plugin stores only which devices are switched on, and a record of alerts it has sent. That record holds hashed ids, never text.
- The log has only codes.
- Only you can see and switch your own devices. Another person on the Gateway sees none of them.

## For developers

```sh
npm install
npm run verify   # type check, tests, build
```

- `src/reply-alerts.ts`: the rules. It covers eligibility, per-device consent, the durable send ledger, viewing suppression and the final check before sending.
- `src/host/openclaw-adapter.ts`: reads what the Gateway reports. The origin comes from the `agent_end` hook context. The final state comes from the lifecycle `end` event. The owner comes from the session entry.
- `src/host/gateway-cli.ts`, `cli-push-transport.ts`, `cli-device-directory.ts`: talk to the Gateway as the plugin's own identity (`push.test`, `node.list`).
- `src/plugin.ts`: connects it all to the host. It adds the methods `replyAlerts.devices.list`, `replyAlerts.device.get` and `replyAlerts.device.set`.
- `dist/control-ui/index.js`: the Reply alerts page. It is plain JavaScript with no build step.
- `scripts/pair-cli-identity.mjs`: step 3.

The tests use a fake host, a stub CLI and a fake DOM. They never contact a real Gateway, Apple, a phone or a tablet.

## License

[MIT](LICENSE)
