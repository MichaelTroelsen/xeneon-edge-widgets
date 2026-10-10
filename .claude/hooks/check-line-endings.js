#!/usr/bin/env node
/* Fail loudly when an edit leaves CRLF in a tracked text file.
 *
 * This repo is LF everywhere, in the index and (since .gitattributes) in the
 * working tree. The failure this guards against is not a style preference: both
 * layout suites mutate their own source and match MULTI-LINE STRING LITERALS
 * against it, so a file that silently changes newline convention makes a needle
 * stop matching. The suite then reports "the source mutation matched nothing"
 * instead of failing the assertion the reader was actually testing - a green-ish
 * run that has quietly stopped checking the thing it names.
 *
 * It has happened three times in two days, in both directions: a text-mode write
 * converting LF to CRLF, and a `git stash` round-trip converting it back under
 * core.autocrlf=true. Each time it was first misdiagnosed as someone else's bug.
 *
 * Exits 2 with a message on stderr, which Claude Code feeds back to the model.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let file;
  try {
    file = JSON.parse(raw).tool_input.file_path;
  } catch (e) {
    process.exit(0);           /* not a shape we understand - never block on that */
  }
  if (!file) process.exit(0);

  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    process.exit(0);           /* deleted, moved, or never written */
  }

  /* A NUL byte means binary, where CRLF is content rather than a line ending. */
  if (buf.includes(0)) process.exit(0);

  const crlf = countCRLF(buf);
  if (crlf === 0) process.exit(0);

  /* Only speak for files git is actually tracking in THIS repo. An edit to a
     scratchpad file, or to something outside the tree, is none of our business
     - and a false alarm on those would train the reader to ignore real ones. */
  let rel;
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(path.resolve(file)), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']   /* a file outside any repo is normal, not an error to print */
    }).trim();
    rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel],
      { cwd: root, stdio: 'ignore' });
  } catch (e) {
    process.exit(0);           /* untracked, or not a git repo */
  }

  const lf = countLF(buf) - crlf;
  process.stderr.write(
    'LINE ENDINGS: ' + rel + ' now contains ' + crlf + ' CRLF line ending(s)' +
    (lf ? ' and ' + lf + ' bare LF - it is MIXED' : '') + '.\n' +
    'This repo is LF-only (see .gitattributes). A CRLF file breaks the layout\n' +
    'suites’ source-mutation needles, which then report "matched nothing"\n' +
    'rather than failing - so the check silently stops testing what it names.\n' +
    'Rewrite the file as BYTES preserving LF. Do not use a text-mode write, and\n' +
    'do not restore it with `git checkout --` or `git stash pop` without\n' +
    're-checking: core.autocrlf is true here and both reintroduce CRLF.\n'
  );
  process.exit(2);
});

function countCRLF(buf) {
  let n = 0;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i - 1] === 0x0d) n++;
  }
  return n;
}

function countLF(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}
