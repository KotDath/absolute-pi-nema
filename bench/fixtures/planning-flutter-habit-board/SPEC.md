# Flutter Habit Board

Build a planning-driven scaffold for an offline-first Flutter application called `Habit Board`.

Required deliverables:

1. `pubspec.yaml`
   - include `flutter_riverpod`
   - include `go_router`
   - include `drift`
   - include `sqlite3_flutter_libs`
2. `lib/app/app.dart`
   - define `class HabitBoardApp extends StatelessWidget`
   - use `MaterialApp.router`
3. `lib/features/habits/presentation/habit_dashboard_page.dart`
   - define `class HabitDashboardPage extends ConsumerWidget`
   - mention "Today", "Streak", and "Backlog"
4. `docs/architecture.md`
   - include sections:
     - `## Offline-first data flow`
     - `## Folder layout`
     - `## Testing strategy`
5. `README.md`
   - include a short rollout checklist
   - mention phases for scaffold, data layer, and tests

Constraints:

- Do not use `flutter create`.
- Do not generate platform folders.
- Stay inside this workspace.
- Produce substantive content, not placeholders.
