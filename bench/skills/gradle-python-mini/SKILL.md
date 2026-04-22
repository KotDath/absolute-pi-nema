---
name: gradle-python-mini
description: Create and run a small Python collector script for the current Gradle repository, then write and verify a module-count summary. Use when asked to inspect a small Gradle project through a generated helper script.
allowed-tools: bash read write
---

# Gradle Python Mini

Use this skill for small Gradle repositories when you need to prove that a skill can create a helper script, execute it, and verify its output.

## Workflow

1. Confirm `python3` is available and prepare output directories:

```bash
command -v python3 >/dev/null
mkdir -p scripts .pi/output
test -f settings.gradle.kts || { echo "not_gradle"; exit 1; }
```

2. Use `write` with an absolute path to create `scripts/collect.py` with this exact content:

```python
from pathlib import Path

root = Path.cwd()
settings = root / "settings.gradle.kts"
text = settings.read_text(encoding="utf-8")
count = text.count('":')
output = root / ".pi" / "output" / "python-summary.txt"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(f"module_count: {count}\n", encoding="utf-8")
print(f"module_count: {count}")
```

3. Run the script from the repository root:

```bash
python3 scripts/collect.py
```

4. Use `read` with an absolute path on `.pi/output/python-summary.txt` to confirm the file content.

5. Reply with the module count only.
