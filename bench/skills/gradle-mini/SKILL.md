---
name: gradle-mini
description: Count Gradle modules from settings.gradle.kts in the current repository and write a summary file in .pi/output/gradle-summary.txt. Use when asked to inspect a small Gradle project and report its module count.
allowed-tools: bash read write
---

# Gradle Mini

Use this skill for small Gradle repositories when the user wants a quick module count.

## Workflow

1. Run this exact bash command in the repository root:

```bash
mkdir -p .pi/output
test -f settings.gradle.kts || { echo "not_gradle"; exit 1; }
COUNT=$(grep -o '":' settings.gradle.kts | wc -l | tr -d ' ')
printf "module_count: %s\n" "$COUNT"
```

2. Use `write` with an absolute path to create `.pi/output/gradle-summary.txt` with the exact content from the command output.

3. Use `read` with an absolute path on `.pi/output/gradle-summary.txt` to confirm the file content.

4. Reply with the module count only.
