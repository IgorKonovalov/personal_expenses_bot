#!/bin/sh
# Deploys the checkout on the VPS. Installed as ~/bin/deploy-personal-expenses-bot and bound to the
# GitHub Actions key by `restrict,command="..."` in ~/.ssh/authorized_keys, so that key runs this
# and nothing else: sshd puts the client's requested command in $SSH_ORIGINAL_COMMAND, which this
# script never reads. The installed file is a copy; after editing this one, reinstall it by hand.
set -eu

cd "$HOME/bots/personal-expenses-bot"
# --ff-only: a checkout edited on the VPS fails the deploy instead of merging.
git pull --ff-only
# --wait fails the deploy when the container never turns healthy.
docker compose up -d --build --wait --wait-timeout 180
docker image prune -f
# The on-host build leaves cache behind every deploy; keep a week of it for fast rebuilds.
docker builder prune -f --filter until=168h
