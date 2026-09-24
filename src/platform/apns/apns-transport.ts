import http2 from "node:http2";

export type ApnsTransportRequest = Readonly<{
  host: string;
  path: string;
  authorization: string;
  topic: string;
  pushType: string;
  priority: number;
  collapseId?: string;
  body: string;
}>;

export type ApnsTransportResponse = Readonly<{
  status: number;
  reason?: string;
  apnsId?: string;
}>;

export type ApnsTransport = Readonly<{
  send: (request: ApnsTransportRequest) => Promise<ApnsTransportResponse>;
  close: () => Promise<void>;
}>;

function parseReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/** APNs sender transport over node:http2, pooling one session per host. */
export function createHttp2ApnsTransport(): ApnsTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();

  function sessionFor(host: string): http2.ClientHttp2Session {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = http2.connect(`https://${host}`);
    session.on("error", () => sessions.delete(host));
    session.on("close", () => sessions.delete(host));
    sessions.set(host, session);
    return session;
  }

  return {
    send(request) {
      return new Promise((resolve, reject) => {
        const session = sessionFor(request.host);
        const headers: http2.OutgoingHttpHeaders = {
          [http2.constants.HTTP2_HEADER_METHOD]: "POST",
          [http2.constants.HTTP2_HEADER_PATH]: request.path,
          authorization: request.authorization,
          "apns-topic": request.topic,
          "apns-push-type": request.pushType,
          "apns-priority": String(request.priority),
          "content-type": "application/json",
          ...(request.collapseId
            ? { "apns-collapse-id": request.collapseId }
            : {}),
        };

        const stream = session.request(headers);
        stream.setEncoding("utf8");

        let status = 0;
        let apnsId: string | undefined;
        let body = "";

        stream.on("response", (responseHeaders) => {
          status = Number(responseHeaders[http2.constants.HTTP2_HEADER_STATUS]);
          const idHeader = responseHeaders["apns-id"];
          apnsId = typeof idHeader === "string" ? idHeader : undefined;
        });
        stream.on("data", (chunk: string) => {
          body += chunk;
        });
        stream.on("end", () => {
          const reason = parseReason(body);
          resolve({
            status,
            ...(reason ? { reason } : {}),
            ...(apnsId ? { apnsId } : {}),
          });
        });
        stream.on("error", reject);

        stream.end(request.body);
      });
    },

    async close() {
      for (const session of sessions.values()) {
        if (!session.closed) session.close();
      }
      sessions.clear();
    },
  };
}
