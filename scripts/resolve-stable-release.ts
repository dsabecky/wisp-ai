import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nightlyVersion, stableVersion } from '@wisp/releases';
import { publishedNightly } from './release-notes.ts';
import { newerStable } from './release-version.ts';

// A stable release promotes a Nightly that was already published from main, so it
// ships the exact source players on the Nightly channel ran (no newer main commits).
export function stableFromNightly(tag: string) {
  const version = tag.slice(1);
  if (!tag.startsWith('v') || !nightlyVersion.test(version)) {
    throw Error(`Not a Nightly tag: ${tag}`);
  }
  return version.replace(/-nightly\.\d+\.\d+$/, '');
}
export function latestStable(tags: readonly string[]) {
  return tags
    .filter((tag) => tag.startsWith('v') && stableVersion.test(tag.slice(1)))
    .reduce<string | undefined>(
      (latest, tag) => (!latest || newerStable(tag.slice(1), latest.slice(1)) ? tag : latest),
      undefined,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (process.env.GITHUB_REF !== 'refs/heads/main') {
    throw Error('Run the stable release from main.');
  }
  const main = git('rev-parse', 'HEAD');
  const requested = process.env.NIGHTLY_TAG?.trim();
  const nightly = await publishedNightly(
    main,
    process.cwd(),
    requested ? (candidate) => `v${candidate}` === requested : undefined,
  );
  if (!nightly) {
    throw Error(
      requested
        ? `${requested} is not a published Nightly built from main.`
        : 'No published Nightly from main to promote.',
    );
  }
  const sha = git('rev-list', '-n', '1', nightly);
  const version = process.env.RELEASE_VERSION?.trim() || stableFromNightly(nightly);
  if (!stableVersion.test(version)) {
    throw Error(`Stable versions are X.Y.Z, not ${version}.`);
  }
  const latest = latestStable(git('tag', '--list', 'v*').split('\n'));
  if (latest && !newerStable(version, latest.slice(1))) {
    throw Error(`v${version} must be newer than ${latest}.`);
  }
  const response = await fetch(
    `https://api.github.com/repos/fedeya/wisp-ai/releases?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    throw Error(`Cannot list releases: GitHub ${response.status}.`);
  }
  const existing = ((await response.json()) as { tag_name: string; draft: boolean }[]).find(
    (release) => release.tag_name === `v${version}`,
  );
  if (existing) {
    throw Error(
      existing.draft
        ? `Delete the existing v${version} draft before promoting again.`
        : `v${version} is already released.`,
    );
  }
  console.log(`Promoting ${nightly} (${sha}) as v${version}.`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `sha=${sha}\nversion=${version}\nnightly=${nightly}\n`,
    );
  }
}
