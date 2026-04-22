from pathlib import Path

root = Path.cwd()
settings = root / "settings.gradle.kts"
text = settings.read_text(encoding="utf-8")
count = text.count('":')
output = root / ".pi" / "output" / "python-summary.txt"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(f"module_count: {count}\n", encoding="utf-8")
print(f"module_count: {count}")
