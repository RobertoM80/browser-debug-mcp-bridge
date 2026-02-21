#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

function run(command) {
  return execSync(command, { encoding: 'utf8' }).trim();
}

function safeRun(command) {
  try {
    return run(command);
  } catch {
    return '';
  }
}

function parseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatVersion(version) {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

function nextPatch(version) {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1
  };
}

function getLatestSemverTag() {
  const localTags = safeRun('git tag --list "v*"')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);

  const remoteTags = safeRun('git ls-remote --tags --refs origin "v*"')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] || '')
    .map((ref) => ref.replace(/^refs\/tags\//, ''))
    .filter(Boolean);

  const allVersions = [...new Set([...localTags, ...remoteTags])]
    .map((tag) => ({ tag, version: parseVersion(tag) }))
    .filter((entry) => entry.version !== null)
    .sort((a, b) => compareVersions(b.version, a.version));

  return allVersions[0]?.tag || '';
}

function getPackageVersionTag() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!packageJson.version) return '';
  return `v${packageJson.version}`;
}

function pickSuggestedTag() {
  const latestTag = getLatestSemverTag();
  const latestVersion = latestTag ? parseVersion(latestTag) : null;
  const packageTag = getPackageVersionTag();
  const packageVersion = packageTag ? parseVersion(packageTag) : null;

  if (!latestVersion && !packageVersion) return 'v0.1.0';
  if (!latestVersion) return packageTag;
  if (!packageVersion) return formatVersion(nextPatch(latestVersion));

  if (compareVersions(packageVersion, latestVersion) > 0) {
    return packageTag;
  }
  return formatVersion(nextPatch(latestVersion));
}

function validateTag(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

function parseArgValue(args, name) {
  const prefix = `${name}=`;
  const byPrefix = args.find((arg) => arg.startsWith(prefix));
  if (byPrefix) return byPrefix.slice(prefix.length);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return '';
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  const requestedTag = parseArgValue(args, '--tag');
  const suggestedTag = pickSuggestedTag();
  let selectedTag = requestedTag || suggestedTag;

  if (!validateTag(selectedTag)) {
    console.error(`Invalid tag "${selectedTag}". Expected format: vMAJOR.MINOR.PATCH`);
    process.exit(1);
  }

  const existing = safeRun(`git tag --list "${selectedTag}"`);
  const existingRemoteRef = safeRun(`git ls-remote --tags --refs origin "refs/tags/${selectedTag}"`);
  if (existing || existingRemoteRef) {
    console.error(`Tag ${selectedTag} already exists (local or remote).`);
    process.exit(1);
  }

  const status = safeRun('git status --porcelain');
  if (status && !dryRun) {
    console.error('Working tree is not clean. Commit or stash changes before tagging.');
    process.exit(1);
  }

  console.log(`Suggested tag: ${suggestedTag}`);
  console.log(`Selected tag: ${selectedTag}`);

  if (!yes && !requestedTag) {
    const rl = createInterface({ input, output });
    const answer = (await rl.question(`Use tag "${selectedTag}"? Press Enter to confirm or type another tag: `)).trim();
    rl.close();

    if (answer) selectedTag = answer;
    if (!validateTag(selectedTag)) {
      console.error(`Invalid tag "${selectedTag}". Expected format: vMAJOR.MINOR.PATCH`);
      process.exit(1);
    }
  }

  const existsAfterPrompt = safeRun(`git tag --list "${selectedTag}"`);
  const existsAfterPromptRemote = safeRun(`git ls-remote --tags --refs origin "refs/tags/${selectedTag}"`);
  if (existsAfterPrompt || existsAfterPromptRemote) {
    console.error(`Tag ${selectedTag} already exists (local or remote).`);
    process.exit(1);
  }

  if (!yes && !dryRun) {
    const rl = createInterface({ input, output });
    const confirm = (await rl.question(`Run: checkout main, pull, tag ${selectedTag}, push tag? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (confirm !== 'y' && confirm !== 'yes') {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  if (dryRun) {
    console.log('Dry run commands:');
    console.log('git checkout main');
    console.log('git pull --ff-only origin main');
    console.log(`git tag ${selectedTag}`);
    console.log(`git push origin ${selectedTag}`);
    process.exit(0);
  }

  run('git checkout main');
  run('git pull --ff-only origin main');
  run(`git tag ${selectedTag}`);
  run(`git push origin ${selectedTag}`);

  console.log(`Done. Pushed tag ${selectedTag}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
