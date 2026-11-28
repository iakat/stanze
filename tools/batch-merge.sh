#!/bin/sh
# Merge a batch branch and report what it touches, without committing.
#
#   tools/batch-merge.sh w07 [w08 ...]
#
# One branch at a time, on a clean main checkout. Every branch was cut from the
# same commit and every agent stayed in its own functions, so a conflict here is
# a real overlap and not an accident of layout: the script stops and names the
# files rather than leaving a half-merged tree.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

if [ -n "$(git status --porcelain)" ]; then
  echo "the tree is not clean; commit or stash first" >&2
  exit 1
fi

for name in "$@"; do
  branch="batch/$name"
  if ! git rev-parse --verify "$branch" >/dev/null 2>&1; then
    echo "== $name: no branch $branch, skipped"
    continue
  fi
  count=$(git rev-list --count "origin/main..$branch")
  if [ "$count" = "0" ]; then
    echo "== $name: nothing to merge"
    continue
  fi
  echo "== $name: $count commit(s)"
  git log --oneline "origin/main..$branch" | sed 's/^/   /'
  if git merge --no-commit --no-ff "$branch" >/tmp/batch-merge.log 2>&1; then
    files=$(git diff --cached --name-only | tr '\n' ' ')
    echo "   clean; staged: $files"
    git commit -q -m "merge $branch" --no-verify
    echo "   merged"
  else
    echo "   CONFLICT in:"
    git diff --name-only --diff-filter=U | sed 's/^/     /'
    echo "   the tree holds the conflict; resolve it or run git merge --abort" >&2
    exit 1
  fi
done
