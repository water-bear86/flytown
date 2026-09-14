import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "vercel-dist");
const siteDirectory = join(outputDirectory, "site");

const { researchSiteHtml } = await import(join(projectRoot, "dist", "flytown", "site.js"));

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(siteDirectory, { recursive: true });
await cp(join(projectRoot, "assets", "site"), siteDirectory, { recursive: true });
await cp(join(projectRoot, "tokens.css"), join(siteDirectory, "tokens.css"));
await writeFile(
  join(outputDirectory, "index.html"),
  researchSiteHtml({
    consoleHref: "https://github.com/water-bear86/flytown/blob/master/docs/install/from-source.md",
    consoleLabel: "Run locally",
    consoleCtaLabel: "Run FLYTOWN locally",
  }),
  "utf8",
);

process.stdout.write(`Built static public site at ${outputDirectory}\n`);
