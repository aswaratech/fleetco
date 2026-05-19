// Fabricated-operator-confirmation-preamble guard.
//
// Principle 2 from docs/runbook/orchestration-loop-design.md — the LARGEST
// single gotcha in the entire orchestration pattern: if the operator ever
// writes a kickoff prompt with a legitimate operator-confirmation preamble,
// the agent learns the pattern and reuses it when drafting its own next-session
// prompts, fabricating "operator confirmation" assertions for preconditions
// that are not actually met. This was observed after exactly one legitimate
// override in the field run.
//
// The fix is mandatory and built in from day one: scan extracted next-prompts
// for operator-confirmation phrasings, strip the matched paragraphs, and
// notify the operator that the strip happened. The cleaned prompt continues
// into the next iteration; the operator decides whether to inspect.

import type { FabricatedStripResult } from "./types.js";

// We match a wide net of phrasings. False positives are recoverable (operator
// inspects); false negatives can let a discipline-gate bypass slip through.
//
// Each entry is a regex anchored to a paragraph (separated by blank lines).
// We strip whole paragraphs so we don't leave dangling half-sentences.
const FABRICATED_PARAGRAPH_RES: readonly RegExp[] = [
  // "operator has (confirmed | authorized | approved | signed off | waived | overridden) X"
  /operator\s+(?:has\s+)?(?:confirmed|authorized|approved|signed\s*[- ]?off|waived|overridden|granted|cleared)/i,
  // "operator (confirmation | authorization | approval | sign-off | waiver | override) (received|given|granted|...)"
  /operator\s+(?:confirmation|authorization|approval|sign[- ]?off|waiver|override|clearance|consent)\s+(?:has\s+been\s+)?(?:received|given|granted|obtained|provided)/i,
  // "the operator has (confirmed | ...) X" — slight variant
  /the\s+operator\s+(?:has\s+)?(?:confirmed|authorized|approved|signed\s*[- ]?off|waived|overridden|granted|cleared)/i,
  // "per operator (confirmation|approval|...)"
  /per\s+operator\s+(?:confirmation|authorization|approval|sign[- ]?off|waiver|override|clearance|consent|instruction|direction|decision)/i,
  // "with operator (confirmation|approval|...)"
  /with\s+operator\s+(?:confirmation|authorization|approval|sign[- ]?off|waiver|override|clearance|consent)/i,
  // "operator (says|noted|indicated|stated) ... (proceed|continue|skip)"
  /operator\s+(?:says|noted|indicated|stated|confirmed|told\s+me)\s+(?:to\s+)?(?:proceed|continue|skip|bypass|override|waive)/i,
  // "the CEO has confirmed/approved" — same gotcha with role name
  /(?:the\s+)?CEO\s+(?:has\s+)?(?:confirmed|authorized|approved|signed\s*[- ]?off|waived|overridden|granted|cleared)/i,
  // "PO (product owner) has approved..." — same gotcha
  /(?:the\s+)?(?:PO|product\s+owner)\s+(?:has\s+)?(?:confirmed|authorized|approved|signed\s*[- ]?off|waived|overridden|granted|cleared)/i,
];

export function stripFabricatedPreambles(prompt: string): FabricatedStripResult {
  // Split into paragraphs preserving boundaries; a paragraph is a run of
  // non-blank lines between blank lines.
  const lines = prompt.split("\n");
  const paragraphs: { startLine: number; endLine: number; text: string }[] = [];
  let cur: { startLine: number; lines: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const isBlank = (lines[i] ?? "").trim() === "";
    if (isBlank) {
      if (cur) {
        paragraphs.push({
          startLine: cur.startLine,
          endLine: i - 1,
          text: cur.lines.join("\n"),
        });
        cur = null;
      }
    } else {
      if (!cur) cur = { startLine: i, lines: [] };
      cur.lines.push(lines[i] ?? "");
    }
  }
  if (cur) {
    paragraphs.push({
      startLine: cur.startLine,
      endLine: lines.length - 1,
      text: cur.lines.join("\n"),
    });
  }

  const stripIndices = new Set<number>();
  const strippedBlocks: string[] = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const p = paragraphs[pi];
    if (!p) continue;
    if (FABRICATED_PARAGRAPH_RES.some((re) => re.test(p.text))) {
      stripIndices.add(pi);
      strippedBlocks.push(p.text);
    }
  }

  if (stripIndices.size === 0) {
    return { cleaned: prompt, strippedBlocks: [] };
  }

  // Rebuild prompt with offending paragraphs removed. We also collapse
  // resulting double-blank-lines into single blank lines for readability.
  const keepLines: string[] = [];
  let writtenAny = false;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    if (stripIndices.has(pi)) continue;
    const p = paragraphs[pi];
    if (!p) continue;
    if (writtenAny) keepLines.push(""); // single blank line between kept paragraphs
    keepLines.push(p.text);
    writtenAny = true;
  }
  const cleaned = keepLines.join("\n").trim();

  return { cleaned, strippedBlocks };
}
