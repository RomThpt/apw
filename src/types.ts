import { Command, Status } from "./const.ts";

export type Message =
  | { cmd: Command.HANDSHAKE; pin?: string }
  // Read-only pairing status query; the bridge answers without starting or advancing a challenge.
  | { cmd: Command.HANDSHAKE; status: true }
  | {
    cmd: number;
    qid: string;
    tabId: number;
    frameId: number;
    url?: string;
    body: unknown;
  };

export type DecryptedData = { STATUS: number } & Record<string, unknown>;

export type APWResponse =
  | { id: string; data: DecryptedData }
  // `paired` is present on HANDSHAKE replies from bridges that support pairing status.
  | { id: string; status: Status; error?: string; paired?: boolean };

export interface PasswordEntry {
  USR: string;
  PWD?: string;
  sites: string[];
  highLevelDomain?: string;
  customTitle?: string;
  CDate?: string;
  ModDate?: string;
}

export interface TOTPEntry {
  code?: string;
  username: string;
  domain: string;
  source?: string;
}

export interface Payload {
  STATUS: Status;
  Entries: Array<PasswordEntry | TOTPEntry>;
  RequiresUserAuthenticationToFill?: boolean;
}
