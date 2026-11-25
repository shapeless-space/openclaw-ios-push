// Control UI page "Reply alerts": one switch per iPhone or iPad that belongs to the signed-in person.
// It works from the web Dashboard: the Gateway lists only the caller's own devices
// (`replyAlerts.devices.list`) and saves each by id (`replyAlerts.device.set`), checking ownership.
// The OpenClaw iOS app's Settings embeds only Dashboard settings routes, so this page is reached
// from the web or desktop Dashboard. Plain ES module with no build step and no SDK import.

const PAGE_ID = "reply-alerts";
const NONE = "No iPhone or iPad paired with this Gateway belongs to you yet. Pair the OpenClaw app on your iPhone or iPad, then come back here.";

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function statusLine(text) {
  const node = element("p", { textContent: text, className: "reply-alerts-status" });
  node.dataset.role = "status";
  node.setAttribute("role", "status");
  return node;
}

const deviceLabel = (device) => {
  const name = typeof device.displayName === "string" && device.displayName !== "" ? device.displayName
    : typeof device.deviceFamily === "string" && device.deviceFamily !== "" ? device.deviceFamily : "iPhone or iPad";
  return device.current === true ? `${name} (this device)` : name;
};

function mountReplyAlerts(container, context) {
  let disposed = false;
  const live = () => !disposed && !context.signal.aborted;
  const heading = element("h2", { textContent: "Reply alerts" });
  const intro = element("p", { textContent: "Get a notification on your iPhone or iPad when a reply in an app or web conversation is ready. The alert never includes message text." });
  const render = (...body) => { if (live()) container.replaceChildren(heading, intro, ...body); };

  function showDevices(devices, note = "") {
    const rows = devices.map((device, index) => {
      const id = `reply-alerts-toggle-${index}`;
      const input = element("input", { type: "checkbox", checked: device.enabled === true, id });
      const label = element("label", { textContent: deviceLabel(device) });
      label.setAttribute("for", id);
      input.addEventListener("change", () => {
        const wanted = input.checked === true;
        input.disabled = true;
        const withState = (enabled) => devices.map((d) => (d === device ? { ...d, enabled } : d));
        context.host.request("replyAlerts.device.set", { deviceId: device.deviceId, enabled: wanted }).then(
          (result) => showDevices(withState(result?.enabled === true)),
          () => showDevices(withState(!wanted), "Couldn't save the change. Try again."),
        );
      });
      return element("div", { className: "reply-alerts-row" }, input, label);
    });
    render(...rows, statusLine(note));
  }

  render(statusLine("Loading…"));
  context.host.request("replyAlerts.devices.list", {}).then(
    (result) => {
      const devices = Array.isArray(result?.devices) ? result.devices.filter((d) => typeof d?.deviceId === "string") : [];
      if (devices.length > 0) showDevices(devices);
      else render(statusLine(NONE));
    },
    () => render(statusLine("Couldn't load reply alert settings. Try again later.")),
  );

  return { dispose() { disposed = true; container.replaceChildren(); } };
}

export default {
  id: "ios-reply-alerts",
  activate(host) {
    const disposers = [
      host.ui.registerPage({ id: PAGE_ID, label: "Reply alerts", mount: mountReplyAlerts }),
      host.ui.registerNavigation({ id: PAGE_ID, label: "Reply alerts", page: { id: PAGE_ID }, icon: "bell", defaultVisible: false }),
    ];
    return () => { for (const dispose of disposers) dispose(); };
  },
};
