# Design

This folder is the project's perceptual memory: the place where what FleetCo should look and feel like is held across sessions, so that the visual identity does not drift toward whatever defaults the most recent agent session happened to have.

The structure of this folder follows the discipline established in ADR-0007 and ADR-0008. The file `DESIGN.md` is the canonical design system: tokens, typography, spacing, component patterns, voice and tone, and anti-patterns. The Tailwind theme configuration in `apps/web/` derives from `DESIGN.md`; drift between them is the failure mode and must be prevented. The folder `slices/` holds locked HTML mockups for specific surfaces, committed when the visual design for that slice is approved as ready to implement. The folder `slices/_archive/` holds historical mockups whose implementing code has merged.

External design tools (Open Design with its MCP server, Figma, hand-coded HTML, anywhere) are iteration surfaces. They are useful for rapid iteration, but the conclusions that emerge from iteration must commit to this folder to count as memory. A design that lives only on the designer's laptop is not memory, because it does not survive across machines, sessions, or tool changes.

At project start, this folder contains only this README. The `DESIGN.md` itself is a Phase 0 deliverable to be authored before the first UI slice in Phase 1. The base design system FleetCo customizes from is `shadcn-ui`, recorded in ADR-0016; the Linear and Notion alternatives discussed in ADR-0007 are documented as rejected in ADR-0016's `Alternatives considered` section.

The `slices/` folder is empty at project start because no UI slices exist yet. The first entry will appear when the first Phase 1 UI slice (likely Vehicles or Drivers) is being built.

The `slices/_archive/` folder is empty because no slices have completed yet. Entries will accumulate as Phase 1 progresses, providing a historical visual record of what each surface used to look like at the moment its implementing code merged.
