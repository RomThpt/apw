import { Action, APWError, Command, SOCKET_PATH, Status } from "./const.ts";
import type { APWResponse, DecryptedData, Message, PasswordEntry, Payload, TOTPEntry } from "./types.ts";
import { confirmPairing } from "./pairing.ts";
import { readLine, writeAll } from "./transport.ts";

const encoder = new TextEncoder();

// Slightly longer than the daemon's own 30 s extension timeout so its error reply arrives first.
const REQUEST_TIMEOUT_MS = 35_000;
const STATUS_TIMEOUT_MS = 3_000;

export const APWMessages = {
  getLoginNamesForURL(url: string): Message {
    return {
      cmd: Command.GET_LOGIN_NAMES_FOR_URL,
      qid: "CmdGetLoginNames4URL",
      tabId: 1,
      frameId: 1,
      url,
      body: { ACT: Action.GHOST_SEARCH, URL: url },
    };
  },

  getPasswordForURL(url: string, loginName = ""): Message {
    return {
      cmd: Command.GET_PASSWORD_FOR_LOGIN_NAME,
      qid: "CmdGetPassword4LoginName",
      tabId: 0,
      frameId: 0,
      url,
      body: { ACT: Action.SEARCH, URL: url, USR: loginName },
    };
  },

  saveAccountForURL(url: string, loginName: string, password: string): Message {
    return {
      cmd: Command.SET_PASSWORD_FOR_LOGIN_NAME_AND_URL,
      qid: "CmdSetPassword4LoginName_URL",
      tabId: 0,
      frameId: 0,
      body: {
        ACT: Action.MAYBE_ADD,
        URL: "",
        USR: "",
        PWD: "",
        NURL: url,
        NUSR: loginName,
        NPWD: password,
      },
    };
  },

  getOTPForURL(url: string): Message {
    return {
      cmd: Command.DID_FILL_ONE_TIME_CODE,
      qid: "CmdDidFillOneTimeCode",
      tabId: 0,
      frameId: 0,
      body: {
        ACT: Action.SEARCH,
        TYPE: "oneTimeCodes",
        frameURLs: [url.includes("://") ? url : `http://${url}`],
      },
    };
  },

  listOTPForURL(url: string): Message {
    return {
      cmd: Command.GET_ONE_TIME_CODES,
      qid: "CmdDidFillOneTimeCode",
      tabId: 0,
      frameId: 0,
      body: {
        ACT: Action.GHOST_SEARCH,
        TYPE: "oneTimeCodes",
        frameURLs: [url.includes("://") ? url : `http://${url}`],
      },
    };
  },
};

export function entriesFrom(data: DecryptedData): unknown[] {
  if (!data || typeof data.STATUS !== "number") {
    throw new APWError(Status.SERVER_ERROR);
  }
  if (data.STATUS === Status.NO_RESULTS) return [];
  if (data.STATUS !== Status.SUCCESS) {
    throw new APWError(data.STATUS as Status);
  }
  if (Array.isArray(data.Entries)) return data.Entries;
  return Object.entries(data)
    .filter(([key]) => key.startsWith("Entry_"))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value);
}

