import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let lastCheck = null;
let installing = false;

async function run(command, args, timeout = 120_000) {
  const result = await executeFile(command, args, { cwd: projectRoot, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return String(result.stdout ?? "").trim();
}

async function currentVersion() {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}

function githubRepository(remoteUrl) {
  const match = String(remoteUrl).match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function versionParts(version) {
  const match = String(version).trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i);
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error("Die Release-Version entspricht nicht dem Format Hauptversion.Nebenversion.Korrekturversion.");
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function versionFromTag(tagName) {
  const normalized = String(tagName).trim().replace(/^v/i, "");
  if (!versionParts(normalized)) throw new Error(`Das GitHub-Release „${tagName}“ enthält keine gültige Versionsnummer.`);
  return normalized;
}

export async function fetchLatestRelease(repository, { githubToken = "", fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Die GitHub-Release-Prüfung wird von dieser Laufzeit nicht unterstützt.");
  const [owner, name] = String(repository).split("/");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "Tixaro-Update-Center", "X-GitHub-Api-Version": "2022-11-28" };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`, { headers });
  if (!response.ok) {
    if (response.status === 404) throw new Error("Für dieses Repository wurde noch kein Release gefunden. Bei privaten Repositorys wird TIXARO_GITHUB_TOKEN benötigt.");
    throw new Error(`GitHub konnte nicht abgefragt werden (HTTP ${response.status}).`);
  }
  const release = await response.json();
  const tagName = String(release.tag_name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(tagName) || tagName.startsWith("-")) throw new Error("Das neueste GitHub-Release besitzt kein gültiges Tag.");
  return {
    tagName,
    version: versionFromTag(tagName),
    name: String(release.name ?? tagName).trim().slice(0, 180) || tagName,
    notes: String(release.body ?? "").trim().slice(0, 10_000),
    htmlUrl: String(release.html_url ?? ""),
    publishedAt: release.published_at ? new Date(release.published_at) : null
  };
}

async function localOverview(config) {
  const version = await currentVersion();
  if (!/^[a-z0-9._-]+$/i.test(config.updateRemote)) {
    return { enabled: false, version, reason: "Die konfigurierte GitHub-Updatequelle ist ungültig." };
  }
  try {
    const [remoteUrl, branch, commit] = await Promise.all([
      run("git", ["remote", "get-url", config.updateRemote]),
      run("git", ["branch", "--show-current"]),
      run("git", ["rev-parse", "--short", "HEAD"])
    ]);
    const repository = githubRepository(remoteUrl);
    if (!repository) return { enabled: false, version, reason: "Das konfigurierte Remote ist kein GitHub-Repository." };
    return { enabled: true, version, repository, branch, commit, lastCheck };
  } catch {
    return { enabled: false, version, reason: "Diese Installation ist nicht mit einem GitHub-Repository verbunden." };
  }
}

export async function updateOverview(config) {
  return localOverview(config);
}

export async function checkForUpdate(config, { fetchImpl = globalThis.fetch } = {}) {
  const overview = await localOverview(config);
  if (!overview.enabled) throw new Error(overview.reason);
  const [release, status] = await Promise.all([
    fetchLatestRelease(overview.repository, { githubToken: config.githubToken, fetchImpl }),
    run("git", ["status", "--porcelain"])
  ]);
  lastCheck = {
    checkedAt: new Date(),
    available: compareVersions(release.version, overview.version) > 0,
    clean: status.length === 0,
    ...release
  };
  return { ...overview, lastCheck };
}

async function installDependencies(config) {
  const args = ["install", ...(config.isProduction ? ["--omit=dev"] : [])];
  if (process.platform === "win32") {
    await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], 10 * 60_000);
  } else {
    await run("npm", args, 10 * 60_000);
  }
}

export async function installUpdate(config) {
  if (installing) throw new Error("Ein Update wird bereits installiert.");
  installing = true;
  try {
    const state = await checkForUpdate(config);
    if (!state.lastCheck.clean) throw new Error("Die Installation enthält lokale Änderungen. Das Update wurde zum Schutz dieser Änderungen abgebrochen.");
    if (!state.lastCheck.available) throw new Error("Es ist kein neueres Release verfügbar.");
    await run("git", ["fetch", "--quiet", "--tags", "--prune", config.updateRemote], 180_000);
    const tagRef = `refs/tags/${state.lastCheck.tagName}^{commit}`;
    try {
      await run("git", ["merge-base", "--is-ancestor", "HEAD", tagRef]);
    } catch {
      throw new Error("Das Release kann nicht als sicheres Fast-Forward-Update installiert werden.");
    }
    const packageSource = await run("git", ["show", `${tagRef}:package.json`]);
    const taggedVersion = String(JSON.parse(packageSource).version ?? "");
    if (compareVersions(taggedVersion, state.lastCheck.version) !== 0) throw new Error("Versionsnummer und Release-Tag stimmen nicht überein.");
    await run("git", ["merge", "--ff-only", tagRef], 180_000);
    await installDependencies(config);
    const installed = await localOverview(config);
    lastCheck = { ...state.lastCheck, available: false, installedAt: new Date(), version: installed.version };
    return { ...installed, lastCheck };
  } finally {
    installing = false;
  }
}
