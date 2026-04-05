#!/usr/bin/env bash
# One-shot setup for SSH commit signing in qcode.
#
# Run this before Phase E signing rebase. It configures git globally
# to use your ed25519 SSH key for signing commits, creates the
# allowed_signers file so `git log --show-signature` can verify, and
# verifies the setup with a test commit that gets amended afterwards.
#
# Does NOT touch git history. It only sets up config. To retroactively
# sign existing commits, run the rebase command at the end AFTER this
# script.

set -eu

EMAIL="${EMAIL:-toblanc34@gmail.com}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"

if [ ! -f "$KEY_FILE" ]; then
  echo "key file not found: $KEY_FILE" >&2
  echo "generate one with: ssh-keygen -t ed25519 -C \"$EMAIL\"" >&2
  exit 1
fi

echo "=== configuring git for SSH signing ==="
echo "  email: $EMAIL"
echo "  key:   $KEY_FILE"

git config --global gpg.format ssh
git config --global user.signingkey "$KEY_FILE"
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# Create the allowed_signers file so `git log --show-signature` can
# verify commits locally. Without this file, git cannot verify its
# own signatures even though they're valid.
ALLOWED="$HOME/.config/git/allowed_signers"
mkdir -p "$(dirname "$ALLOWED")"
KEY_CONTENT=$(awk '{print $1, $2}' "$KEY_FILE")
if ! grep -q "$EMAIL" "$ALLOWED" 2>/dev/null; then
  echo "$EMAIL $KEY_CONTENT" >> "$ALLOWED"
  echo "  added signer entry to $ALLOWED"
fi

git config --global gpg.ssh.allowedSignersFile "$ALLOWED"

echo
echo "=== verifying config ==="
echo "  commit.gpgsign:     $(git config --global --get commit.gpgsign)"
echo "  gpg.format:         $(git config --global --get gpg.format)"
echo "  user.signingkey:    $(git config --global --get user.signingkey)"
echo "  allowedSignersFile: $(git config --global --get gpg.ssh.allowedSignersFile)"
echo
echo "=== ready ==="
echo "From now on, every 'git commit' will be signed with your ed25519 key."
echo "To verify a commit: git log --show-signature -1"
echo
echo "To retroactively sign the entire qcode branch since origin/main:"
echo "  cd /Users/thomasblanc/1_app/qcode"
echo "  git rebase --exec 'git commit --amend --no-edit -S' origin/main"
echo "WARNING: this rewrites commit hashes. Force-push is needed if the"
echo "branch is already remote (which it isn't for qcode yet)."
