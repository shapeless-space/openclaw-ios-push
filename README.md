<img src="assets/icon.svg" width="64" height="64" alt="">

# OpenClaw iOS reply alerts

This is a plugin for the [OpenClaw](https://docs.openclaw.ai) Gateway. The Gateway is the OpenClaw server that runs on your computer. The plugin sends an alert to your **iPhone or iPad** when the agent finishes a reply. An alert is a notification on the device. You get an alert only for a conversation that you started in the OpenClaw app or in the web Dashboard. The Dashboard is the Gateway's web page.

You can send a message, put your phone away, and get an alert when the reply is ready.

- The plugin sends an alert only for **your own** app and web conversations.
- The plugin does **not** send an alert for:
  - Telegram and other chat channels
  - heartbeats (the agent's automatic check-ins) and scheduled jobs
  - sub-agents (work that the agent gives to a helper agent)
  - turns that you cancel and turns that fail
  - replies with no visible text

A turn is one message and the agent's reply to it.
- Each iPhone and iPad is **off** until you switch it on.
- By default, the alert text is **OpenClaw** / **Your reply is ready.** You can change the alert to show the conversation name and the start of the reply.

> **Status:** One person tested the plugin by hand on one Gateway (OpenClaw 2026.11.6), with one iPhone and one iPad. Automated tests also cover it. The plugin works only on a Gateway where **one person** owns every paired device. For details, read [docs/status.md](docs/status.md).

## Installation guide

### What you need

- An OpenClaw Gateway, version 2026.11.6 or newer, that runs on your computer.
- Node.js 24 or newer.
- `git`.
- The `jq` tool, if you want to use it in step 3. You can also do step 3 without it.
- The OpenClaw app on your iPhone or iPad, paired with this Gateway. The app must have permission to show notifications.
- A web browser that opens the Dashboard over **HTTPS** or on **localhost** (`http://127.0.0.1:18789/`). Tailscale Serve is one way to get an HTTPS address.
- You must be the only person who pairs devices with this Gateway.

### Step 1: Download and build the plugin

```sh
git clone https://github.com/shapeless-space/openclaw-ios-push.git
cd openclaw-ios-push
npm ci
npm run build
npm prune --omit=dev
```

> Note: The last command removes the build tools. OpenClaw copies the folder when it installs the plugin, so a small folder gives a small copy.

### Step 2: Install the plugin

```sh
openclaw plugins install . --force
```

OpenClaw tells you that the plugin is **not enabled yet**. This is correct, because the plugin needs settings first.

If OpenClaw asks you to approve the plugin's capabilities, run the same command again and add `--accept-capabilities`.

### Step 3: Give the plugin its own identity

The plugin connects to the Gateway with its own paired identity. This identity can only read and write. It cannot change settings and it cannot pair devices. The plugin settings do not contain a password or a token.

1. Run `openclaw gateway status`.
2. Find the line that starts with `CLI version`. The line ends with a path such as `.../node_modules/openclaw/dist/entry.js`.
3. Change the end of that path from `dist/entry.js` to `openclaw.mjs`. This is your CLI path.
4. In the command below, put your CLI path after `--cli`.
5. Run the command.

```sh
OPENCLAW_GATEWAY_TOKEN="$(jq -r .gateway.auth.token ~/.openclaw/openclaw.json)" \
  node scripts/pair-cli-identity.mjs \
  --cli /path/to/node_modules/openclaw/openclaw.mjs \
  --identity-dir ~/.openclaw/plugin-state/ios-reply-alerts/cli-identity
```

If you do not have `jq`, change the first line to `OPENCLAW_GATEWAY_TOKEN="<your Gateway token>" \`.

The script uses your Gateway token one time, to pair the identity. The script does not save that token. At the end, the script must show `node.list: ok   admin method: refused (good)`.

### Step 4: Find your profile id

A profile id identifies a person on the Gateway.

```sh
openclaw users list
```

Find the profile that your iPhone and iPad use. If your phone connects through Tailscale Serve, the correct profile is usually the long id, not `gateway-owner`.

If you choose the wrong profile, the Reply alerts page in step 7 shows a message. The message says that no iPhone or iPad belongs to you. If this occurs, try the other profile.

### Step 5: Add the settings

Replace the three paths and the profile id in the command below with your own values. Write full paths. Do not use `~`.

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

> Note: OpenClaw tells a plugin where a turn came from (app, web or Telegram) only if the plugin has this permission. With this permission, OpenClaw also gives the conversation's messages to the plugin. The plugin does not read, keep or log the messages. The plugin reads only three facts: the channel, the trigger, and the source of the input.

### Step 7: Switch on alerts for your iPhone and iPad

1. Open the Dashboard in a web browser. Use HTTPS or localhost.
   > Note: Plugin pages do not load over plain HTTP on a network address.
2. Open the **Reply alerts** page.
   > Note: The page is not in the menu at first. Add the page with the Dashboard's menu customization, or pin the page.
3. Find your iPhone and your iPad on the page.
4. Switch on each device that must get alerts.

Use the web Dashboard for this step. The Settings screen of the OpenClaw iOS app cannot show plugin pages.

### Step 8: Test the plugin

1. On your iPhone, send a message in the OpenClaw app. For example: "Write three sentences about the sea."
2. Wait until the agent starts to work.
3. Switch to a different app, or lock the screen.
4. Wait for the reply. Each device that you switched on gets an alert.

## Show the conversation name and the reply (optional)

```sh
openclaw config set plugins.entries.ios-reply-alerts.config.alert '{"content":"preview"}' --strict-json
```

With this setting, the alert title is the name of the conversation. The alert text is the start of the reply, up to 180 characters.

Before you use this setting, know these facts:

- Your lock screen shows the preview.
- The preview goes through Apple's push service.

To go back to the default alert text, set `"content": "generic"`.

## If the plugin does not work

1. Switch on the troubleshooting log:

   ```sh
   openclaw config set plugins.entries.ios-reply-alerts.config.logEvidenceShape true --strict-json
   ```

2. Do the test in step 8 again.
3. Show the log lines from the plugin:

   ```sh
   openclaw logs --plain --limit 400 | grep "ios-reply-alerts:"
   ```

4. Find the code in the table below.
5. When you finish, set `logEvidenceShape` to `false`.
   > Note: This switches off the troubleshooting log.

The log shows only short codes and field names. It never shows message text.

| Code | Meaning | What to do |
| --- | --- | --- |
| `submitted-accepted` | Apple accepted the alert. | Examine the notification settings on the device. |
| `not-opted-in` | That device is switched off. | Switch on the device (step 7). |
| `owner-has-no-devices` | The owner of the conversation has no iPhone or iPad on this Gateway. | Examine the profile id (step 4). |
| `origin-missing` | OpenClaw did not tell the plugin where the turn came from. | Do step 6 again. Then run `openclaw plugins reload ios-reply-alerts`. |
| `ineligible-channel` | The turn came from Telegram or a different chat channel. | No action. This is correct. |
| `not-user-turn` | The turn came from a heartbeat, a scheduled job or a relayed message. | No action. This is correct. |
| `child-run` | The turn was sub-agent work. | No action. This is correct. |

## Stop or remove the plugin

```sh
openclaw plugins disable ios-reply-alerts        # stop the alerts and keep the settings
openclaw plugins uninstall ios-reply-alerts      # remove the plugin
openclaw devices list                            # find the plugin's identity ("openclaw-tui")
openclaw devices remove <device id>              # remove that identity
```

## Privacy

- With the default setting, the alert contains no message text.
- The plugin keeps only two things:
  - the list of devices that you switched on
  - a record of the alerts that it sent. This record contains hashed ids. It never contains text.
- The log contains only codes.
- Only you can see and switch your own devices. A different person on the Gateway sees none of your devices.

## For developers

```sh
npm install
npm run verify   # type check, tests, build
```

- `src/reply-alerts.ts`: the rules. This file decides if a run gets an alert. It contains:
  - the eligibility rules
  - the consent for each device
  - the durable record of sent alerts
  - the suppression when you already read the reply
  - the last check before an alert goes out
- `src/host/openclaw-adapter.ts`: reads the facts that the Gateway sends.
  - The origin comes from the context of the `agent_end` hook.
  - The final state comes from the lifecycle `end` event.
  - The owner comes from the session entry.
- `src/host/gateway-cli.ts`, `cli-push-transport.ts`, `cli-device-directory.ts`: connect to the Gateway as the plugin's own identity. They call `push.test` and `node.list`.
- `src/plugin.ts`: connects the parts to the Gateway. It adds the methods `replyAlerts.devices.list`, `replyAlerts.device.get` and `replyAlerts.device.set`.
- `dist/control-ui/index.js`: the Reply alerts page. It is plain JavaScript. It needs no build step.
- `scripts/pair-cli-identity.mjs`: the script for step 3.

The tests use a fake Gateway, a fake CLI and a fake web page. The tests never connect to a real Gateway, to Apple, to a phone or to a tablet.

## License

[MIT](LICENSE)
