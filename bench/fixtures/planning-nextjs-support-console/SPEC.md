# Support Operations Console

Create a planning-driven scaffold for a Next.js support operations console.

Required deliverables:

1. `package.json`
   - include dependencies `next`, `react`, `zod`, `@tanstack/react-query`
2. `app/layout.tsx`
   - export metadata
   - render a root layout
3. `app/page.tsx`
   - include the heading `Support Operations Console`
   - mention queue metrics and escalation
4. `lib/incidents.ts`
   - export `incidentSchema`
   - export at least one typed helper
5. `docs/architecture.md`
   - include sections:
     - `## Route structure`
     - `## Data contracts`
     - `## Implementation phases`

Constraints:

- Do not run `create-next-app`.
- Keep the scaffold focused on architecture and concrete starter code.
