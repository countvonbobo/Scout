# CV Evidence and Quality

When creating a tailored CV, Scout recommends Google XYZ for achievement bullets and a separate natural-voice review. Both are per-CV options and may be disabled before opening the job chat.

## Evidence interview

With XYZ enabled, the provider first compares the advert with `cv/master-cv.md`. It asks only for a missing accomplishment (X), confirmed quantitative or qualitative outcome (Y), or method (Z), one question per turn. Each question explains the prospective bullet and offers `Skip` and `Finish questions`. Missing metrics are never guessed.

Tailored material is keyed by the tracked opportunity, not the company, so two roles at the same employer each get their own folder and never collide. A folder created before this change (named only from the company) is left exactly where it is: Scout reuses it in place after an explicit prompt naming whose CV it is, and only creates a new per-opportunity folder if you decline.

## Private evidence record

`applications/<slug>/cv-evidence.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "opportunityId": "example-engineer-2026-07",
  "options": { "xyz": true, "humanize": true },
  "questions": [
    {
      "id": "q1",
      "question": "What changed as a result?",
      "answer": "Reduced build time by 30%.",
      "status": "answered"
    }
  ],
  "bullets": [
    {
      "text": "Reduced build time by 30% by introducing a reusable test fixture.",
      "kind": "achievement",
      "evidence": [{ "source": "question", "reference": "q1" }],
      "xyz": { "x": "Reduced build time", "y": "30%", "z": "Introduced a reusable test fixture" }
    }
  ],
  "voiceReview": { "completed": true, "summary": "Removed generic wording.", "changes": [] }
}
```

Every visible Typst bullet must have an exact record and at least one evidence source. Job adverts guide relevance but are not evidence of candidate experience.

## Quality and downloads

The CV library can render both `cv/master-cv.md` and tailored `applications/<slug>/cv.typ` files. The master output is explicitly labelled a **reference PDF**: it is useful for reviewing approved evidence but is not presented as an application-ready tailored CV. Scout converts its supported Markdown structure to temporary Typst while omitting evidence comments; the approved Markdown source is not rewritten.

Rendering runs as a background operation with visible progress and a 60-second limit. Scout compiles to a temporary file, validates the PDF, then atomically replaces the prior output. `.scout/cv-renders.json` binds each output to its source hash. Editing the source immediately marks the previous PDF stale and disables preview/download until a new render succeeds. A failed render preserves the previous file but never labels it current.

Run `scout cv quality <application-slug>` to compile the PDF and write `cv-quality.json`. The report contains the CV source hash, enabled options, issues and any explicit draft override. Editing the source invalidates both the report and override.

Scout packages and supported VPS deployments include a pinned, checksum-verified Typst runtime. `scout doctor` reports whether rendering uses that managed runtime, a packaged runtime or an explicit developer override. If the managed runtime is missing or damaged, repair or reinstall Scout; no separate `winget`, Homebrew or system package is required.

Compilation failures, visible placeholders and unsupported bullets block tailored download. Natural-voice and XYZ findings keep a tailored CV labelled Draft but can be explicitly accepted. Existing CVs without these records are treated as legacy drafts and are not modified automatically. The same-origin preview endpoint permits Scout's own PDF frame while retaining no-store, nosniff and third-party framing protection.

Natural-voice review improves authenticity and readability. It is not designed to evade AI-detection systems.
