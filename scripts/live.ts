// Is the push live? Compares the commit supergeometry.app was built from
// (its /version.json) with main here.
//
//   npx tsx scripts/live.ts           once
//   npx tsx scripts/live.ts --wait    until it is (up to 20 minutes)
//   npx tsx scripts/live.ts --site http://localhost:4173
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const site = (args.includes("--site") ? args[args.indexOf("--site") + 1] : "https://supergeometry.app").replace(/\/$/, "");
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
const want = git("rev-parse origin/main");
const short = (c: string) => c.slice(0, 7);

interface Version {
  version: string;
  commit: string;
  subject: string;
  script: string;
  built: string;
}

async function live(): Promise<Version | null> {
  try {
    const r = await fetch(`${site}/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Version;
  } catch {
    return null;
  }
}

const until = Date.now() + 20 * 60_000;
for (;;) {
  const v = await live();
  if (v?.commit && v.commit === want) {
    console.log(`Live: ${short(v.commit)} ${v.subject} (built ${v.built}, ${v.script})`);
    process.exit(0);
  }
  if (!args.includes("--wait") || Date.now() > until) {
    if (!v) console.log(`${site} has no version.json yet (built before it was added), main is ${short(want)}`);
    else console.log(`Not live yet: the site is ${short(v.commit)} ${v.subject} (built ${v.built}), main is ${short(want)} ${git(`log -1 --format=%s ${want}`)}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 20_000));
}
