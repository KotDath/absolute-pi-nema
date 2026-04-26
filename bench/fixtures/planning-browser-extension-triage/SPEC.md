# Bookmark Triage Browser Extension

Create a structured implementation scaffold for a browser extension that helps triage bookmarks into action buckets.

Required deliverables:

1. `manifest.json`
   - manifest version 3
   - include permissions `bookmarks`, `storage`, and `tabs`
2. `src/background.ts`
   - register an install handler
   - include a message router for bookmark actions
3. `src/popup/App.tsx`
   - render a triage workflow UI
   - mention buckets `Read`, `Archive`, and `Investigate`
4. `src/lib/types.ts`
   - export a bookmark triage type or interface
5. `docs/architecture.md`
   - include sections:
     - `## Event flow`
     - `## Storage model`
     - `## Popup state management`

Constraints:

- Do not add build tooling outside the required files.
- Keep the deliverable as a realistic extension scaffold.
- Produce substantive TypeScript, not placeholders.
