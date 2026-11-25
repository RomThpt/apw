import bridgeSource from "../ext/bridge.js" with { type: "text" };
import { readConfig, writeConfig } from "./config.ts";
import { APWError, BROWSER_PROFILE_PATH, DATA_PATH, EXTENSION_PATH, Status } from "./const.ts";
import { findExtensionSource, missingExtensionMessage } from "./browser_profiles.ts";
import { refreshExtensionCache, restoreExtensionCache } from "./extension_cache.ts";
import { stopBrowser } from "./child_shutdown.ts";
import {
  awaitPipeResponse,
  drainPipe,
  encodePipeCommand,
  PIPE_SHELL,
  pipeResponseError,
  pipeShellArgs,
} from "./devtools_pipe.ts";

const HOME = Deno.env.get("HOME")!;
const APPLE_MANIFEST = "/Library/Google/Chrome/NativeMessagingHosts/com.apple.passwordmanager.json";
const EXTENSION_ID = "pejdijmoenmkgeppbflobdenhhabjlaj";
const BACKGROUND = "background.js";

export interface Browser {
  id: string;
  name: string;
  bin: string;
  profile: string;
  dataPath: string;
  brewCask: string;
}

function browser(id: string, name: string, app: string, dataDir: string, brewCask: string): Browser {
  return {
    id,
    name,
    bin: `/Applications/${app}.app/Contents/MacOS/${app}`,
    profile: `${BROWSER_PROFILE_PATH}/${id}`,
    dataPath: `${HOME}/Library/Application Support/${dataDir}`,
    brewCask,
  };
}

export const BROWSERS = [
  browser("chromium", "Ungoogled Chromium", "Chromium", "Chromium", "ungoogled-chromium"),
  browser("edge", "Microsoft Edge", "Microsoft Edge", "Microsoft Edge", "microsoft-edge"),
  browser("brave", "Brave", "Brave Browser", "BraveSoftware/Brave-Browser", "brave-browser"),
  browser("chrome", "Google Chrome", "Google Chrome", "Google/Chrome", "google-chrome"),
];

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Directory names under `path`; `[]` if it does not exist, `null` if access is denied. */
function directories(path: string): string[] | null {
  try {
    return [...Deno.readDirSync(path)].filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    if (error instanceof Deno.errors.PermissionDenied) return null;
    throw error;
  }
}

function remove(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function buildExtension(browser: Browser, config: { port: number; token: string }): void {
  const background = `${EXTENSION_PATH}/${BACKGROUND}`;
  const orig = `${background}.orig`;
  restoreExtensionCache(EXTENSION_PATH);
  const { path: source, inaccessible } = findExtensionSource(
    [browser.dataPath, ...BROWSERS.filter(({ id }) => id !== browser.id).map(({ dataPath }) => dataPath)],
    EXTENSION_ID,
    BACKGROUND,
    { directories, isFile },
  );
  const cached = isFile(orig);
  if (source && (!cached || source !== readConfig()?.extensionPath)) {
    refreshExtensionCache(source, EXTENSION_PATH, DATA_PATH);
    writeConfig({ extensionVersion: source.split("/").at(-1)!, extensionPath: source });
  } else if (!source) {
    if (!cached || !inaccessible.length) {
      throw new APWError(Status.GENERIC_ERROR, missingExtensionMessage(inaccessible));
    }
    console.warn("[apw] Could not check the installed extension. Using the cached copy.");
  }

  Deno.writeTextFileSync(
    background,
    `${Deno.readTextFileSync(orig)}\nself.APW_CONFIG = ${JSON.stringify(config)};\n${bridgeSource}\n`,
  );
}

export function installedBrowsers(): Browser[] {
  return BROWSERS.filter(({ bin }) => exists(bin));
}

const STARTUP_TIMEOUT_MS = 30_000;
const LOAD_EXTENSION_ID = 1;

// Pipe write ends of running browsers, held so they stay open until the browser exits.
const openPipes = new Set<WritableStreamDefaultWriter<Uint8Array>>();

/**
 * Launches the browser with DevTools available only over a private pipe (no TCP port) and loads
 * the bridge extension through it. The pipe's write end stays open for the browser's lifetime and
 * its output keeps being drained; the browser shuts down when the daemon exits and the pipe closes.
 */
export async function launchBrowser(
  browser: Browser,
  config: { port: number; token: string },
): Promise<Deno.ChildProcess> {
  buildExtension(browser, config);
  remove(browser.profile);
  const hosts = `${browser.profile}/NativeMessagingHosts`;
  Deno.mkdirSync(hosts, { recursive: true });
  Deno.copyFileSync(APPLE_MANIFEST, `${hosts}/com.apple.passwordmanager.json`);

  const child = new Deno.Command(PIPE_SHELL, {
    args: pipeShellArgs(browser.bin, [
      `--user-data-dir=${browser.profile}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ]),
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const commands = child.stdin.getWriter();
  const replies = child.stdout.getReader();

  try {
    await commands.write(encodePipeCommand({
      id: LOAD_EXTENSION_ID,
      method: "Extensions.loadUnpacked",
      params: { path: EXTENSION_PATH },
    })).catch(() => {
      throw new Error("Browser exited before its DevTools pipe was ready");
    });
    const response = await awaitPipeResponse(replies, LOAD_EXTENSION_ID, {
      timeoutMs: STARTUP_TIMEOUT_MS,
      exited: child.status,
    });
    const error = pipeResponseError(response);
    if (error) throw new Error(`Could not load extension: ${error}`);
  } catch (error) {
    void replies.cancel().catch(() => {});
    if (!await stopBrowser(child)) console.error("[apw] Could not confirm the browser stopped after startup failed.");
    throw error;
  }

  openPipes.add(commands);
  child.status.finally(() => openPipes.delete(commands));
  drainPipe(replies);
  return child;
}
