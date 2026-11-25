import { stopBrowser } from "./child_shutdown.ts";

function childFixture(exitOn?: Deno.Signal) {
  const seen: (Deno.Signal | undefined)[] = [];
  const exited = Promise.withResolvers<Deno.CommandStatus>();
  return {
    seen,
    child: {
      status: exited.promise,
      kill(signal?: Deno.Signal) {
        seen.push(signal);
        if (signal === exitOn) exited.resolve({ success: true, code: 0, signal: null });
      },
    },
  };
}

Deno.test("a browser that exits on TERM is never sent KILL", async () => {
  const { child, seen } = childFixture("SIGTERM");
  if (!await stopBrowser(child, 5, 5) || seen.join(",") !== "SIGTERM") {
    throw new Error("Expected a graceful shutdown");
  }
});

Deno.test("a browser that does not exit on TERM is sent KILL", async () => {
  const { child, seen } = childFixture("SIGKILL");
  if (!await stopBrowser(child, 5, 5) || seen.join(",") !== "SIGTERM,SIGKILL") {
    throw new Error("Expected escalation and a confirmed exit");
  }
});

Deno.test("shutdown reports failure when the child never confirms its exit", async () => {
  const { child, seen } = childFixture();
  if (await stopBrowser(child, 5, 5) || seen.join(",") !== "SIGTERM,SIGKILL") {
    throw new Error("Expected a bounded shutdown failure");
  }
});
