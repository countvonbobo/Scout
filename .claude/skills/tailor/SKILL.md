---
name: tailor
description: Generate an evidence-led tailored CV and outreach draft for one tracked Scout opportunity.
---

# Tailor an application

1. Read the master CV, profile, workspace settings, and tracker entry. Stop for material gaps rather than inventing facts.
2. Verify the current advert and public company context.
3. Honour the CV options in the request. If Google XYZ is enabled, map genuine achievements to X (accomplishment), Y (confirmed quantitative or qualitative outcome), and Z (method). Ask only for missing evidence, one focused question per turn; explain the intended bullet and offer `Skip` and `Finish questions`. Never suggest or invent a metric. Do not draft until the user finishes or skips the questions.
4. Write `applications/<company-slug>/cv.typ` using `/cv/template.typ`; reorder only supported evidence around the target's needs and mark unresolved gaps as Typst comments. Keep responsibility and skills bullets natural instead of forcing XYZ.
5. Write `applications/<company-slug>/cv-evidence.json` with schema version 1, the opportunity ID, the selected `xyz` and `humanize` booleans, answered/skipped questions, and one record for every exact CV bullet. Each bullet record has `text`, `kind` (`achievement` or `responsibility`), non-empty `evidence` entries with `source` and `reference`, and either an `{x,y,z}` object or `null`.
6. If natural-voice review is enabled, complete a separate second pass after the factual draft. Preserve every fact while removing generic CV clichés, repeated openings, keyword stuffing, unnatural formality and locale mismatches. Record `{ "completed": true, "summary": "...", "changes": [] }` as `voiceReview` in the evidence file. If disabled, record `{ "completed": false, "summary": "Not selected", "changes": [] }`.
7. Render with Typst. Scout runs quality checks after the writing turn; in an application source checkout they can also be run manually with `node tools/scout.mjs cv quality <company-slug>`. The PDF should be approximately two pages unless the profile says otherwise. Do not claim the CV is ready without a passing quality report.
8. Draft `outreach.md` in the user's locale and tone. Include relevant questions from their priorities.
9. Add only publicly listed contacts, set the appropriate draft/outreach state (e.g., from `new` or `shortlist`), and add a dated note. Do not record an outreach-sent event until the user confirms sending.
10. Summarise the angle, skipped questions, evidence gaps, quality result and review points. Never send anything.
