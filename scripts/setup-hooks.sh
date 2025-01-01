#!/usr/bin/env sh

# Ensure scripts directory exists and file is executable
mkdir -p .git/hooks
chmod +x pre-commit
cp pre-commit .git/hooks/
echo "Git pre-commit hook installed successfully"
