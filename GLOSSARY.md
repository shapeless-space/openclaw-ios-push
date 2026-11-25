# iOS Reply Alerts

Language for optional notifications about completed app/web conversations.

## Language

**Reply alert**:
A native iPhone or iPad notification that a completed reply is ready in an eligible app/web conversation. Its text is generic, or (with previews on) the conversation's name and the start of the reply.
_Avoid_: Telegram notification, progress update

**Device opt-in**:
A person's choice to enable reply alerts on one of their own iPhones or iPads for all eligible app/web conversations, made on the web Dashboard's Reply alerts page; absent that choice, alerts are disabled.
_Avoid_: Per-chat subscription

**Active conversation**:
The destination conversation currently visible to the person receiving a reply alert.
_Avoid_: Connected client, open app

**Native push target**:
A paired node that the host classifies as the iOS app on an iPhone or iPad (platform "iOS …"/"iPadOS …"). Apple Watch, Mac and Android nodes are not targets.

**Submission**:
Handing one alert for one (logical run, device) key to the push transport. Accepted, rejected and unknown are submission outcomes; none of them is iPhone receipt.

**Reservation**:
The durable, exclusive ledger record written before a submission. It is what prevents a second submission after concurrency, replay or a crash.
