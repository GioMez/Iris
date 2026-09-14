// A persistent command-level engine substitute. It models only the protocol up
// to the smoke's first volume helper; it never invokes an engine or touches a VM.
const fs = require("node:fs");
const path = require("node:path");
const [root, ...args] = process.argv.slice(2);
const stateFile = path.join(root, "engine.json"), state = JSON.parse(fs.readFileSync(stateFile));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const option = (flag) => args[args.indexOf(flag) + 1];
const project = option("-p");
const record = () => { state.calls.push(args); save(); };
record();
function pause(phase, resume) {
  fs.writeFileSync(path.join(root, "paused"), phase);
  // This timer bounds even an intentionally failing RED fixture.
  const deadline = setTimeout(() => process.exit(124), 8000);
  const poll = setInterval(() => {
    if (fs.existsSync(path.join(root, "release"))) { clearInterval(poll); clearTimeout(deadline); resume(); }
  }, 10);
}
if (args[0] === "version" || (args[0] === "compose" && args[1] === "version")) out("synthetic-engine-boundary\n");
else if (args[0] === "compose" && args.includes("config")) {
  process.stderr.write(["IRIS_SECRET", "DB_PASSWORD", "POSTGRES_ADMIN_PASSWORD"].find((key) => !process.env[key])); process.exitCode = 1;
} else if (args[0] === "image") out([{}]);
else if (args[0] === "run") {
  const name = option("--name");
  const kind = name.includes("-probe-") ? "probe" : "helper";
  const volume = args.includes("-v") ? option("-v").split(":")[0] : null;
  state.containers[name] = { kind, volume }; if (volume) state.volumes[volume] = true;
  save();
  if (state.target === kind && state.when === "before") pause(`run-${kind}`, () => process.exit(23));
  else if (state.target === kind) process.exitCode = 23; // Interrupted/disconnected wait: engine resource outlives its CLI.
} else if (args[0] === "rm") {
  const name = args.at(-1), resource = state.containers[name];
  const remove = () => {
    if (state.failRemoval && resource?.kind === state.target) {
      if (state.failRemoval === "once") { state.failRemoval = false; save(); }
      process.stderr.write("synthetic removal refused"); process.exitCode = 1;
    }
    else { delete state.containers[name]; save(); }
  };
  if (resource?.kind === state.target && state.when === "during" && !fs.existsSync(path.join(root, "interrupt-seen"))) {
    process.on("SIGTERM", () => { fs.writeFileSync(path.join(root, "cleanup-killed"), ""); process.exit(143); });
    pause(`rm-${resource.kind}`, remove);
  } else remove();
} else if (args[0] === "container" && args[1] === "inspect") {
  if (state.containers[args.at(-1)]) out([{}]); else { process.stderr.write("No such container"); process.exitCode = 1; }
} else if (args[0] === "container" && args[1] === "ls") {
  out(Object.keys(state.containers).join("\n"));
} else if (args[0] === "compose" && args.includes("up")) {
  state.containers[`${project}-postgres`] = { kind: "compose", project };
  state.volumes[`${project}_postgres-data`] = true; save();
} else if (args[0] === "compose" && args.includes("down")) {
  for (const [name, value] of Object.entries(state.containers)) if (value.project === project) delete state.containers[name];
  for (const volume of Object.keys(state.volumes)) if (volume.startsWith(project) && !Object.values(state.containers).some((c) => c.volume === volume)) delete state.volumes[volume];
  save();
} else if (args[0] === "ps") {
  const label = args.find((arg) => arg.startsWith("label=com.docker.compose.project="));
  out(Object.keys(state.containers).filter((name) => state.containers[name].project === label?.split("=").at(-1)).join("\n"));
} else if (args[0] === "inspect") out([{ State: { Health: { Status: "healthy" } } }]);
else if (args[0] === "exec") out(args.at(-1).includes("server_version_num") ? "180006\n" : "f\n");
else if (args[0] === "volume") {
  const name = args.at(-1);
  if (args[1] === "create") { state.volumes[name] = true; save(); }
  else if (args[1] === "inspect") { if (state.volumes[name]) out([{}]); else process.exitCode = 1; }
  else if (args[1] === "rm") {
    if (Object.values(state.containers).some((c) => c.volume === name)) process.exitCode = 1;
    else { delete state.volumes[name]; save(); }
  }
} else if (args[0] === "network" && args[1] === "inspect") process.exitCode = 1;
else throw new Error(`Unexpected synthetic engine command: ${JSON.stringify(args)}`);
