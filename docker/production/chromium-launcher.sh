#!/bin/sh
set -eu
# The existing application may run as root to read legacy root-owned env-file
# mounts. Chromium always runs under its own unprivileged identity, with no
# application secrets in its environment and with its browser sandbox enabled.
if [ "$(id -u)" = 0 ]; then
  for argument in "$@"; do
    case "$argument" in
      --user-data-dir=/tmp/puppeteer_dev_chrome_profile-*)
        profile=${argument#--user-data-dir=}
        [ -d "$profile" ] && [ ! -L "$profile" ]
        chown cc-video:cc-video "$profile"
        ;;
    esac
  done
  exec setpriv --reuid=cc-video --regid=cc-video --clear-groups --no-new-privs \
    env -i PATH=/usr/bin:/bin HOME=/home/cc-video /usr/bin/chromium "$@"
fi
exec /usr/bin/chromium "$@"