export class ApplePasswordManager {
  private async sendMessage(message: Message, timeoutMs = REQUEST_TIMEOUT_MS): Promise<APWResponse> {
    let conn: Deno.Conn;
    try {
      conn = await Deno.connect({ transport: "unix", path: SOCKET_PATH });
    } catch {
      throw new APWError(Status.INVALID_SESSION);
    }

    let closed = false;
    let timedOut = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        conn.close();
      } catch { /* already closed */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      close();
    }, timeoutMs);

    try {
      let line: string;
      try {
        await writeAll(conn, encoder.encode(`${JSON.stringify(message)}\n`));
        line = await readLine(conn);
      } catch (error) {
        if (timedOut) throw new APWError(Status.SERVER_ERROR, "Timed out waiting for the daemon");
        if (error instanceof APWError) throw error;
        throw new APWError(Status.INVALID_SESSION, "Lost connection to the daemon");
      }

      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        throw new APWError(Status.SERVER_ERROR, "Malformed response from daemon");
      }
      if (!response || typeof response !== "object") throw new APWError(Status.SERVER_ERROR);
      if (!("data" in response)) {
        const { status, error } = response as { status?: unknown; error?: unknown };
        if (typeof status !== "number") throw new APWError(Status.SERVER_ERROR);
        if (status !== Status.SUCCESS) {
          throw new APWError(status as Status, typeof error === "string" ? error : undefined);
        }
      }
      return response as APWResponse;
    } finally {
      clearTimeout(timer);
      close();
    }
  }

  /** HANDSHAKE replies never carry data; anything else is a protocol error. */
  private async handshake(message: Extract<Message, { cmd: Command.HANDSHAKE }>, timeoutMs?: number) {
    const response = await this.sendMessage(message, timeoutMs);
    if ("data" in response) throw new APWError(Status.SERVER_ERROR);
    return response;
  }

  private async getPayload(message: Message): Promise<Payload> {
    const response = await this.sendMessage(message);
    if (!("data" in response)) throw new APWError(Status.SERVER_ERROR);
    return {
      STATUS: response.data.STATUS as Status,
      Entries: entriesFrom(response.data) as Array<PasswordEntry | TOTPEntry>,
    };
  }

  async checkReady(): Promise<void> {
    try {
      const conn = await Deno.connect({ transport: "unix", path: SOCKET_PATH });
      conn.close();
    } catch {
      throw new APWError(
        Status.INVALID_SESSION,
        "APW is not running or not authorised. Run `apw start` then `apw auth`.",
      );
    }
  }

  async requestChallenge(): Promise<void> {
    await this.handshake({ cmd: Command.HANDSHAKE });
  }

  /**
   * Submits the PIN, then resolves only once the extension reports an established session. Rejects with
   * `INVALID_SESSION` if pairing is not confirmed within a short bounded window.
   */
  async verifyChallenge(pin: string): Promise<void> {
    if (typeof pin !== "string" || !pin) throw new APWError(Status.INVALID_PARAM, "PIN is required");
    const submission = await this.handshake({ cmd: Command.HANDSHAKE, pin });
    // The status query is only sent when the submission reply proves the bridge understands it; an older bridge
    // would treat a HANDSHAKE without a PIN as a new challenge and discard the pairing in progress.
    const query = () => this.handshake({ cmd: Command.HANDSHAKE, status: true }, STATUS_TIMEOUT_MS);
    await confirmPairing(submission, query);
  }

  getLoginNamesForURL(url: string): Promise<Payload> {
    if (!url) throw new APWError(Status.INVALID_PARAM, "URL is required");
    return this.getPayload(APWMessages.getLoginNamesForURL(url));
  }

  getPasswordForURL(url: string, loginName?: string): Promise<Payload> {
    if (!url) throw new APWError(Status.INVALID_PARAM, "URL is required");
    return this.getPayload(APWMessages.getPasswordForURL(url, loginName));
  }

  async saveAccountForURL(url: string, loginName: string, password: string): Promise<void> {
    if (!url) throw new APWError(Status.INVALID_PARAM, "URL is required");
    const response = await this.sendMessage(APWMessages.saveAccountForURL(url, loginName, password));
    if ("status" in response && response.status !== Status.SUCCESS) {
      throw new APWError(response.status, response.error);
    }
  }

  getOTPForURL(url: string): Promise<Payload> {
    if (!url) throw new APWError(Status.INVALID_PARAM, "URL is required");
    return this.getPayload(APWMessages.getOTPForURL(url));
  }

  listOTPForURL(url: string): Promise<Payload> {
    if (!url) throw new APWError(Status.INVALID_PARAM, "URL is required");
    return this.getPayload(APWMessages.listOTPForURL(url));
  }
}
