#!/bin/sh
# Build and test the tree, then commit it when both pass.
#
#   tools/green_commit.sh "message"
#
# No commit happens when the build fails, when a check fails, or when the
# tree has nothing to commit. The server for the self test runs on a loopback
# port of its own and is killed on exit.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

msg=${1:-"call: green build"}

./build.sh >/tmp/green_build.log 2>&1 || {
	echo "BUILD FAILED, no commit"; tail -20 /tmp/green_build.log; exit 1
}

port=18095
TURN_SECRET=dev-secret TURN_PUBLIC_IP=127.0.0.1 \
	./bin/rooms -listen "127.0.0.1:$port" -create-per-min 600 \
	>/tmp/green_rooms.log 2>&1 &
rooms_pid=$!
trap 'kill "$rooms_pid" 2>/dev/null || true' EXIT INT TERM
sleep 2

if ! ./bin/selftest -addr "http://127.0.0.1:$port" >/tmp/green_selftest.log 2>&1; then
	echo "SELFTEST FAILED, no commit"; tail -25 /tmp/green_selftest.log; exit 1
fi
tail -2 /tmp/green_selftest.log

if [ -z "$(git status --porcelain)" ]; then
	echo "tree clean, nothing to commit"; exit 0
fi

git add -A
git commit -q -m "$msg"
git log --oneline -1

# Push every green commit when a remote is set.
if git remote get-url origin >/dev/null 2>&1; then
	GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /data/ocbot-ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}" \
		git push -q origin HEAD 2>&1 || { echo "commit is local, push failed"; exit 1; }
	echo "pushed to $(git remote get-url origin)"
fi
