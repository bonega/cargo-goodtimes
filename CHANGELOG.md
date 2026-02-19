# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-02-19

### Changed

- Crate IDs in the output HTML now use `name@version` instead of full file paths, avoiding privacy leaks when sharing.
- Crates that become unreachable through edge removal are hidden from the chart.
- Consistent time unit (ms or s) across all timeline ticks.
- Reduced crate package size by excluding frontend source files and dev artifacts.
- Embed only JS/CSS assets instead of the full `frontend/dist` directory.

### Fixed

- Bottom status bar no longer overlaps clickable chart rows.

## [0.2.1] - 2026-02-19

### Added

- Keyboard navigation (arrow keys + Enter) in the add-dependency autocomplete.

### Fixed

- Prevent adding dependencies that would create cycles in the dependency graph.
- Fix infinite loop when the what-if graph contained cycles.
- Improved visibility of the autocomplete highlight.

## [0.2.0] - 2026-02-18

### Added

- `--include-deps` flag to include third-party dependencies in the Gantt chart.
- Pre-build step that compiles third-party dependencies before the timed build, eliminating "holes" in the Gantt chart.

### Changed

- Workspace crates are now cleaned in a single `cargo clean` invocation instead of one per package.

## [0.1.0] - 2025-05-25

### Added

- Initial release.
- Gantt chart visualization of crate compilation timelines.
- Critical path highlighting.
- What-if analysis for exploring hypothetical build graphs.
