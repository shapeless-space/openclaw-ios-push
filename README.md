<img src="assets/icon.svg" width="64" height="64" alt="">

# OpenClaw iOS reply alerts

A plugin for the [OpenClaw](https://docs.openclaw.ai) Gateway. It sends an alert to your iPhone or iPad when the agent finishes a reply in a conversation you started in the OpenClaw app or the web Dashboard. Send a message, put your phone away, and get an alert when the reply is ready.

- Alerts come only from your own app and web conversations.
- There is no alert for:
  - Telegram and other chat channels
  - heartbeats (the agent's automatic check-ins) and scheduled jobs
  - sub-agents (work the agent gives to a helper agent)
  - turns that you cancel or that fail
  - replies with no visible text
- Each device is off until you switch it on.
- The default alert text is "OpenClaw / Your reply is ready." You can show the conversation name and the start of the reply instead.

A turn is one message and the agent's reply to it.

> **Status:** tested by hand on one Gateway (OpenClaw 2026.11.6) with one iPhone and one iPad, and covered by automated tests. Use it only on a Gateway where one person owns every paired device. Details: [docs/status.md](docs/status.md).

## Installation guide

### What you need

- An OpenClaw Gateway, version 2026.11.6 or newer, on your computer.
- Node.js 24 or newer, and `git`.
- Optional: `jq`, for step 3.
- The OpenClaw app on your iPhone or iPad, paired with this Gateway, with permission to show notifications.
- A browser that opens the Dashboard over HTTPS (for example through Tailscale Serve) or on localhost (`http://127.0.0.1:18789/`).
- You are the only person who pairs devices with this Gateway.

### Step 1: Download and build the plugin

```sh
git clone https://github.com/shapeless-space/openclaw-ios-push.git
cd openclaw-ios-push
npm ci
npm run build
npm prune --omit=dev
```

The last command removes the build tools, so the copy OpenClaw makes in step 2 stays small.

### Step 2: Install the plugin

```sh
openclaw plugins install . --force
```

OpenClaw says the plugin is not enabled yet. That is expected: it needs settings first.

If OpenClaw asks you to approve the plugin's capabilities, run the command again with `--accept-capabilities`.

### Step 3: Give the plugin its own identity

The plugin connects to the Gateway with its own paired identity. That identity can read and write, but cannot change settings or pair devices. No password or token goes into the plugin settings.

1. Run `openclaw gateway status`.
2. Find the line that starts with `CLI version`. It ends with a path such as `.../node_modules/openclaw/dist/entry.js`.
3. Replace `dist/entry.js` at the end of that path with `openclaw.mjs`. This is your CLI path.
4. Put your CLI path after `--cli` in the command below, then run it.

```sh
OPENCLAW_GATEWAY_TOKEN="$(jq -r .gateway.auth.token ~/.openclaw/openclaw.json)" \
  node scripts/pair-cli-identity.mjs \
  --cli /path/to/node_modules/openclaw/openclaw.mjs \
  --identity-dir ~/.openclaw/plugin-state/ios-reply-alerts/cli-identity
```

If you do not have `jq`, change the first line to `OPENCLAW_GATEWAY_TOKEN="<your Gateway token>" \`.

The script uses your Gateway token once, to pair the identity, and does not save it. It must end with `node.list: ok   admin method: refused (good)`.

### Step 4: Find your profile id

A profile id identifies a person on the Gateway.

```sh
openclaw users list
```

Find the profile your iPhone and iPad use. If your phone connects through Tailscale Serve, it is usually the long id, not `gateway-owner`. If you choose the wrong one, the Reply alerts page in step 7 says that no iPhone or iPad belongs to you. Then try the other profile.

### Step 5: Add the settings

Replace the three paths and the profile id below with your own values. Write full paths, without `~`.

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

OpenClaw tells a plugin where a turn came from (app, web or Telegram) only with this permission. The permission also gives the plugin the conversation's messages. The plugin does not read, keep or log them. It reads only the channel, the trigger and the source of the input.

### Step 7: Switch on alerts for your iPhone and iPad

The Settings screen of the iOS app cannot show plugin pages, so use the web Dashboard.

1. Open the Dashboard in a browser, over HTTPS or localhost. Plugin pages do not load over plain HTTP on a network address.
2. Open the **Reply alerts** page. It is not in the menu at first: add it with the Dashboard's menu customization, or pin it.
3. Switch on each iPhone and iPad that must get alerts.

### Step 8: Test the plugin

1. On your iPhone, send a message in the OpenClaw app, for example "Write three sentences about the sea."
2. Wait until the agent starts to work.
3. Switch to a different app, or lock the screen.
4. Wait for the reply. Each device that you switched on gets an alert.

## Show the conversation name and the reply (optional)

```sh
openclaw config set plugins.entries.ios-reply-alerts.config.alert '{"content":"preview"}' --strict-json
```

The alert title becomes the conversation's name, and the text becomes the first 180 characters of the reply. The preview shows on your lock screen and goes through Apple's push service. To go back, set `"content": "generic"`.

## If the plugin does not work

1. Switch on the troubleshooting log:

   ```sh
   openclaw config set plugins.entries.ios-reply-alerts.config.logEvidenceShape true --strict-json
   ```

2. Do the test in step 8 again.
3. Show the plugin's log lines:

   ```sh
   openclaw logs --plain --limit 400 | grep "ios-reply-alerts:"
   ```

4. Look up the code in the table below.
5. When you finish, set `logEvidenceShape` back to `false`.

The log contains only codes and field names, never message text.

| Code | Meaning | What to do |
| --- | --- | --- |
| `submitted-accepted` | Apple accepted the alert. | Check the notification settings on the device. |
| `not-opted-in` | That device is switched off. | Switch it on (step 7). |
| `owner-has-no-devices` | The conversation's owner has no iPhone or iPad on this Gateway. | Check the profile id (step 4). |
| `origin-missing` | OpenClaw did not tell the plugin where the turn came from. | Do step 6 again, then run `openclaw plugins reload ios-reply-alerts`. |
| `ineligible-channel` | The turn came from Telegram or another chat channel. | Nothing. This is expected. |
| `not-user-turn` | The turn came from a heartbeat, a scheduled job or a relayed message. | Nothing. This is expected. |
| `child-run` | The turn was sub-agent work. | Nothing. This is expected. |

## Stop or remove the plugin

```sh
openclaw plugins disable ios-reply-alerts        # stop alerts, keep the settings
openclaw plugins uninstall ios-reply-alerts      # remove the plugin
openclaw devices list                            # find the plugin's identity ("openclaw-tui")
openclaw devices remove <device id>              # remove that identity
```

## Privacy

- The default alert contains no message text.
- The plugin stores only the devices you switched on, and a record of sent alerts that holds hashed ids and no text.
- The log contains only codes.
- Other people on the Gateway cannot see or switch your devices.

## For developers

```sh
npm install
npm run verify   # type check, tests, build
```

- `src/reply-alerts.ts`: decides whether a run gets an alert. It covers eligibility, per-device consent, the durable record of sent alerts, suppression while you read the reply, and the last check before sending.
- `src/host/openclaw-adapter.ts`: reads what the Gateway reports. Origin comes from the `agent_end` hook context, the final state from the lifecycle `end` event, and the owner from the session entry.
- `src/host/gateway-cli.ts`, `cli-push-transport.ts`, `cli-device-directory.ts`: call `push.test` and `node.list` as the plugin's own identity.
- `src/plugin.ts`: wires everything to the Gateway and adds the methods `replyAlerts.devices.list`, `replyAlerts.device.get` and `replyAlerts.device.set`.
- `dist/control-ui/index.js`: the Reply alerts page, in plain JavaScript with no build step.
- `scripts/pair-cli-identity.mjs`: the script for step 3.

The tests use a fake Gateway, a fake CLI and a fake web page. They never contact a real Gateway, Apple, or a device.

## License

[MIT](LICENSE)
