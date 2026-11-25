type BrowserChild = Pick<Deno.ChildProcess, "kill" | "status">;

async function signalAndWait(
  child: BrowserChild,
  exited: Promise<boolean>,
  signal: Deno.Signal,
  timeoutMs: number,
): Promise<boolean> {
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between checking its status and sending the signal.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop the managed browser, escalating only after the grace period and bounding both waits. */
export async function stopBrowser(child: BrowserChild, graceMs = 2000, killWaitMs = 1000): Promise<boolean> {
  const exited = child.status.then(() => true, () => false);
  if (await signalAndWait(child, exited, "SIGTERM", graceMs)) return true;
  return await signalAndWait(child, exited, "SIGKILL", killWaitMs);
}
