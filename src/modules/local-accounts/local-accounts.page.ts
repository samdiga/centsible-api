/**
 * The local bank-accounts page: one self-contained HTML document, no build
 * step. Plaid Link on the web opens an OAuth bank in a pop-up window, so it
 * works for banks whose iOS flow hands off to the bank's own app.
 */

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function localAccountsPage(email: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Centsy bank accounts</title>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<style>
  :root { color-scheme: light dark; --fg: #0a0a0a; --muted: #525252; --bg: #fafafa; --card: #fff;
          --line: #e5e5e5; --brand: #4338ca; --danger: #dc2626; --ok: #059669; --warn: #b45309; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #fafafa; --muted: #a3a3a3; --bg: #000; --card: #262626; --line: #404040;
            --brand: #a78bfa; --danger: #f87171; --ok: #22c55e; --warn: #fbbf24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
  button { font: inherit; border-radius: 8px; padding: 8px 14px; border: 1px solid var(--line);
           background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .status { font-size: 14px; }
  .status.ok { color: var(--ok); } .status.warn { color: var(--warn); } .status.bad { color: var(--danger); }
  ul { margin: 8px 0 12px; padding-left: 18px; color: var(--muted); font-size: 14px; }
  .actions { display: flex; gap: 8px; }
  .message { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--line); }
  .message.error { color: var(--danger); }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Bank accounts</h1>
  <p class="sub">Linking banks for <strong>${escapeHtml(email)}</strong>. This page only works on this Mac.</p>
  <div class="bar"><button class="primary" id="add">Add bank</button><span class="muted" id="busy"></span></div>
  <div id="message" hidden></div>
  <div id="list"><p class="muted">Loading connections…</p></div>
</main>
<script>
const HEADERS = { "X-Centsy-Local": "1", "Content-Type": "application/json" };
const STATUS = { ok: ["Healthy", "ok"], needs_relink: ["Needs relink", "bad"], expiring: ["Expires soon, relink", "warn"],
                 error: ["Not updating", "bad"], stale: ["Hasn't updated in 3+ days", "warn"] };
const $ = (id) => document.getElementById(id);

function show(text, isError) {
  const box = $("message");
  box.hidden = !text;
  box.className = "message" + (isError ? " error" : "");
  box.textContent = text || "";
}
function busy(text) {
  $("busy").textContent = text || "";
  document.querySelectorAll("button").forEach((b) => (b.disabled = !!text));
}
async function call(method, path, body) {
  const response = await fetch(path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data.error && data.error.message) || "Request failed (" + response.status + ")");
  return data;
}

function render(items) {
  const list = $("list");
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No banks linked yet. Use Add bank to connect one.";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "card";
    const [label, tone] = STATUS[item.health] || [item.health, "warn"];
    const head = document.createElement("div");
    head.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.institutionName || "Bank";
    const status = document.createElement("span");
    status.className = "status " + tone;
    status.textContent = label;
    head.append(name, status);
    const accounts = document.createElement("ul");
    if (!item.accounts.length) {
      const li = document.createElement("li");
      li.textContent = item.initialSyncComplete ? "No accounts" : "Accounts appear after the first sync";
      accounts.append(li);
    }
    for (const account of item.accounts) {
      const li = document.createElement("li");
      li.textContent = account.name + (account.mask ? " ••" + account.mask : "") + " · " + account.type;
      accounts.append(li);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const relink = document.createElement("button");
    relink.textContent = "Relink";
    relink.onclick = () => relinkItem(item);
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.onclick = () => removeItem(item);
    actions.append(relink, remove);
    card.append(head, accounts, actions);
    list.append(card);
  }
}

async function load() {
  try {
    render((await call("GET", "/local/plaid/items")).items);
  } catch (error) {
    $("list").replaceChildren();
    show("Couldn't load connections: " + error.message, true);
  }
}

function openLink(token, onSuccess) {
  return new Promise((resolve) => {
    const handler = Plaid.create({
      token,
      onSuccess: async (publicToken, metadata) => { await onSuccess(publicToken, metadata); resolve(); },
      onExit: (error) => { if (error) show("Plaid closed: " + (error.display_message || error.error_message || "cancelled"), true); resolve(); },
    });
    handler.open();
  });
}

$("add").onclick = async () => {
  show("");
  busy("Opening Plaid…");
  try {
    const { linkToken } = await call("POST", "/local/plaid/link-token");
    busy("Waiting for Plaid…");
    await openLink(linkToken, async (publicToken, metadata) => {
      busy("Saving…");
      await call("POST", "/local/plaid/exchange", {
        publicToken,
        institution: { id: metadata.institution.institution_id, name: metadata.institution.name },
      });
      show("Linked " + metadata.institution.name + ". Accounts appear once the first sync finishes.");
    });
  } catch (error) {
    show("Couldn't link: " + error.message, true);
  } finally {
    busy("");
    load();
  }
};

async function relinkItem(item) {
  show("");
  busy("Opening Plaid…");
  try {
    const { linkToken } = await call("POST", "/local/plaid/items/" + encodeURIComponent(item.id) + "/update-link-token");
    await openLink(linkToken, async () => show("Relinked " + (item.institutionName || "the bank") + "."));
  } catch (error) {
    show("Couldn't relink: " + error.message, true);
  } finally {
    busy("");
    load();
  }
}

async function removeItem(item) {
  if (!confirm("Remove " + (item.institutionName || "this bank") + "? Its accounts stop updating in Centsy.")) return;
  show("");
  busy("Removing…");
  try {
    await call("DELETE", "/local/plaid/items/" + encodeURIComponent(item.id));
    show("Removed " + (item.institutionName || "the bank") + ".");
  } catch (error) {
    show("Couldn't remove: " + error.message, true);
  } finally {
    busy("");
    load();
  }
}

load();
</script>
</body>
</html>`;
}
