import { ContextVault } from "../src/store.js";
import { spawnSync } from "node:child_process";

if (typeof process.send !== "function") throw new Error("concurrent fixture requires IPC");

process.send({ type: "ready" });
process.once("message", (message) => {
  if (message?.type !== "commit" || !message.home || !message.cli) throw new Error("invalid concurrent commit request");
  process.send({ type: "starting" });
  const initialized = spawnSync(process.execPath, [message.cli, "init", "--home", message.home], { encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "concurrent init failed");
  const vault = new ContextVault(message.home);
  try {
    const proposed = vault.propose({
      body: "Committed by the concurrent first-open process.",
      project_id: "concurrent-project",
      owner_id: "local-user",
    });
    const committed = vault.commit(proposed.record.id);
    process.send({ type: "committed", id: committed.id, body: committed.body });
  } finally {
    vault.close();
    process.disconnect();
  }
});
