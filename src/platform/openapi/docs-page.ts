import { SwaggerUI } from "@hono/swagger-ui";

const CLERK_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.30.2/dist/clerk.browser.js";

function inlineJson(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function decodeClerkFrontendHost(publishableKey: string): string {
  const encoded = publishableKey.match(/^pk_(?:test|live)_(.+)$/)?.[1];
  if (!encoded) throw new Error("Invalid Clerk publishable key");

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid Clerk publishable key");
  }
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
  const url = new URL(`https://${host}`);
  if (url.hostname !== host || url.username || url.password || url.port) {
    throw new Error("Invalid Clerk publishable key");
  }
  return host;
}

/** Browser bootstrap kept as a string because Swagger UI serializes interceptors. */
export function createDocsBootstrap(publishableKey: string): string {
  const serializedKey = inlineJson(publishableKey);
  return `(() => {
  const clerk = new window.Clerk(${serializedKey});
  const signInHost = document.getElementById("clerk-sign-in");
  const consoleHost = document.getElementById("docs-console");
  const swaggerHost = document.getElementById("swagger-ui");
  const signOutButton = document.getElementById("docs-sign-out");
  let ui = null;
  let signInMounted = false;

  const clearSwagger = () => {
    if (ui && ui.authActions && ui.authActions.logout) {
      ui.authActions.logout(["bearerAuth"]);
    }
    swaggerHost.replaceChildren();
    ui = null;
  };

  const requestInterceptor = async (request) => {
    request.headers = request.headers || {};
    const token = await clerk.session?.getToken();
    if (request.headers.set && request.headers.delete) {
      if (token) request.headers.set("Authorization", "Bearer " + token);
      else request.headers.delete("Authorization");
    } else if (token) {
      request.headers.Authorization = "Bearer " + token;
    } else {
      delete request.headers.Authorization;
    }
    return request;
  };

  const render = async () => {
    if (clerk.isSignedIn && clerk.session) {
      if (signInMounted) {
        clerk.unmountSignIn(signInHost);
        signInMounted = false;
      }
      signInHost.hidden = true;
      consoleHost.hidden = false;
      signOutButton.hidden = false;
      if (!ui) {
        ui = window.SwaggerUIBundle({
          url: "/openapi.json",
          dom_id: "#swagger-ui",
          persistAuthorization: false,
          requestInterceptor,
        });
      }
      return;
    }

    if (ui) clearSwagger();
    consoleHost.hidden = true;
    signOutButton.hidden = true;
    signInHost.hidden = false;
    if (!signInMounted) {
      clerk.mountSignIn(signInHost);
      signInMounted = true;
    }
  };

  signOutButton.addEventListener("click", async () => {
    clearSwagger();
    consoleHost.hidden = true;
    signOutButton.hidden = true;
    await clerk.signOut();
    await render();
  });

  const initialize = async () => {
    await clerk.load();
    clerk.addListener(() => render());
    await render();
  };

  window.__centsibleDocsReady = initialize();
})();`;
}

export type DocsPage = { html: string; contentSecurityPolicy: string };

/** Creates the Clerk-owned sign-in shell and a nonce-bound Swagger bootstrap. */
export function createDocsPage(
  publishableKey: string,
  nonce: string,
): DocsPage {
  const clerkFrontendHost = decodeClerkFrontendHost(publishableKey);
  const clerkOrigin = `https://${clerkFrontendHost}`;
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net ${clerkOrigin}`,
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    `connect-src 'self' ${clerkOrigin}`,
    `img-src 'self' data: ${clerkOrigin}`,
    "font-src 'self' data: https://cdn.jsdelivr.net",
    `frame-src ${clerkOrigin}`,
    `form-action 'self' ${clerkOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const bootstrap = createDocsBootstrap(publishableKey);
  const swaggerMarkup = SwaggerUI({
    url: "/openapi.json",
    version: "5",
    manuallySwaggerUIHtml: (assets) => `
      ${assets.css.map((url) => `<link rel="stylesheet" href="${url}">`).join("\n")}
      <div id="clerk-sign-in"></div>
      <section id="docs-console" hidden>
        <button id="docs-sign-out" type="button" hidden>Sign out</button>
        <div id="swagger-ui"></div>
      </section>
      <script nonce="${nonce}" src="${CLERK_SCRIPT_URL}"></script>
      ${assets.js.map((url) => `<script nonce="${nonce}" src="${url}"></script>`).join("\n")}
      <script nonce="${nonce}">${bootstrap}</script>`,
  });

  return {
    contentSecurityPolicy,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Centsible API</title>
  </head>
  <body>
    <main>${swaggerMarkup}</main>
  </body>
</html>`,
  };
}
